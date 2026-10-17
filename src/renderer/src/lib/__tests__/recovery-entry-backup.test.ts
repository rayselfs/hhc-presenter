import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import {
  createLocalRecoveryEntryBackup,
  FILE_EXPLORER_ROOT_ID,
  useFileExplorerStore
} from '../../stores/file-explorer'
import { usePersonalSyncStore } from '../../stores/personal-sync'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { getBlobId } from '../blob-identity'

const urls = new Map<string, Blob>()
const fetchSource = vi.fn(
  async (url: string, _options?: RequestInit) => new Response(urls.get(url))
)
const root: FolderRecord = {
  id: FILE_EXPLORER_ROOT_ID,
  parentId: null,
  name: 'Files',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null
}
const source: FolderRecord = {
  ...root,
  id: 'personal-folder',
  parentId: 'personal-root',
  name: 'Recovery',
  personalOwnerId: 'alice'
}
const nested: FolderRecord = {
  ...source,
  id: 'nested',
  parentId: source.id,
  name: 'Nested',
  deletedAt: 2
}
const item: FileItemRecord = {
  id: 'source-item',
  parentId: nested.id,
  type: 'file',
  name: 'Saved.txt',
  mimeType: 'text/plain',
  url: 'blob:original-blob',
  size: 3,
  notes: 'Preserve this note',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null,
  personalOwnerId: 'alice',
  deletedAt: 2
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await useFileExplorerStore.getState().flushPersistence()
  usePersonalSyncStore.setState({ activeOwnerId: 'alice', accountStatus: 'authenticated' })
  await resetFileExplorerDBForTests()
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  urls.clear()
  fetchSource.mockReset().mockImplementation(async (url: string) => new Response(urls.get(url)))
  vi.stubGlobal('fetch', fetchSource)
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:${crypto.randomUUID()}`
    urls.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    urls.delete(url)
  })
  const db = await openFileExplorerDB()
  for (const folder of [root, source, nested]) await db.put('folder-records', folder)
  await db.put('folder-items', item)
  await db.put('file-blobs', { id: 'original-blob', blob: new Blob(['one']), size: 3, refCount: 1 })
  useFileExplorerStore.setState({
    folders: { [root.id]: root, [source.id]: source, [nested.id]: nested },
    _foldersArray: [root, source, nested],
    _childFoldersByParent: { [root.id]: [], [source.id]: [nested] },
    items: { [item.id]: item },
    _itemsArray: [item],
    _itemsByParent: { [nested.id]: [item] },
    loadedParents: new Set([root.id, source.id, nested.id]),
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
  vi.unstubAllGlobals()
})

it('creates permanent recovery folders and independent bytes, including deleted descendants and notes', async () => {
  useFileExplorerStore.setState({
    folders: { [root.id]: root, [source.id]: source },
    _foldersArray: [root, source],
    items: {},
    _itemsArray: [],
    _itemsByParent: {},
    _childFoldersByParent: {},
    loadedParents: new Set([root.id])
  })
  const publications: number[] = []
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    for (const entry of [...state._foldersArray, ...state._itemsArray])
      if (!entry.personalOwnerId && entry.expiresAt !== null)
        publications.push(entry.expiresAt ?? -1)
  })

  const backupId = await createLocalRecoveryEntryBackup(
    'alice',
    source.id,
    new AbortController().signal
  )
  const db = await openFileExplorerDB()
  const folders = (await db.getAll('folder-records')).filter(
    (folder) => !folder.personalOwnerId && folder.id !== root.id
  )
  unsubscribe()
  expect(publications).toEqual([])
  expect(folders).toHaveLength(2)
  for (const folder of folders) expect(folder.expiresAt).toBeNull()
  expect(folders.find((folder) => folder.id === backupId)?.parentId).toBe(root.id)
  const backups = (await db.getAll('folder-items')).filter(
    (entry): entry is FileItemRecord => entry.type === 'file' && !entry.personalOwnerId
  )
  expect(backups).toHaveLength(1)
  expect(backups[0]).toMatchObject({
    expiresAt: null,
    notes: item.notes,
    size: 3
  })
  expect(backups[0].deletedAt).toBeUndefined()
  expect(getBlobId(backups[0])).not.toBe(getBlobId(item))
  await db.delete('file-blobs', getBlobId(item))
  expect(await (await db.get('file-blobs', getBlobId(backups[0])))?.blob?.text()).toBe('one')
})

it.each(['folder-records', 'folder-items'] as const)(
  'rolls back the pending %s commit when recovery is cancelled after add succeeds',
  async (storeName) => {
    const controller = new AbortController()
    const originalAdd = IDBObjectStore.prototype.add
    let aborted = 0
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ) {
      const request = originalAdd.call(this, value, key)
      if (this.name === storeName)
        request.addEventListener(
          'success',
          () => {
            aborted++
            controller.abort()
          },
          { once: true }
        )
      return request
    })
    await expect(
      createLocalRecoveryEntryBackup('alice', source.id, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(aborted).toBe(1)
    const db = await openFileExplorerDB()
    expect(await db.get('folder-items', item.id)).toEqual(item)
    expect(await db.get('file-blobs', getBlobId(item))).toMatchObject({ refCount: 1 })
    expect((await db.getAll('folder-items')).filter((entry) => !entry.personalOwnerId)).toEqual([])
    expect(
      Object.values(useFileExplorerStore.getState().items).filter((entry) => !entry.personalOwnerId)
    ).toEqual([])
    const partialFolders = (await db.getAll('folder-records')).filter(
      (folder) => !folder.personalOwnerId && folder.id !== root.id
    )
    expect(partialFolders).toHaveLength(storeName === 'folder-records' ? 0 : 2)
    for (const folder of partialFolders) expect(folder.expiresAt).toBeNull()
    expect(await db.getAll('resource-cleanup-journal')).toEqual([])
  }
)

it('passes the recovery signal to source reads and keeps committed folders after a cancelled fetch', async () => {
  const controller = new AbortController()
  fetchSource.mockImplementationOnce(async (_url, options?: RequestInit) => {
    expect(options?.signal).toBe(controller.signal)
    controller.abort()
    return new Response('one')
  })
  await expect(
    createLocalRecoveryEntryBackup('alice', source.id, controller.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  const db = await openFileExplorerDB()
  expect((await db.getAll('folder-items')).map((entry) => entry.id)).toEqual([item.id])
  expect(await db.get('file-blobs', getBlobId(item))).toMatchObject({ refCount: 1 })
  const folders = (await db.getAll('folder-records')).filter(
    (folder) => !folder.personalOwnerId && folder.id !== root.id
  )
  expect(folders).toHaveLength(2)
  for (const folder of folders) expect(folder.expiresAt).toBeNull()
})

it('rejects truncated source bytes without publishing a completed file backup', async () => {
  fetchSource.mockResolvedValueOnce(new Response('x'))
  await expect(
    createLocalRecoveryEntryBackup('alice', item.id, new AbortController().signal)
  ).rejects.toThrow('Recovery source size changed')
  const db = await openFileExplorerDB()
  expect(await db.getAll('folder-items')).toEqual([item])
  expect(await db.getAll('resource-cleanup-journal')).toEqual([])
})

it.each(['wrong-owner', 'pre-aborted', 'foreign-descendant'] as const)(
  'rejects unsafe %s backup',
  async (reason) => {
    const controller = new AbortController()
    const db = await openFileExplorerDB()
    if (reason === 'wrong-owner') usePersonalSyncStore.setState({ activeOwnerId: 'bob' })
    if (reason === 'pre-aborted') controller.abort()
    if (reason === 'foreign-descendant')
      await db.put('folder-items', { ...item, personalOwnerId: 'bob' })
    await expect(
      createLocalRecoveryEntryBackup('alice', source.id, controller.signal)
    ).rejects.toThrow()
    expect(fetchSource).not.toHaveBeenCalled()
    expect((await db.getAll('folder-items')).map((entry) => entry.id)).toEqual([item.id])
    expect((await db.get('file-blobs', getBlobId(item)))?.refCount).toBe(1)
  }
)

it('materializes an independent native file through the existing native storage contract', async () => {
  const nativeFiles = new Map<string, Blob>([['original-blob', new Blob(['one'])]])
  vi.stubGlobal('api', {
    nativeFs: {
      exists: async (id: string) => nativeFiles.has(id),
      getUrl: (id: string) => `hhc-file://${id}`,
      importFile: async (id: string, file: File) => {
        nativeFiles.set(id, file)
        return { size: file.size }
      },
      delete: async (id: string) => {
        nativeFiles.delete(id)
      }
    }
  })
  fetchSource.mockImplementation(
    async (url: string) => new Response(nativeFiles.get(url.replace('hhc-file://', '')))
  )
  const db = await openFileExplorerDB()
  await db.put('file-blobs', { id: 'original-blob', storage: 'native-fs', size: 3, refCount: 1 })
  const id = await createLocalRecoveryEntryBackup('alice', item.id, new AbortController().signal)
  const backup = await db.get('folder-items', id)
  if (backup?.type !== 'file') throw new Error('Missing backup')
  expect(backup).toMatchObject({ expiresAt: null, notes: item.notes })
  const blobId = getBlobId(backup)
  expect(blobId).not.toBe('original-blob')
  expect(await db.get('file-blobs', blobId)).toMatchObject({
    storage: 'native-fs',
    size: 3,
    refCount: 1
  })
  nativeFiles.delete('original-blob')
  expect(await nativeFiles.get(blobId)?.text()).toBe('one')
})

it('rejects a non-file durable item without reading or copying bytes', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-items', {
    ...item,
    type: 'verse',
    versionId: 1,
    bookNumber: 43,
    chapter: 3,
    verse: 16,
    text: 'Fixture verse'
  })
  await expect(
    createLocalRecoveryEntryBackup('alice', item.id, new AbortController().signal)
  ).rejects.toThrow('Recovery source is unavailable')
  expect(fetchSource).not.toHaveBeenCalled()
  expect((await db.getAll('folder-items')).map((entry) => entry.id)).toEqual([item.id])
})
