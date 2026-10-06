import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import type { FileItemRecord } from '@shared/types/folder'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  acknowledgePersonalOperation,
  acquirePersonalSyncLease,
  renewPersonalSyncLease,
  releasePersonalSyncLease,
  commitPersonalLocalMutation,
  listPersonalOutbox,
  type PersonalLocalMutationWrite
} from '../personal-sync-db'

const item: FileItemRecord = {
  id: 'local-file',
  personalOwnerId: 'alice',
  parentId: 'personal-root',
  type: 'file',
  name: 'Image.png',
  url: 'blob:snapshot-1',
  size: 3,
  mimeType: 'image/png',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null
}

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  await resetFileExplorerDBForTests()
  const db = await openFileExplorerDB()
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    collectionId: 'collection',
    rootId: 'personal-root',
    collectionRevision: 0,
    sequence: 0
  })
})

function createWrite(): PersonalLocalMutationWrite {
  return {
    ownerId: 'alice',
    nodeId: item.id,
    remoteId: 'remote-file',
    localRevision: 1,
    operationId: 'operation-1',
    catalog: item,
    mutation: { type: 'create-file' as const, name: item.name, parentId: '' },
    snapshot: { id: 'snapshot-1', blob: new Blob(['one']), size: 3 }
  }
}

describe('personal local transactions', () => {
  it('persists the catalog, immutable snapshot and recoverable operation together', async () => {
    await commitPersonalLocalMutation(createWrite())
    const db = await openFileExplorerDB()
    expect(await db.get('folder-items', item.id)).toEqual(item)
    expect(await db.get('personal-sync-nodes', item.id)).toMatchObject({
      ownerId: 'alice',
      localRevision: 1,
      syncedLocalRevision: 0
    })
    expect(await listPersonalOutbox('alice')).toMatchObject([
      { id: 'operation-1', sequence: 1, snapshotBlobId: 'snapshot-1', localRevision: 1 }
    ])
    expect(await listPersonalOutbox('bob')).toEqual([])
  })

  it('rolls every store back when a duplicate operation aborts the transaction', async () => {
    await commitPersonalLocalMutation(createWrite())
    const db = await openFileExplorerDB()
    await expect(
      commitPersonalLocalMutation({
        ...createWrite(),
        localRevision: 2,
        mutation: { type: 'replace-content' },
        catalog: { ...item, name: 'Changed', url: 'blob:snapshot-2' },
        snapshot: { id: 'snapshot-2', blob: new Blob(['two']), size: 3 }
      })
    ).rejects.toThrow()
    expect(await db.get('folder-items', item.id)).toEqual(item)
    expect(await db.get('file-blobs', 'snapshot-2')).toBeUndefined()
    expect(await db.get('personal-sync-state', 'alice')).toMatchObject({ sequence: 1 })
  })

  it('keeps both revisions while the earlier operation is uploading', async () => {
    await commitPersonalLocalMutation(createWrite())
    await commitPersonalLocalMutation({
      ...createWrite(),
      operationId: 'operation-2',
      localRevision: 2,
      mutation: { type: 'replace-content' },
      catalog: { ...item, url: 'blob:snapshot-2' },
      snapshot: { id: 'snapshot-2', blob: new Blob(['two']), size: 3 }
    })
    const db = await openFileExplorerDB()
    expect(await listPersonalOutbox('alice')).toMatchObject([
      { snapshotBlobId: 'snapshot-1', localRevision: 1 },
      { snapshotBlobId: 'snapshot-2', localRevision: 2, dependsOn: 'operation-1' }
    ])
    expect(await db.get('file-blobs', 'snapshot-1')).toMatchObject({ size: 3 })
    expect(await db.get('personal-sync-nodes', item.id)).toMatchObject({
      localRevision: 2,
      syncedLocalRevision: 0
    })
  })

  it('rejects another owner and stale local revisions without publishing changes', async () => {
    await commitPersonalLocalMutation(createWrite())
    const db = await openFileExplorerDB()
    await db.put('personal-sync-state', {
      ownerId: 'bob',
      collectionId: 'other',
      rootId: 'other-root',
      collectionRevision: 0,
      sequence: 0
    })
    await expect(
      commitPersonalLocalMutation({
        ...createWrite(),
        ownerId: 'bob',
        operationId: 'other-operation',
        localRevision: 2
      })
    ).rejects.toThrow('owner')
    await expect(
      commitPersonalLocalMutation({
        ...createWrite(),
        operationId: 'stale-operation'
      })
    ).rejects.toThrow('revision')
    expect(await db.get('personal-sync-outbox', 'other-operation')).toBeUndefined()
    expect(await db.get('personal-sync-outbox', 'stale-operation')).toBeUndefined()
    expect(await db.get('folder-items', item.id)).toEqual(item)
  })
})

