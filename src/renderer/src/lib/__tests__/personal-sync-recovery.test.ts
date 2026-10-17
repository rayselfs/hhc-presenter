import { beforeEach, expect, it, vi } from 'vitest'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  commitPersonalLocalMutation,
  listPersonalOutbox,
  acquirePersonalSyncLease
} from '../personal-sync-db'
import { recoverPersonalOperation } from '../personal-sync-runtime'
import { useFileExplorerStore } from '../../stores/file-explorer'
import * as fileExplorer from '../../stores/file-explorer'
import { usePersonalSyncStore } from '../../stores/personal-sync'

const sessions = {
  finalizeAndFlush: vi.fn().mockResolvedValue(null),
  hasPendingEditorWork: vi.fn().mockReturnValue(false),
  get: vi.fn().mockReturnValue(undefined)
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  sessions.finalizeAndFlush.mockReset().mockResolvedValue(null)
  sessions.hasPendingEditorWork.mockReset().mockReturnValue(false)
  sessions.get.mockReset().mockReturnValue(undefined)
  usePersonalSyncStore.getState().setAccount('authenticated', 'alice', true)
  await resetFileExplorerDBForTests()
  const db = await openFileExplorerDB()
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    collectionId: 'space',
    rootId: 'root',
    collectionRevision: 0,
    sequence: 0
  })
  await commitPersonalLocalMutation({
    ownerId: 'alice',
    nodeId: 'file',
    remoteId: 'remote',
    operationId: 'operation',
    localRevision: 1,
    catalog: {
      id: 'file',
      type: 'file',
      personalOwnerId: 'alice',
      name: 'image.png',
      mimeType: 'image/png',
      size: 3,
      url: 'blob:snapshot',
      parentId: 'root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    },
    mutation: { type: 'create-file', name: 'image.png', parentId: '' },
    snapshot: { id: 'snapshot', blob: new Blob(['one']), size: 3 }
  })
  const operation = (await listPersonalOutbox('alice'))[0]
  await db.put('personal-sync-outbox', { ...operation, failure: 'invalid-content' })
})

it('retries quota with the exact durable request and snapshot', async () => {
  const db = await openFileExplorerDB()
  const operation = (await listPersonalOutbox('alice'))[0]
  const blocked = {
    ...operation,
    failure: 'quota-exceeded',
    uploadId: 'upload',
    submittedRequest: {
      ...operation.mutation,
      operationId: 'operation',
      itemId: 'remote',
      expectedRevision: 0,
      uploadId: 'upload'
    }
  }
  await db.put('personal-sync-outbox', blocked)
  await recoverPersonalOperation('alice', 'operation', 'retry', sessions)
  expect((await listPersonalOutbox('alice'))[0]).toEqual({
    ...blocked,
    failure: undefined,
    failureData: undefined
  })
  expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 2 })
})

it('backs up exact bytes durably before cancelling only the invalid create', async () => {
  await recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
  const db = await openFileExplorerDB()
  expect(await listPersonalOutbox('alice')).toEqual([])
  expect(await db.get('folder-items', 'file')).toBeUndefined()
  const backups = await db.getAll('folder-items')
  expect(backups).toHaveLength(1)
  const backup = backups[0]
  if (backup.type !== 'file') throw new Error('Missing backup')
  expect(backup.personalOwnerId).toBeUndefined()
  expect(backup).toMatchObject({ parentId: 'file-root', size: 3, expiresAt: null })
  const record = await db.get('file-blobs', backup.url.slice(5))
  expect(await record?.blob?.text()).toBe('one')
  expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 0 })
})

