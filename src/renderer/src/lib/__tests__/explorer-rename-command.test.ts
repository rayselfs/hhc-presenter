import { beforeEach, expect, it, vi } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  renameExplorerEntry,
  updateExplorerFolderProperties,
  useFileExplorerStore
} from '@renderer/stores/file-explorer'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'

const root: FolderRecord = {
  id: 'file-root',
  parentId: null,
  name: 'Files',
  createdAt: 1,
  sortIndex: 0,
  expiresAt: null
}
const parent: FolderRecord = {
  ...root,
  id: 'parent',
  name: 'Parent',
  parentId: root.id,
  isFavorited: true
}
const file: FileItemRecord = {
  id: 'file',
  parentId: parent.id,
  name: 'Original.txt',
  type: 'file',
  mimeType: 'text/plain',
  size: 3,
  url: 'blob:source',
  createdAt: 1,
  sortIndex: 2,
  expiresAt: 99,
  notes: 'Preserved'
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await useFileExplorerStore.getState().flushPersistence()
  usePersonalSyncStore.setState({ activeOwnerId: null })
  await resetFileExplorerDBForTests()
  const db = await openFileExplorerDB()
  await db.put('folder-records', root)
  await db.put('folder-records', parent)
  await db.put('folder-items', file)
  await db.put('file-blobs', { id: 'source', blob: new Blob(['one']), size: 3, refCount: 1 })
  useFileExplorerStore.setState({
    folders: { [root.id]: root, [parent.id]: parent },
    items: { [file.id]: file },
    _foldersArray: [root, parent],
    _itemsArray: [file],
    _childFoldersByParent: { [root.id]: [parent] },
    _itemsByParent: { [parent.id]: [file] },
    loadedParents: new Set([root.id, parent.id])
  })
})

it('publishes only a durable rename while preserving bytes, identity and metadata', async () => {
  const db = await openFileExplorerDB()
  useFileExplorerStore.getState().updateItem?.(file.id, { notes: 'Earlier notes' })
  await renameExplorerEntry('file', file.id, ' Renamed.txt ')
  const renamed = await db.get('folder-items', file.id)
  expect(renamed).toEqual({ ...file, name: 'Renamed.txt', notes: 'Earlier notes' })
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(renamed)
  expect(useFileExplorerStore.getState()._itemsByParent[parent.id]).toEqual([renamed])
  expect(await db.get('file-blobs', 'source')).toMatchObject({ size: 3, refCount: 1 })
})

it('renames folders without changing favorite state or loading their children', async () => {
  await renameExplorerEntry('folder', parent.id, 'Renamed folder')
  const renamed = await (await openFileExplorerDB()).get('folder-records', parent.id)
  expect(renamed).toEqual({ ...parent, name: 'Renamed folder' })
  expect(useFileExplorerStore.getState()._childFoldersByParent[root.id]).toEqual([renamed])
  expect(useFileExplorerStore.getState().loadedParents.size).toBe(2)
})

it('rejects an actual transaction abort after put success without any catalog publication', async () => {
  const publication = vi.fn()
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    const item = state.items[file.id]
    if (item?.type === 'file' && item.name !== file.name) publication()
  })
  const originalPut = IDBObjectStore.prototype.put
  let aborted = 0
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ): IDBRequest<IDBValidKey> {
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
    await expect(renameExplorerEntry('file', file.id, 'Failed.txt')).rejects.toMatchObject({
      name: 'AbortError'
    })
  } finally {
    put.mockRestore()
    unsubscribe()
  }
  expect(aborted).toBe(1)
  expect(publication).not.toHaveBeenCalled()
  expect(await (await openFileExplorerDB()).get('folder-items', file.id)).toEqual(file)
  await renameExplorerEntry('file', file.id, 'Retry.txt')
  expect(useFileExplorerStore.getState().items[file.id]).toMatchObject({ name: 'Retry.txt' })
})

