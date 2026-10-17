import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import {
  deleteFolderFromStore,
  removeFileItemFromStore,
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
const child: FolderRecord = { ...parent, id: 'child', name: 'Child', parentId: parent.id }
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

it('awaits a durable trash marker without deleting bytes or metadata', async () => {
  await removeFileItemFromStore(file.id)
  const db = await openFileExplorerDB()
  const trashed = await db.get('folder-items', file.id)
  expect(trashed).toMatchObject({
    ...file,
    deletedAt: expect.any(Number),
    originalParentId: parent.id
  })
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(trashed)
  expect(await db.get('file-blobs', 'source')).toMatchObject({ size: 3, refCount: 1 })
  expect(await db.getAll('resource-cleanup-journal')).toEqual([])
})

it('commits a folder trash marker and descendant favorite changes together', async () => {
  await deleteFolderFromStore(parent.id)
  const db = await openFileExplorerDB()
  expect(await db.get('folder-records', parent.id)).toMatchObject({
    deletedAt: expect.any(Number),
    isFavorited: false,
    originalParentId: root.id
  })
  expect(await db.get('folder-records', child.id)).toEqual({ ...child, isFavorited: false })
  expect(await db.get('folder-items', file.id)).toEqual(file)
  expect(useFileExplorerStore.getState().loadedParents).toEqual(new Set([root.id, parent.id]))
})

it('rolls back the whole folder update after a descendant request succeeds, with no publication', async () => {
  const originalPut = IDBObjectStore.prototype.put
  let aborted = 0
  const publish = vi.fn()
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    if (state.folders[parent.id]?.deletedAt || !state.folders[child.id]?.isFavorited) publish()
  })
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    const request = originalPut.call(this, value, key)
    if (
      this.name === 'folder-records' &&
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      value.id === child.id
    )
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
    await expect(deleteFolderFromStore(parent.id)).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    vi.restoreAllMocks()
    unsubscribe()
  }
  expect(aborted).toBe(1)
  expect(publish).not.toHaveBeenCalled()
  const db = await openFileExplorerDB()
  expect(await db.get('folder-records', parent.id)).toEqual(parent)
  expect(await db.get('folder-records', child.id)).toEqual(child)
  await deleteFolderFromStore(parent.id)
  expect((await db.get('folder-records', parent.id))?.deletedAt).toBeTruthy()
})

it('preserves an earlier durable rename while marking the file as trashed', async () => {
  const rename = renameExplorerEntry('file', file.id, 'Renamed.txt')
  const deletion = removeFileItemFromStore(file.id)
  await Promise.all([rename, deletion])
  expect(await (await openFileExplorerDB()).get('folder-items', file.id)).toMatchObject({
    name: 'Renamed.txt',
    deletedAt: expect.any(Number),
    notes: 'Preserved'
  })
})

it('rejects a tombstoned ancestor without changing the file or store', async () => {
  const db = await openFileExplorerDB()
  await db.put('catalog-deletions', { id: parent.id, deletedAt: 1 })
  await expect(removeFileItemFromStore(file.id)).rejects.toThrow('deleted')
  expect(await db.get('folder-items', file.id)).toEqual(file)
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(file)
})

it('holds descendant metadata until the whole folder transaction has published', async () => {
  const originalPut = IDBObjectStore.prototype.put
  let interleaved = false
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    const request = originalPut.call(this, value, key)
    if (
      !interleaved &&
      this.name === 'folder-records' &&
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      value.id === parent.id
    )
      request.addEventListener(
        'success',
        () => {
          interleaved = true
          useFileExplorerStore.getState().updateFolder(child.id, { name: 'Later child' })
        },
        { once: true }
      )
    return request
  })
  await deleteFolderFromStore(parent.id)
  await useFileExplorerStore.getState().flushPersistence()
  expect(interleaved).toBe(true)
  const persisted = await (await openFileExplorerDB()).get('folder-records', child.id)
  expect(persisted).toMatchObject({ name: 'Later child', isFavorited: false })
  expect(useFileExplorerStore.getState().folders[child.id]).toEqual(persisted)
})

