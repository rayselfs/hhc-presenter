import { beforeEach, expect, it, vi } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { restoreExplorerEntry, useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'

const root: FolderRecord = {
  id: 'file-root',
  parentId: null,
  name: 'Files',
  createdAt: 1,
  sortIndex: 0,
  expiresAt: null
}
const parent: FolderRecord = { ...root, id: 'parent', name: 'Parent', parentId: root.id }
const file: FileItemRecord = {
  id: 'file',
  parentId: parent.id,
  originalParentId: parent.id,
  deletedAt: 10,
  name: 'File.txt',
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

it('returns only after the file is durable and published without changing its bytes or metadata', async () => {
  await restoreExplorerEntry('file', file.id)
  const db = await openFileExplorerDB()
  const restored = await db.get('folder-items', file.id)
  expect(restored).toEqual({ ...file, deletedAt: undefined, originalParentId: undefined })
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(restored)
  expect(useFileExplorerStore.getState()._itemsByParent[parent.id]).toEqual([restored])
  expect(await db.get('file-blobs', 'source')).toMatchObject({ size: 3, refCount: 1 })
})

it('keeps queued earlier metadata edits before restoring', async () => {
  useFileExplorerStore.getState().updateItem?.(file.id, { notes: 'Earlier queued notes' })
  await restoreExplorerEntry('file', file.id, 'Restored.txt')
  expect(await (await openFileExplorerDB()).get('folder-items', file.id)).toMatchObject({
    name: 'Restored.txt',
    notes: 'Earlier queued notes',
    deletedAt: undefined
  })
})

it('restores a folder to root when its original parent is deleted, without loading its children', async () => {
  const deletedParent = { ...parent, deletedAt: 5 }
  const folder = {
    ...parent,
    id: 'folder',
    name: 'Folder',
    parentId: parent.id,
    originalParentId: parent.id,
    deletedAt: 10,
    isFavorited: true
  }
  const db = await openFileExplorerDB()
  await db.put('folder-records', deletedParent)
  await db.put('folder-records', folder)
  useFileExplorerStore.setState({
    folders: { [root.id]: root, [parent.id]: deletedParent, [folder.id]: folder },
    _foldersArray: [root, deletedParent, folder],
    _childFoldersByParent: { [root.id]: [deletedParent], [parent.id]: [folder] }
  })
  await restoreExplorerEntry('folder', folder.id)
  const restored = await db.get('folder-records', folder.id)
  expect(restored).toMatchObject({
    parentId: root.id,
    deletedAt: undefined,
    originalParentId: undefined,
    isFavorited: false
  })
  const state = useFileExplorerStore.getState()
  expect(state._childFoldersByParent[parent.id]).toEqual([])
  expect(state._childFoldersByParent[root.id]).toContainEqual(restored)
  expect(state.loadedParents.has(folder.id)).toBe(false)
})

it('rejects an aborted real transaction without publishing success', async () => {
  const before = useFileExplorerStore.getState().items[file.id]
  const originalPut = IDBObjectStore.prototype.put
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ): IDBRequest<IDBValidKey> {
    const request = originalPut.call(this, value, key)
    if (this.name === 'folder-items')
      request.addEventListener('success', () => this.transaction.abort(), { once: true })
    return request
  })
  await expect(restoreExplorerEntry('file', file.id)).rejects.toThrow()
  put.mockRestore()
  expect(await (await openFileExplorerDB()).get('folder-items', file.id)).toEqual(file)
  expect(useFileExplorerStore.getState().items[file.id]).toBe(before)
  await restoreExplorerEntry('file', file.id)
  expect(useFileExplorerStore.getState().items[file.id].deletedAt).toBeUndefined()
})

it.each(['file', 'parent'])('does not revive a permanently tombstoned %s', async (id) => {
  const db = await openFileExplorerDB()
  await db.put('catalog-deletions', { id, deletedAt: 20 })
  await expect(restoreExplorerEntry('file', file.id)).rejects.toThrow('deleted')
  expect(await db.get('folder-items', file.id)).toEqual(file)
  expect(useFileExplorerStore.getState().items[file.id]).toEqual(file)
})

it('rejects a new sibling conflict and permits a reviewed replacement name', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-items', { ...file, id: 'sibling', deletedAt: undefined })
  await expect(restoreExplorerEntry('file', file.id)).rejects.toThrow('name already exists')
  expect((await db.get('folder-items', file.id))?.deletedAt).toBe(10)
  await restoreExplorerEntry('file', file.id, 'Different.txt')
  expect(await db.get('folder-items', file.id)).toMatchObject({
    name: 'Different.txt',
    deletedAt: undefined
  })
})