it.each(['submitted', 'dependent', 'unknown-dependent', 'remote'])(
  'refuses unsafe %s cancellation without deleting anything',
  async (reason) => {
    const db = await openFileExplorerDB()
    const op = (await listPersonalOutbox('alice'))[0]
    if (reason === 'submitted')
      await db.put('personal-sync-outbox', {
        ...op,
        submittedRequest: {
          ...op.mutation,
          operationId: op.id,
          itemId: op.remoteId,
          expectedRevision: 0
        }
      })
    if (reason.includes('dependent'))
      await db.put('personal-sync-outbox', {
        ...op,
        id: 'next',
        sequence: 2,
        nodeId: reason === 'dependent' ? 'file' : 'unknown',
        dependsOn: op.id,
        failure: undefined
      })
    if (reason === 'remote') {
      const node = await db.get('personal-sync-nodes', 'file')
      if (node) await db.put('personal-sync-nodes', { ...node, remoteRevision: 1 })
    }
    const before = await db.getAll('personal-sync-outbox')
    await expect(
      recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
    ).rejects.toThrow()
    expect(await db.getAll('personal-sync-outbox')).toEqual(before)
    expect(await db.getAll('folder-items')).toHaveLength(1)
    expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 2 })
  }
)

it('preserves failed saves without creating a backup or cancelling', async () => {
  sessions.finalizeAndFlush.mockRejectedValueOnce(new Error('Save blocked'))
  await expect(
    recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
  ).rejects.toThrow('Save blocked')
  expect(await listPersonalOutbox('alice')).toHaveLength(1)
  expect(await (await openFileExplorerDB()).getAll('folder-items')).toHaveLength(1)
})

it('rejects pending editor work after finalization even when the catalog is unchanged', async () => {
  sessions.hasPendingEditorWork.mockReturnValue(true)
  await expect(
    recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
  ).rejects.toThrow()
  expect(await listPersonalOutbox('alice')).toHaveLength(1)
  expect(await (await openFileExplorerDB()).getAll('folder-items')).toHaveLength(1)
})

it('preserves original refs and durable backup if edits arrive during backup', async () => {
  const db = await openFileExplorerDB()
  const originalBackup = fileExplorer.createLocalRecoveryFileBackup
  vi.spyOn(fileExplorer, 'createLocalRecoveryFileBackup').mockImplementation(async (...args) => {
    const id = await originalBackup(...args)
    sessions.hasPendingEditorWork.mockReturnValue(true)
    return id
  })
  await expect(
    recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
  ).rejects.toThrow()
  expect(await listPersonalOutbox('alice')).toHaveLength(1)
  expect(await db.get('folder-items', 'file')).toBeDefined()
  expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 2 })
  expect(await db.getAll('folder-items')).toHaveLength(2)
})

it.each(['account', 'lease'])('fences %s changes during finalization', async (change) => {
  sessions.finalizeAndFlush.mockImplementationOnce(async () => {
    if (change === 'account')
      usePersonalSyncStore.getState().setAccount('authenticated', 'bob', true)
    else {
      const db = await openFileExplorerDB()
      const state = await db.get('personal-sync-state', 'alice')
      if (state)
        await db.put('personal-sync-state', {
          ...state,
          lease: { workerId: 'other', expiresAt: Date.now() + 30000 }
        })
    }
    return null
  })
  await expect(
    recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
  ).rejects.toThrow()
  expect(await listPersonalOutbox('alice')).toHaveLength(1)
  expect(await (await openFileExplorerDB()).get('file-blobs', 'snapshot')).toMatchObject({
    refCount: 2
  })
})

it('does not steal another active worker lease', async () => {
  await acquirePersonalSyncLease('alice', 'other')
  await expect(recoverPersonalOperation('alice', 'operation', 'retry', sessions)).rejects.toThrow()
  expect((await listPersonalOutbox('alice'))[0].failure).toBe('invalid-content')
})

it('rejects an unsaved session after a blocked finalize even without pending editor text', async () => {
  sessions.get.mockReturnValueOnce({
    getSnapshot: () => ({ save: { status: 'failed' }, draftKind: null })
  })
  await expect(
    recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
  ).rejects.toThrow()
  expect(await listPersonalOutbox('alice')).toHaveLength(1)
  expect(await (await openFileExplorerDB()).get('file-blobs', 'snapshot')).toMatchObject({
    refCount: 2
  })
})