it('keeps upload snapshots during storage repair after the catalog advances', async () => {
  const { repairMediaStorageIntegrity } = await import('../media-storage-integrity')
  await commitPersonalLocalMutation(createWrite())
  await commitPersonalLocalMutation({
    ...createWrite(),
    operationId: 'operation-2',
    localRevision: 2,
    mutation: { type: 'replace-content' },
    catalog: { ...item, url: 'blob:snapshot-2' },
    snapshot: { id: 'snapshot-2', blob: new Blob(['two']), size: 3 }
  })
  await repairMediaStorageIntegrity()
  const db = await openFileExplorerDB()
  expect(await db.get('file-blobs', 'snapshot-1')).toMatchObject({ refCount: 1 })
  expect(await db.get('file-blobs', 'snapshot-2')).toMatchObject({ refCount: 2 })
})

it('journals failed native staging without committing metadata or an outbox entry', async () => {
  const { commitPersonalFileMutation } = await import('../personal-sync-db')
  const env = await import('../env')
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  const electron = vi.spyOn(env, 'isElectron').mockReturnValue(true)
  const importFile = vi.fn().mockRejectedValue(new Error('Disk full'))
  Object.defineProperty(window, 'api', { configurable: true, value: { nativeFs: { importFile } } })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, action: () => Promise<void>) => action() }
  })
  try {
    await expect(
      commitPersonalFileMutation(createWrite(), new File(['one'], 'Image.png'))
    ).rejects.toThrow('Disk full')
    const db = await openFileExplorerDB()
    expect(await db.get('folder-items', item.id)).toBeUndefined()
    expect(await listPersonalOutbox('alice')).toEqual([])
    expect(await db.getAll('resource-cleanup-journal')).toMatchObject([
      { blobId: 'snapshot-1', deleteNativeFile: true, stagingLock: 'personal-blob:snapshot-1' }
    ])
    await expect(
      commitPersonalFileMutation(createWrite(), new File(['one'], 'Image.png'))
    ).rejects.toThrow('cleanup is pending')
    expect(importFile).toHaveBeenCalledTimes(1)
  } finally {
    electron.mockRestore()
    if (originalApi) Object.defineProperty(window, 'api', originalApi)
    else Reflect.deleteProperty(window, 'api')
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})

it('recovers durable operations after the database connection and modules restart', async () => {
  await commitPersonalLocalMutation(createWrite())
  const originalDb = await openFileExplorerDB()
  originalDb.close()
  vi.resetModules()
  const restarted = await import('../personal-sync-db')
  const restartedStorage = await import('../file-explorer-db')
  try {
    expect(await restarted.listPersonalOutbox('alice')).toMatchObject([
      { id: 'operation-1', snapshotBlobId: 'snapshot-1' }
    ])
    const db = await restartedStorage.openFileExplorerDB()
    expect(await db.get('folder-items', item.id)).toEqual(item)
  } finally {
    ;(await restartedStorage.openFileExplorerDB()).close()
  }
})

it('acknowledges only the committed revision and binds its dependent operation', async () => {
  await commitPersonalLocalMutation(createWrite())
  await commitPersonalLocalMutation({
    ...createWrite(),
    operationId: 'operation-2',
    localRevision: 2,
    mutation: { type: 'replace-content' },
    catalog: { ...item, url: 'blob:snapshot-2' },
    snapshot: { id: 'snapshot-2', blob: new Blob(['two']), size: 3 }
  })
  await acknowledgePersonalOperation('alice', 'operation-1', {
    itemId: 'remote-file',
    nodeRevision: 4,
    collectionRevision: 4
  })
  const db = await openFileExplorerDB()
  expect(await db.get('personal-sync-nodes', item.id)).toMatchObject({
    localRevision: 2,
    syncedLocalRevision: 1
  })
  expect(await listPersonalOutbox('alice')).toMatchObject([
    { id: 'operation-2', expectedRevision: 4, dependsOn: undefined }
  ])
})