it('rejects a destination belonging to a different account without changing trash', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-records', { ...parent, personalOwnerId: 'other' })
  await expect(restoreExplorerEntry('file', file.id)).rejects.toThrow('destination')
  expect(await db.get('folder-items', file.id)).toEqual(file)
})

it('awaits the personal restore transaction and retains its outbox revision', async () => {
  const db = await openFileExplorerDB()
  const personalRoot = { ...parent, id: 'personal-root', personalOwnerId: 'alice' }
  const personalFile = {
    ...file,
    parentId: personalRoot.id,
    originalParentId: personalRoot.id,
    personalOwnerId: 'alice'
  }
  await db.put('folder-records', personalRoot)
  await db.put('folder-items', personalFile)
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    rootId: personalRoot.id,
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
  usePersonalSyncStore.setState({ activeOwnerId: 'alice', accountStatus: 'authenticated' })
  await restoreExplorerEntry('file', file.id, 'Personal.txt')
  expect(await db.get('folder-items', file.id)).toMatchObject({
    name: 'Personal.txt',
    deletedAt: undefined,
    personalOwnerId: 'alice'
  })
  expect(await db.getAll('personal-sync-outbox')).toEqual([
    expect.objectContaining({
      nodeId: file.id,
      localRevision: 3,
      mutation: { type: 'restore', name: 'Personal.txt' }
    })
  ])
  expect(useFileExplorerStore.getState().items[file.id]).toMatchObject({
    name: 'Personal.txt',
    deletedAt: undefined
  })
})

it.each(['file', 'folder'] as const)(
  'preserves metadata queued while a %s restore is committing',
  async (kind) => {
    const db = await openFileExplorerDB()
    const folder = {
      ...parent,
      id: 'folder',
      name: 'Restored folder',
      parentId: root.id,
      originalParentId: root.id,
      deletedAt: 10
    }
    if (kind === 'folder') {
      await db.put('folder-records', folder)
      useFileExplorerStore.setState((state) => ({
        folders: { ...state.folders, [folder.id]: folder },
        _foldersArray: [...state._foldersArray, folder]
      }))
    }
    const id = kind === 'file' ? file.id : folder.id
    const originalPut = IDBObjectStore.prototype.put
    let queued = false
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      const request = originalPut.call(this, value, key)
      if (
        !queued &&
        this.name === (kind === 'file' ? 'folder-items' : 'folder-records') &&
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        value.id === id &&
        'deletedAt' in value &&
        !value.deletedAt
      ) {
        queued = true
        request.addEventListener(
          'success',
          () => {
            const state = useFileExplorerStore.getState()
            if (kind === 'file') state.updateItem?.(id, { notes: 'Later metadata' })
            else state.updateFolder(id, { name: 'Later name' })
          },
          { once: true }
        )
      }
      return request
    })
    try {
      await restoreExplorerEntry(kind, id)
      await useFileExplorerStore.getState().flushPersistence()
    } finally {
      put.mockRestore()
    }
    expect(queued).toBe(true)
    const restored =
      kind === 'file' ? await db.get('folder-items', id) : await db.get('folder-records', id)
    expect(restored?.deletedAt).toBeUndefined()
    expect(restored).toMatchObject(
      kind === 'file' ? { notes: 'Later metadata' } : { name: 'Later name' }
    )
    expect(
      kind === 'file'
        ? useFileExplorerStore.getState().items[id]
        : useFileExplorerStore.getState().folders[id]
    ).toEqual(restored)
  }
)

it('rolls back personal restore when the account switches away and back during the transaction', async () => {
  const db = await openFileExplorerDB()
  const personalRoot = { ...parent, id: 'personal-root', personalOwnerId: 'alice' }
  const personalFile = {
    ...file,
    parentId: personalRoot.id,
    originalParentId: personalRoot.id,
    personalOwnerId: 'alice'
  }
  await db.put('folder-records', personalRoot)
  await db.put('folder-items', personalFile)
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    rootId: personalRoot.id,
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
  const originalPut = IDBObjectStore.prototype.put
  let switched = false
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
          switched = true
          usePersonalSyncStore.setState({ activeOwnerId: 'bob' })
          usePersonalSyncStore.setState({ activeOwnerId: 'alice' })
        },
        { once: true }
      )
    return request
  })
  try {
    await expect(restoreExplorerEntry('file', file.id)).rejects.toThrow()
  } finally {
    put.mockRestore()
  }
  expect(switched).toBe(true)
  expect(await db.get('folder-items', file.id)).toEqual(personalFile)
  expect(await db.get('personal-sync-nodes', file.id)).toMatchObject({ localRevision: 2 })
  expect(await db.getAll('personal-sync-outbox')).toEqual([])
})