it.each(['account', 'lease', 'catalog', 'dependent'])(
  'retains original data when %s changes during backup',
  async (change) => {
    const db = await openFileExplorerDB()
    const originalPut = db.put.bind(db)
    const originalBackup = fileExplorer.createLocalRecoveryFileBackup
    let changed = false
    vi.spyOn(fileExplorer, 'createLocalRecoveryFileBackup').mockImplementation(async (...args) => {
      const result = await originalBackup(...args)
      if (!changed) {
        changed = true
        if (change === 'account')
          usePersonalSyncStore.getState().setAccount('authenticated', 'bob', true)
        if (change === 'lease') {
          const state = await db.get('personal-sync-state', 'alice')
          if (state)
            await originalPut('personal-sync-state', {
              ...state,
              lease: { workerId: 'other', expiresAt: Date.now() + 30000 }
            })
        }
        if (change === 'catalog') {
          const item = await db.get('folder-items', 'file')
          if (item?.type === 'file')
            await originalPut('folder-items', { ...item, name: 'Changed.png' })
        }
        if (change === 'dependent') {
          const op = (await listPersonalOutbox('alice'))[0]
          await originalPut('personal-sync-outbox', {
            ...op,
            id: 'next',
            nodeId: 'unknown',
            sequence: 2,
            dependsOn: op.id,
            failure: undefined
          })
        }
      }
      return result
    })
    await expect(
      recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
    ).rejects.toThrow()
    expect(await db.get('personal-sync-outbox', 'operation')).toBeDefined()
    expect(await db.get('folder-items', 'file')).toBeDefined()
    expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 2 })
  }
)

it('never publishes a temporary expiring recovery backup before its permanent retention is durable', async () => {
  const seen: Array<number | null> = []
  const prior = new Set(Object.keys(useFileExplorerStore.getState().items))
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    for (const item of Object.values(state.items))
      if (item.type === 'file' && !item.personalOwnerId && !prior.has(item.id))
        seen.push(item.expiresAt)
  })
  try {
    await recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
  } finally {
    unsubscribe()
  }
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every((expiresAt) => expiresAt === null)).toBe(true)
})

it('rolls back backup catalog creation if its owner switches away and back after add succeeds', async () => {
  const originalAdd = IDBObjectStore.prototype.add
  let switched = 0
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    const request = originalAdd.call(this, value, key)
    if (this.name === 'folder-items')
      request.addEventListener(
        'success',
        () => {
          switched++
          usePersonalSyncStore.getState().setAccount('authenticated', 'bob', true)
          usePersonalSyncStore.getState().setAccount('authenticated', 'alice', true)
        },
        { once: true }
      )
    return request
  })
  await expect(
    recoverPersonalOperation('alice', 'operation', 'backup-cancel', sessions)
  ).rejects.toMatchObject({ name: 'AbortError' })
  const db = await openFileExplorerDB()
  expect(switched).toBe(1)
  expect(await db.getAll('folder-items')).toEqual([
    expect.objectContaining({ id: 'file', personalOwnerId: 'alice' })
  ])
  expect(await db.get('personal-sync-outbox', 'operation')).toBeDefined()
  expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 2 })
  expect((await db.getAll('file-blobs')).map((record) => record.id)).toEqual(['snapshot'])
  expect(await db.getAll('resource-cleanup-journal')).toEqual([])
})

it('keeps ordinary root upload retention and notes while recovery backups are permanent', async () => {
  const before = Date.now()
  const id = await fileExplorer.addFileItemToStore(
    new File(['two'], 'Upload.txt', { type: 'text/plain' }),
    'file-root',
    'text/plain',
    'Keep notes'
  )
  const db = await openFileExplorerDB()
  const item = await db.get('folder-items', id)
  expect(item).toMatchObject({ name: 'Upload.txt', notes: 'Keep notes', size: 3 })
  expect(item?.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000)
  expect(item?.expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000)
})

it('does not stage bytes or metadata for an already cancelled recovery command', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    fileExplorer.createLocalRecoveryFileBackup(
      new File(['two'], 'Cancelled.txt'),
      'text/plain',
      controller.signal
    )
  ).rejects.toMatchObject({ name: 'AbortError' })
  const db = await openFileExplorerDB()
  expect(await db.getAll('folder-items')).toEqual([expect.objectContaining({ id: 'file' })])
  expect((await db.getAll('file-blobs')).map((record) => record.id)).toEqual(['snapshot'])
  expect(await db.getAll('resource-cleanup-journal')).toEqual([])
})
