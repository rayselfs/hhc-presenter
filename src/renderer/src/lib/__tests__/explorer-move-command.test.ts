import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import {
  moveExplorerEntry,
  renameExplorerEntry,
  useFileExplorerStore
} from '@renderer/stores/file-explorer'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'

const root: FolderRecord = {
  id: 'file-root',
  name: 'Files',
  parentId: null,
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null
}
const parent: FolderRecord = {
  ...root,
  id: 'parent',
  name: 'Parent',
  parentId: root.id,
  isFavorited: true
}
const child: FolderRecord = { ...parent, id: 'child', name: 'Child', parentId: root.id }
const file: FileItemRecord = {
  id: 'file',
  parentId: parent.id,
  name: 'Original.txt',
  type: 'file',
  mimeType: 'text/plain',
  url: 'blob:source',
  size: 3,
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null,
  notes: 'Preserved'
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await useFileExplorerStore.getState().flushPersistence()
  await resetFileExplorerDBForTests()
  usePersonalSyncStore.setState({ activeOwnerId: null })
  const db = await openFileExplorerDB()
  for (const folder of [root, parent, child]) await db.put('folder-records', folder)
  await db.put('folder-items', file)
  await db.put('file-blobs', { id: 'source', blob: new Blob(['one']), size: 3, refCount: 1 })
  useFileExplorerStore.setState({
    folders: { [root.id]: root, [parent.id]: parent, [child.id]: child },
    items: { [file.id]: file },
    _foldersArray: [root, parent, child],
    _itemsArray: [file],
    _childFoldersByParent: { [root.id]: [parent], [parent.id]: [child] },
    _itemsByParent: { [parent.id]: [file] },
    currentFolderId: root.id,
    loadedParents: new Set([root.id, parent.id])
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await useFileExplorerStore
    .getState()
    .flushPersistence()
    .catch(() => undefined)
  await useFileExplorerStore.getState().retryPersistence()
})

async function move(kind: 'folder' | 'file', id: string, destination: string): Promise<void> {
  await moveExplorerEntry(kind, id, destination)
}

it('awaits file move persistence and publishes both parent indexes without changing bytes', async () => {
  await move('file', file.id, child.id)
  const db = await openFileExplorerDB()
  const moved = await db.get('folder-items', file.id)
  expect(moved).toEqual({ ...file, parentId: child.id, sortIndex: 0, expiresAt: null })
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(moved)
  expect(useFileExplorerStore.getState()._itemsByParent[parent.id]).toEqual([])
  expect(useFileExplorerStore.getState()._itemsByParent[child.id]).toEqual([moved])
  expect(await db.get('file-blobs', 'source')).toMatchObject({ refCount: 1, size: 3 })
})

it('does not publish an aborted file move and permits retry', async () => {
  const originalPut = IDBObjectStore.prototype.put
  let aborted = 0
  const publish = vi.fn()
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    if (state.items[file.id]?.parentId === child.id) publish()
  })
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    const request = originalPut.call(this, value, key)
    if (this.name === 'folder-items')
      request.addEventListener(
        'success',
        () => {
          aborted++
          this.transaction.abort()
        },
        { once: true }
      )
    return request
  })
  try {
    await expect(move('file', file.id, child.id)).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    vi.restoreAllMocks()
    unsubscribe()
  }
  expect(aborted).toBe(1)
  expect(publish).not.toHaveBeenCalled()
  expect(await (await openFileExplorerDB()).get('folder-items', file.id)).toEqual(file)
  await move('file', file.id, child.id)
  expect((await (await openFileExplorerDB()).get('folder-items', file.id))?.parentId).toBe(child.id)
})

it('rejects an unloaded durable descendant instead of creating a folder cycle', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-records', { ...child, parentId: parent.id })
  useFileExplorerStore.setState((state) => ({
    folders: { [root.id]: root, [parent.id]: parent },
    _foldersArray: [root, parent],
    _childFoldersByParent: { [root.id]: [parent] },
    loadedParents: state.loadedParents
  }))
  await expect(move('folder', parent.id, child.id)).rejects.toThrow()
  expect(await db.get('folder-records', parent.id)).toEqual(parent)
})

it('rejects a durable trashed destination even when the store says it is live', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-records', { ...child, deletedAt: 123 })
  await expect(move('file', file.id, child.id)).rejects.toThrow('unavailable')
  expect(await db.get('folder-items', file.id)).toEqual(file)
})

it('preserves folder retention and counts durable unloaded siblings', async () => {
  const db = await openFileExplorerDB()
  const retained = { ...parent, expiresAt: 1234 }
  await db.put('folder-records', retained)
  await db.put('folder-records', { ...root, id: 'unloaded', parentId: child.id, name: 'Unloaded' })
  await move('folder', parent.id, child.id)
  expect(await db.get('folder-records', parent.id)).toEqual({
    ...retained,
    parentId: child.id,
    sortIndex: 1
  })
  expect(
    useFileExplorerStore.getState()._childFoldersByParent[root.id].map((entry) => entry.id)
  ).toEqual([child.id])
  expect(
    useFileExplorerStore.getState()._childFoldersByParent[child.id].map((entry) => entry.id)
  ).toEqual([parent.id])
})