it('keeps a rename revision dirty until both content and rename are acknowledged', async () => {
  await commitPersonalLocalMutation(createWrite())
  await acknowledgePersonalOperation('alice', 'operation-1', {
    itemId: 'remote-file',
    nodeRevision: 1,
    collectionRevision: 1
  })
  await commitPersonalLocalMutation({
    ...createWrite(),
    operationId: 'operation-2',
    localRevision: 2,
    mutation: { type: 'replace-content' },
    catalog: { ...item, name: 'Renamed.png', url: 'blob:snapshot-2' },
    snapshot: { id: 'snapshot-2', blob: new Blob(['two']), size: 3 }
  })
  await acknowledgePersonalOperation('alice', 'operation-2', {
    itemId: 'remote-file',
    nodeRevision: 2,
    collectionRevision: 2
  })
  const db = await openFileExplorerDB()
  expect(await db.get('personal-sync-nodes', item.id)).toMatchObject({ syncedLocalRevision: 1 })
  await acknowledgePersonalOperation('alice', 'operation-2:rename', {
    itemId: 'remote-file',
    nodeRevision: 3,
    collectionRevision: 3
  })
  expect(await db.get('personal-sync-nodes', item.id)).toMatchObject({ syncedLocalRevision: 2 })
})

it('preserves pending data when an ACK belongs to another owner or an aborted session', async () => {
  await commitPersonalLocalMutation(createWrite())
  const result = { itemId: 'remote-file', nodeRevision: 1, collectionRevision: 1 }
  await expect(acknowledgePersonalOperation('bob', 'operation-1', result)).rejects.toThrow('owner')
  await expect(
    acknowledgePersonalOperation('alice', 'operation-1', result, AbortSignal.abort())
  ).rejects.toThrow()
  expect(await listPersonalOutbox('alice')).toHaveLength(1)
  expect(await (await openFileExplorerDB()).get('personal-sync-nodes', item.id)).toMatchObject({
    syncedLocalRevision: 0
  })
})

describe('personal worker lease', () => {
  it('allows one worker and fences an expired worker after takeover', async () => {
    const acquired = await Promise.all([
      acquirePersonalSyncLease('alice', 'worker-a'),
      acquirePersonalSyncLease('alice', 'worker-b')
    ])
    expect(acquired.filter(Boolean)).toHaveLength(1)
    const winner = acquired[0] ? 'worker-a' : 'worker-b'
    const loser = acquired[0] ? 'worker-b' : 'worker-a'
    expect(await renewPersonalSyncLease('alice', loser)).toBe(false)
    const db = await openFileExplorerDB()
    const state = await db.get('personal-sync-state', 'alice')
    if (!state) throw new Error('Missing state')
    await db.put('personal-sync-state', { ...state, lease: { workerId: winner, expiresAt: 0 } })
    expect(await acquirePersonalSyncLease('alice', loser)).toBe(true)
    await releasePersonalSyncLease('alice', winner)
    expect(await renewPersonalSyncLease('alice', winner)).toBe(false)
    expect(await renewPersonalSyncLease('alice', loser)).toBe(true)
  })

  it('keeps outbox and snapshot references when a stale worker acknowledges', async () => {
    await commitPersonalLocalMutation(createWrite())
    await acquirePersonalSyncLease('alice', 'current-worker')
    await expect(
      acknowledgePersonalOperation(
        'alice',
        'operation-1',
        {
          itemId: 'remote-file',
          nodeRevision: 1,
          collectionRevision: 1
        },
        undefined,
        'stale-worker'
      )
    ).rejects.toThrow('lease')
    expect(await listPersonalOutbox('alice')).toHaveLength(1)
    expect(await (await openFileExplorerDB()).get('file-blobs', 'snapshot-1')).toMatchObject({
      refCount: 2
    })
  })
})