it('holds metadata edits until overlapping renames have published their latest record', async () => {
  const originalPut = IDBObjectStore.prototype.put
  let queued = false
  let second: Promise<void> | undefined
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ): IDBRequest<IDBValidKey> {
    const request = originalPut.call(this, value, key)
    if (!queued && this.name === 'folder-items') {
      queued = true
      request.addEventListener(
        'success',
        () => {
          second = renameExplorerEntry('file', file.id, 'Second.txt')
          useFileExplorerStore.getState().updateItem?.(file.id, { notes: 'Later notes' })
        },
        { once: true }
      )
    }
    return request
  })
  try {
    await renameExplorerEntry('file', file.id, 'First.txt')
    await second
    await useFileExplorerStore.getState().flushPersistence()
  } finally {
    put.mockRestore()
  }
  expect(queued).toBe(true)
  const renamed = await (await openFileExplorerDB()).get('folder-items', file.id)
  expect(renamed).toMatchObject({ name: 'Second.txt', notes: 'Later notes' })
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(renamed)
})

it.each(['../Invalid', ' ', '..'])('rejects invalid display name %j', async (name) => {
  await expect(renameExplorerEntry('file', file.id, name)).rejects.toThrow('invalid')
  expect(await (await openFileExplorerDB()).get('folder-items', file.id)).toEqual(file)
})

it('checks sibling conflicts in the actual transaction', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-items', { ...file, id: 'other', name: 'Other.txt' })
  await expect(renameExplorerEntry('file', file.id, 'other.txt')).rejects.toThrow('already exists')
  expect(await db.get('folder-items', file.id)).toEqual(file)
})

it('rejects tombstoned ancestors and deleted sources', async () => {
  const db = await openFileExplorerDB()
  await db.put('catalog-deletions', { id: parent.id, deletedAt: 1 })
  await expect(renameExplorerEntry('file', file.id, 'Renamed.txt')).rejects.toThrow('deleted')
  await db.delete('catalog-deletions', parent.id)
  await db.put('folder-items', { ...file, deletedAt: 2 })
  await expect(renameExplorerEntry('file', file.id, 'Renamed.txt')).rejects.toThrow('unavailable')
})

it('rejects read-only sync roots and their contents', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-records', {
    ...parent,
    syncLink: {
      providerConnectionId: 'sync',
      providerType: 'onedrive',
      remoteFolderId: 'remote',
      offlinePolicy: 'online-only'
    }
  })
  await expect(renameExplorerEntry('folder', parent.id, 'Other')).rejects.toThrow('read-only')
  await expect(renameExplorerEntry('file', file.id, 'Other.txt')).rejects.toThrow('unavailable')
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

it('preserves offline personal rename and its real local revision/outbox transaction', async () => {
  await seedPersonal()
  await renameExplorerEntry('file', file.id, 'Personal.txt')
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', file.id)).toMatchObject({
    name: 'Personal.txt',
    personalOwnerId: 'alice'
  })
  expect(await db.get('personal-sync-nodes', file.id)).toMatchObject({ localRevision: 3 })
  expect(await db.getAll('personal-sync-outbox')).toEqual([
    expect.objectContaining({
      ownerId: 'alice',
      mutation: { type: 'rename', name: 'Personal.txt' }
    })
  ])
})

it('rolls back personal rename when its account switches away and back during the transaction', async () => {
  await seedPersonal()
  const originalPut = IDBObjectStore.prototype.put
  let switched = 0
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ): IDBRequest<IDBValidKey> {
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
  try {
    await expect(renameExplorerEntry('file', file.id, 'Aborted.txt')).rejects.toMatchObject({
      name: 'AbortError'
    })
  } finally {
    put.mockRestore()
  }
  const db = await openFileExplorerDB()
  expect(switched).toBe(1)
  expect(await db.get('folder-items', file.id)).toMatchObject({ name: file.name })
  expect(await db.get('personal-sync-nodes', file.id)).toMatchObject({ localRevision: 2 })
  expect(await db.getAll('personal-sync-outbox')).toEqual([])
})

it('keeps a favorite change made after rename put success without reverting the folder name', async () => {
  const originalPut = IDBObjectStore.prototype.put
  let toggled = 0
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ): IDBRequest<IDBValidKey> {
    const request = originalPut.call(this, value, key)
    if (!toggled && this.name === 'folder-records') {
      request.addEventListener(
        'success',
        () => {
          toggled++
          useFileExplorerStore.getState().toggleFavorite(parent.id)
        },
        { once: true }
      )
    }
    return request
  })
  try {
    await renameExplorerEntry('folder', parent.id, 'Renamed folder')
    await useFileExplorerStore.getState().flushPersistence()
  } finally {
    put.mockRestore()
  }
  expect(toggled).toBe(1)
  const renamed = await (await openFileExplorerDB()).get('folder-records', parent.id)
  expect(renamed).toMatchObject({ name: 'Renamed folder', isFavorited: false })
  expect(useFileExplorerStore.getState().folders[parent.id]).toEqual(renamed)
})