it('preserves file retention semantics when moving to the root and when already there', async () => {
  const before = Date.now()
  await move('file', file.id, root.id)
  const db = await openFileExplorerDB()
  const moved = await db.get('folder-items', file.id)
  expect(moved?.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000)
  expect(moved?.expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000)
  await move('file', file.id, root.id)
  expect(await db.get('folder-items', file.id)).toEqual(moved)
})

it('keeps an earlier queued rename and later legacy metadata when moving', async () => {
  const rename = renameExplorerEntry('file', file.id, 'Renamed.txt')
  const movement = move('file', file.id, child.id)
  useFileExplorerStore.getState().updateItem?.(file.id, { notes: 'Later note' })
  await Promise.all([rename, movement])
  await useFileExplorerStore.getState().flushPersistence()
  const persisted = await (await openFileExplorerDB()).get('folder-items', file.id)
  expect(persisted).toMatchObject({ name: 'Renamed.txt', parentId: child.id, notes: 'Later note' })
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(persisted)
})

it.each([
  'source tombstone',
  'destination tombstone',
  'source trash',
  'source sync',
  'destination sync'
] as const)('rejects durable %s despite stale UI metadata', async (invalid) => {
  const db = await openFileExplorerDB()
  if (invalid === 'source tombstone' || invalid === 'destination tombstone')
    await db.put('catalog-deletions', {
      id: invalid === 'source tombstone' ? file.id : child.id,
      deletedAt: 1
    })
  if (invalid === 'source trash') await db.put('folder-items', { ...file, deletedAt: 1 })
  if (invalid === 'source sync' || invalid === 'destination sync') {
    const folder = invalid === 'source sync' ? parent : child
    await db.put('folder-records', {
      ...folder,
      syncLink: {
        providerType: 'onedrive',
        providerConnectionId: 'connection',
        remoteFolderId: 'remote'
      }
    })
  }
  await expect(move('file', file.id, child.id)).rejects.toThrow()
  expect((await db.get('folder-items', file.id))?.parentId).toBe(parent.id)
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(file)
})

async function seedPersonal(): Promise<void> {
  const db = await openFileExplorerDB()
  await db.put('folder-records', { ...parent, personalOwnerId: 'alice' })
  await db.put('folder-records', { ...child, parentId: parent.id, personalOwnerId: 'alice' })
  await db.put('folder-items', { ...file, personalOwnerId: 'alice' })
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    rootId: parent.id,
    collectionId: 'space',
    collectionRevision: 1,
    sequence: 0
  })
  for (const [id, kind] of [
    [file.id, 'file'],
    [child.id, 'folder']
  ] as const)
    await db.put('personal-sync-nodes', {
      id,
      ownerId: 'alice',
      remoteId: `remote-${id}`,
      kind,
      localRevision: 2,
      syncedLocalRevision: 2,
      remoteRevision: 2
    })
  usePersonalSyncStore.setState({ activeOwnerId: 'alice', accountStatus: 'unavailable' })
}

it('awaits a same-owner offline move with the original real revision/outbox transaction', async () => {
  await seedPersonal()
  await move('file', file.id, child.id)
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', file.id)).toMatchObject({
    parentId: child.id,
    personalOwnerId: 'alice'
  })
  expect(await db.get('personal-sync-nodes', file.id)).toMatchObject({ localRevision: 3 })
  expect(await db.getAll('personal-sync-outbox')).toEqual([
    expect.objectContaining({
      ownerId: 'alice',
      mutation: { type: 'move', parentId: 'remote-child' }
    })
  ])
})

it('aborts the whole personal move transaction on an away-and-back owner switch', async () => {
  await seedPersonal()
  const originalPut = IDBObjectStore.prototype.put
  let switched = 0
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    const request = originalPut.call(this, value, key)
    if (this.name === 'personal-sync-nodes')
      request.addEventListener(
        'success',
        () => {
          switched++
          usePersonalSyncStore.setState({ activeOwnerId: 'bob' })
          usePersonalSyncStore.setState({ activeOwnerId: 'alice' })
        },
        { once: true }
      )
    return request
  })
  await expect(move('file', file.id, child.id)).rejects.toMatchObject({ name: 'AbortError' })
  const db = await openFileExplorerDB()
  expect(switched).toBe(1)
  expect(await db.get('folder-items', file.id)).toEqual({ ...file, personalOwnerId: 'alice' })
  expect(await db.get('personal-sync-nodes', file.id)).toMatchObject({ localRevision: 2 })
  expect(await db.getAll('personal-sync-outbox')).toEqual([])
})

it('keeps the source when a cross-owner folder move performs its existing durable copy', async () => {
  await seedPersonal()
  await move('folder', child.id, root.id)
  const db = await openFileExplorerDB()
  expect(await db.get('folder-records', child.id)).toMatchObject({
    parentId: parent.id,
    personalOwnerId: 'alice'
  })
  expect(
    (await db.getAll('folder-records')).filter(
      (entry) => entry.name === child.name && !entry.personalOwnerId
    )
  ).toEqual([
    expect.objectContaining({ parentId: root.id, id: expect.not.stringMatching(/^child$/) })
  ])
  expect(await db.getAll('personal-sync-outbox')).toEqual([])
})