it('does not treat a noncontiguous ACK as proof that remote subtree changes were observed', async () => {
  await commitPersonalLocalMutation(createWrite())
  await acknowledgePersonalOperation('alice', 'operation-1', {
    itemId: 'remote-file',
    nodeRevision: 5,
    collectionRevision: 5
  })
  const db = await openFileExplorerDB()
  expect(await db.get('personal-sync-state', 'alice')).toMatchObject({ collectionRevision: 0 })
  expect(await db.get('personal-sync-nodes', item.id)).toMatchObject({ remoteRevision: 5 })
})

it('keeps restored subtree members dirty until the restore acknowledgement arrives', async () => {
  const folder = {
    id: 'folder',
    personalOwnerId: 'alice',
    parentId: 'personal-root',
    name: 'Folder',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null
  }
  await commitPersonalLocalMutation({
    ownerId: 'alice',
    nodeId: folder.id,
    remoteId: 'remote-folder',
    operationId: 'create-folder',
    localRevision: 1,
    catalog: folder,
    mutation: { type: 'create-folder', name: folder.name, parentId: '' }
  })
  await acknowledgePersonalOperation('alice', 'create-folder', {
    itemId: 'remote-folder',
    nodeRevision: 1,
    collectionRevision: 1
  })
  const child = { ...item, parentId: folder.id }
  await commitPersonalLocalMutation({
    ...createWrite(),
    catalog: child,
    mutation: { type: 'create-file', name: child.name, parentId: 'remote-folder' }
  })
  await acknowledgePersonalOperation('alice', 'operation-1', {
    itemId: 'remote-file',
    nodeRevision: 2,
    collectionRevision: 2
  })
  await commitPersonalLocalMutation({
    ownerId: 'alice',
    nodeId: folder.id,
    remoteId: 'remote-folder',
    operationId: 'delete-folder',
    localRevision: 2,
    catalog: { ...folder, deletedAt: 100 },
    mutation: { type: 'delete' }
  })
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', child.id)).toMatchObject({ deletedAt: 100 })
  await commitPersonalLocalMutation({
    ownerId: 'alice',
    nodeId: folder.id,
    remoteId: 'remote-folder',
    operationId: 'restore-folder',
    localRevision: 3,
    catalog: folder,
    mutation: { type: 'restore' }
  })
  await acknowledgePersonalOperation('alice', 'delete-folder', {
    itemId: 'remote-folder',
    nodeRevision: 3,
    collectionRevision: 3
  })
  expect(await db.get('personal-sync-nodes', child.id)).toMatchObject({
    localRevision: 3,
    syncedLocalRevision: 2
  })
  expect((await db.get('folder-items', child.id))?.deletedAt).toBeUndefined()
  await acknowledgePersonalOperation('alice', 'restore-folder', {
    itemId: 'remote-folder',
    nodeRevision: 4,
    collectionRevision: 4
  })
  expect(await db.get('personal-sync-nodes', child.id)).toMatchObject({
    localRevision: 3,
    syncedLocalRevision: 3,
    remoteRevision: 4
  })
})

it.each(['bad/name', 'bad\\name', '', 'e\u0301'])(
  'rejects invalid or unnormalized local name %j atomically',
  async (name) => {
    const write = createWrite()
    await expect(
      commitPersonalLocalMutation({
        ...write,
        catalog: { ...item, name },
        mutation: { type: 'create-file', name, parentId: '' }
      })
    ).rejects.toThrow('name')
    expect(await listPersonalOutbox('alice')).toEqual([])
    expect(await (await openFileExplorerDB()).get('file-blobs', 'snapshot-1')).toBeUndefined()
  }
)

it.each([
  ['image/svg+xml', 3],
  ['image/png', 0],
  ['image/png', 200 * 1024 * 1024 + 1]
])(
  'rejects personal upload policy bypass through the transaction (%s, %s)',
  async (mimeType, size) => {
    const write = createWrite()
    await expect(
      commitPersonalLocalMutation({
        ...write,
        catalog: { ...item, mimeType, size },
        snapshot: { id: 'snapshot-1', storage: 'native-fs', size }
      })
    ).rejects.toThrow()
    expect(await listPersonalOutbox('alice')).toEqual([])
    expect(await (await openFileExplorerDB()).get('folder-items', item.id)).toBeUndefined()
  }
)