it.each(['move', 'reorder'] as const)(
  'preserves a file trash marker through an overlapping legacy %s',
  async (action) => {
    const originalPut = IDBObjectStore.prototype.put
    let interleaved = false
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ) {
      const request = originalPut.call(this, value, key)
      if (!interleaved && this.name === 'folder-items')
        request.addEventListener(
          'success',
          () => {
            interleaved = true
            if (action === 'move') useFileExplorerStore.getState().moveItem(file.id, root.id)
            else useFileExplorerStore.getState().reorderItems(parent.id, [file.id])
          },
          { once: true }
        )
      return request
    })
    await removeFileItemFromStore(file.id)
    await useFileExplorerStore.getState().flushPersistence()
    expect(interleaved).toBe(true)
    const persisted = await (await openFileExplorerDB()).get('folder-items', file.id)
    expect(persisted).toMatchObject({ deletedAt: expect.any(Number), originalParentId: parent.id })
    expect(useFileExplorerStore.getState().items[file.id]).toEqual(persisted)
  }
)

it('rejects the root and durable read-only ancestors before publishing', async () => {
  await expect(deleteFolderFromStore(root.id)).rejects.toThrow('unavailable')
  const db = await openFileExplorerDB()
  await db.put('folder-records', {
    ...parent,
    syncLink: {
      providerType: 'onedrive',
      providerConnectionId: 'connection',
      remoteFolderId: 'remote'
    }
  })
  await expect(removeFileItemFromStore(file.id)).rejects.toThrow('read-only')
  expect(await db.get('folder-items', file.id)).toEqual(file)
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(file)
})

it('preserves the first trash timestamp and supports nested selected folders', async () => {
  await deleteFolderFromStore(parent.id)
  const db = await openFileExplorerDB()
  const first = await db.get('folder-records', parent.id)
  await deleteFolderFromStore(parent.id)
  expect(await db.get('folder-records', parent.id)).toEqual(first)
  await deleteFolderFromStore(child.id)
  expect(await db.get('folder-records', child.id)).toMatchObject({
    deletedAt: expect.any(Number),
    originalParentId: parent.id,
    isFavorited: false
  })
})

async function seedPersonal(): Promise<void> {
  const db = await openFileExplorerDB()
  await db.put('folder-records', { ...parent, personalOwnerId: 'alice' })
  await db.put('folder-items', { ...file, personalOwnerId: 'alice' })
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    rootId: parent.id,
    collectionId: 'space',
    collectionRevision: 1,
    sequence: 0
  })
  await db.put('personal-sync-nodes', {
    id: file.id,
    ownerId: 'alice',
    remoteId: 'remote',
    kind: 'file',
    localRevision: 2,
    syncedLocalRevision: 2,
    remoteRevision: 2
  })
  usePersonalSyncStore.setState({ activeOwnerId: 'alice', accountStatus: 'unavailable' })
}

it('preserves an offline personal delete and its real revision/outbox transaction', async () => {
  await seedPersonal()
  await removeFileItemFromStore(file.id)
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', file.id)).toMatchObject({
    deletedAt: expect.any(Number),
    personalOwnerId: 'alice'
  })
  expect(await db.get('personal-sync-nodes', file.id)).toMatchObject({ localRevision: 3 })
  expect(await db.getAll('personal-sync-outbox')).toEqual([
    expect.objectContaining({ ownerId: 'alice', mutation: { type: 'delete' } })
  ])
})

it('aborts personal deletion when its owner switches away and back during the transaction', async () => {
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
  await expect(removeFileItemFromStore(file.id)).rejects.toMatchObject({ name: 'AbortError' })
  const db = await openFileExplorerDB()
  expect(switched).toBe(1)
  expect(await db.get('folder-items', file.id)).toEqual({ ...file, personalOwnerId: 'alice' })
  expect(await db.get('personal-sync-nodes', file.id)).toMatchObject({ localRevision: 2 })
  expect(await db.getAll('personal-sync-outbox')).toEqual([])
})