it('commits folder name and expiration together from the latest durable record', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-records', { ...parent, isFavorited: false, expiresAt: 100 })
  await updateExplorerFolderProperties(parent.id, { name: 'Properties', expiresAt: 200 })
  const updated = await db.get('folder-records', parent.id)
  expect(updated).toEqual({ ...parent, isFavorited: false, name: 'Properties', expiresAt: 200 })
  expect(useFileExplorerStore.getState().folders[parent.id]).toEqual(updated)
  expect(useFileExplorerStore.getState()._childFoldersByParent[root.id]).toEqual([updated])
})

it('rolls back both folder properties after put success and permits retry without publication', async () => {
  const db = await openFileExplorerDB()
  const original = { ...parent, isFavorited: false, expiresAt: 100 }
  await db.put('folder-records', original)
  useFileExplorerStore.setState({ folders: { [root.id]: root, [parent.id]: original } })
  const publication = vi.fn()
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    if (state.folders[parent.id]?.name === 'Properties') publication()
  })
  const originalPut = IDBObjectStore.prototype.put
  let aborted = 0
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ): IDBRequest<IDBValidKey> {
    const request = originalPut.call(this, value, key)
    if (this.name === 'folder-records')
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
    await expect(
      updateExplorerFolderProperties(parent.id, { name: 'Properties', expiresAt: 200 })
    ).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    put.mockRestore()
    unsubscribe()
  }
  expect(aborted).toBe(1)
  expect(publication).not.toHaveBeenCalled()
  expect(await db.get('folder-records', parent.id)).toEqual(original)
  expect(useFileExplorerStore.getState().folders[parent.id]).toEqual(original)
  await updateExplorerFolderProperties(parent.id, { name: 'Properties', expiresAt: 200 })
  expect(await db.get('folder-records', parent.id)).toMatchObject({
    name: 'Properties',
    expiresAt: 200
  })
})

it('retains favorite expiration lock from durable state even if UI state is stale', async () => {
  const stale = { ...parent, isFavorited: false, expiresAt: 100 }
  useFileExplorerStore.setState({
    folders: { [root.id]: root, [parent.id]: stale },
    _foldersArray: [root, stale],
    _childFoldersByParent: { [root.id]: [stale] }
  })
  expect(useFileExplorerStore.getState().folders[parent.id].isFavorited).toBe(false)
  await updateExplorerFolderProperties(parent.id, { name: 'Favorite', expiresAt: 200 })
  expect(await (await openFileExplorerDB()).get('folder-records', parent.id)).toMatchObject({
    name: 'Favorite',
    isFavorited: true,
    expiresAt: null
  })
})

it.each([NaN, Infinity, -Infinity])(
  'rejects invalid folder expiration %j without changing its name',
  async (expiresAt) => {
    await expect(
      updateExplorerFolderProperties(parent.id, { name: 'Invalid expiration', expiresAt })
    ).rejects.toThrow('expiration is invalid')
    expect(await (await openFileExplorerDB()).get('folder-records', parent.id)).toEqual(parent)
  }
)

it('keeps personal folder properties as a rename outbox operation without local retention changes', async () => {
  await seedPersonal()
  const db = await openFileExplorerDB()
  const folder = {
    ...parent,
    id: 'personal-folder',
    parentId: parent.id,
    personalOwnerId: 'alice',
    expiresAt: null
  }
  await db.put('folder-records', folder)
  await db.put('personal-sync-nodes', {
    id: folder.id,
    ownerId: 'alice',
    remoteId: 'remote-folder',
    kind: 'folder',
    localRevision: 2,
    syncedLocalRevision: 2,
    remoteRevision: 2
  })
  await updateExplorerFolderProperties(folder.id, { name: 'Personal folder', expiresAt: 200 })
  expect(await db.get('folder-records', folder.id)).toMatchObject({
    name: 'Personal folder',
    expiresAt: null
  })
  expect(await db.getAll('personal-sync-outbox')).toEqual([
    expect.objectContaining({
      ownerId: 'alice',
      mutation: { type: 'rename', name: 'Personal folder' }
    })
  ])
})
