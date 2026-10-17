import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as catalogMutations from '../file-catalog-mutations'
import type { FolderRecord } from '@shared/types/folder'
import { createExplorerFolder, useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'

const root: FolderRecord = {
  id: 'file-root',
  parentId: null,
  name: 'Files',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null
}
const parent: FolderRecord = {
  ...root,
  id: 'parent',
  parentId: root.id,
  name: 'Parent',
  expiresAt: 1234
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await useFileExplorerStore.getState().flushPersistence()
  usePersonalSyncStore.setState({ activeOwnerId: null })
  await resetFileExplorerDBForTests()
  const db = await openFileExplorerDB()
  await db.put('folder-records', root)
  await db.put('folder-records', parent)
  useFileExplorerStore.setState({
    folders: { [root.id]: root, [parent.id]: parent },
    _foldersArray: [root, parent],
    _childFoldersByParent: { [root.id]: [parent] },
    items: {},
    _itemsArray: [],
    _itemsByParent: {},
    loadedParents: new Set([root.id]),
    currentFolderId: root.id
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

it('publishes a new folder only after its durable commit and inherits parent retention', async () => {
  const db = await openFileExplorerDB()
  const id = await createExplorerFolder(' Child ', parent.id)
  const record = await db.get('folder-records', id)
  expect(record).toMatchObject({
    id,
    name: 'Child',
    parentId: parent.id,
    expiresAt: 1234,
    sortIndex: 0
  })
  expect(useFileExplorerStore.getState().folders[id]).toEqual(record)
  expect(useFileExplorerStore.getState()._childFoldersByParent[parent.id]).toEqual([record])
})

it('rejects an actual put-success transaction abort without transient publication and permits retry', async () => {
  const publish = vi.fn()
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    if (Object.values(state.folders).some((folder) => folder.name === 'Failed')) publish()
  })
  const originalPut = IDBObjectStore.prototype.put
  const originalAdd = IDBObjectStore.prototype.add
  let aborted = 0
  const abortAfterSuccess = function (
    this: IDBObjectStore,
    request: IDBRequest<IDBValidKey>
  ): IDBRequest<IDBValidKey> {
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
  }
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    return abortAfterSuccess.call(this, originalPut.call(this, value, key))
  })
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    return abortAfterSuccess.call(this, originalAdd.call(this, value, key))
  })
  try {
    await expect(createExplorerFolder('Failed', parent.id)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(aborted).toBe(1)
    expect(publish).not.toHaveBeenCalled()
    expect(await (await openFileExplorerDB()).getAll('folder-records')).toHaveLength(2)
  } finally {
    vi.restoreAllMocks()
    unsubscribe()
  }
  const id = await createExplorerFolder('Retry', parent.id)
  expect(await (await openFileExplorerDB()).get('folder-records', id)).toMatchObject({
    name: 'Retry'
  })
})

it('reserves unique names and sort positions from durable siblings, including unloaded records', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-records', {
    ...parent,
    id: 'unloaded',
    parentId: parent.id,
    name: 'Child',
    sortIndex: 0
  })
  const [first, second] = await Promise.all([
    createExplorerFolder('Child', parent.id),
    createExplorerFolder('Child', parent.id)
  ])
  expect(await db.get('folder-records', first)).toMatchObject({ name: 'Child 2', sortIndex: 1 })
  expect(await db.get('folder-records', second)).toMatchObject({ name: 'Child 3', sortIndex: 2 })
})

it('preserves explicit permanent retention and the root one-day default', async () => {
  const now = Date.now()
  const permanent = await createExplorerFolder('Permanent', root.id, null)
  const temporary = await createExplorerFolder('Temporary', root.id)
  const db = await openFileExplorerDB()
  expect((await db.get('folder-records', permanent))?.expiresAt).toBeNull()
  expect((await db.get('folder-records', temporary))?.expiresAt).toBeGreaterThanOrEqual(
    now + 86_400_000
  )
})

it('rejects tombstoned ancestors before creating any record', async () => {
  const db = await openFileExplorerDB()
  await db.put('catalog-deletions', { id: parent.id, deletedAt: 1 })
  await expect(createExplorerFolder('Blocked', parent.id)).rejects.toThrow('deleted')
  expect(await db.getAll('folder-records')).toHaveLength(2)
})

it.each(['../Invalid', '', '..'])('rejects invalid names %j without publication', async (name) => {
  await expect(createExplorerFolder(name, parent.id)).rejects.toThrow('invalid')
  expect(await (await openFileExplorerDB()).getAll('folder-records')).toHaveLength(2)
})

it('waits for an earlier parent update before inheriting retention', async () => {
  useFileExplorerStore.getState().updateFolder(parent.id, { expiresAt: 5678 })
  const id = await createExplorerFolder('After update', parent.id)
  expect(await (await openFileExplorerDB()).get('folder-records', id)).toMatchObject({
    expiresAt: 5678
  })
})

it('rejects creation after an earlier queued parent deletion without publishing a child', async () => {
  useFileExplorerStore.getState().softDeleteFolder(parent.id)
  await expect(createExplorerFolder('After delete', parent.id)).rejects.toThrow('unavailable')
  const db = await openFileExplorerDB()
  expect((await db.get('folder-records', parent.id))?.deletedAt).toBeTruthy()
  expect(await db.getAll('folder-records')).toHaveLength(2)
  expect(
    Object.values(useFileExplorerStore.getState().folders).some(
      (folder) => folder.name === 'After delete'
    )
  ).toBe(false)
})

it.each([NaN, Infinity, -Infinity])(
  'rejects invalid expiration %j without publication',
  async (expiresAt) => {
    await expect(createExplorerFolder('Invalid expiration', parent.id, expiresAt)).rejects.toThrow(
      'expiration is invalid'
    )
    expect(await (await openFileExplorerDB()).getAll('folder-records')).toHaveLength(2)
  }
)

it('rejects a durable read-only parent even when its UI metadata is stale', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-records', {
    ...parent,
    syncLink: {
      providerConnectionId: 'sync',
      providerType: 'onedrive',
      remoteFolderId: 'remote'
    }
  })
  await expect(createExplorerFolder('Read-only', parent.id)).rejects.toThrow('unavailable')
  expect(await db.getAll('folder-records')).toHaveLength(2)
})

it('does not start the create transaction ahead of earlier work held in the shared queue', async () => {
  const gate = Promise.withResolvers<void>()
  const originalSave = catalogMutations.saveCatalogRecords
  vi.spyOn(catalogMutations, 'saveCatalogRecords').mockImplementationOnce(async (...args) => {
    await gate.promise
    await originalSave(...args)
  })
  const create = vi.spyOn(catalogMutations, 'createLocalCatalogFolder')
  useFileExplorerStore.getState().updateFolder(parent.id, { expiresAt: 5678 })
  useFileExplorerStore.getState().updateFolder(parent.id, { expiresAt: 9999 })
  const pending = createExplorerFolder('After held work', parent.id)
  try {
    expect(create).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
  }
  const id = await pending
  expect(create).toHaveBeenCalledOnce()
  expect(await (await openFileExplorerDB()).get('folder-records', id)).toMatchObject({
    expiresAt: 9999
  })
})
