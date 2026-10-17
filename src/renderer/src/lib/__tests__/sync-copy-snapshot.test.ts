import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileItemRecord, FolderRecord, SyncProviderType } from '@shared/types/folder'
import { copyExplorerFile, useFileExplorerStore } from '../../stores/file-explorer'
import { getBlobId } from '../blob-identity'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'

const nativeFiles = new Map<string, Blob>()
const urls = new Map<string, Blob>()
const fetchSource = vi.fn(async (url: string) => new Response(urls.get(url)))

beforeEach(async () => {
  await useFileExplorerStore.getState().flushPersistence()
  await resetFileExplorerDBForTests()
  nativeFiles.clear()
  urls.clear()
  fetchSource.mockClear()
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('fetch', fetchSource)
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (!('size' in blob)) throw new Error('Expected a Blob source')
    const url = `blob:${crypto.randomUUID()}`
    urls.set(url, blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => urls.delete(url))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function seed(providerType: SyncProviderType, native = false): Promise<void> {
  if (native) {
    vi.stubGlobal('api', {
      nativeFs: {
        exists: async (id: string) => nativeFiles.has(id),
        getUrl: (id: string) => {
          const url = `hhc-file://${id}`
          urls.set(url, nativeFiles.get(id)!)
          return url
        },
        importFile: async (id: string, file: File) => {
          nativeFiles.set(id, file)
          return { size: file.size }
        },
        delete: async (id: string) => nativeFiles.delete(id)
      }
    })
  }
  const root: FolderRecord = {
    id: 'sync',
    parentId: 'file-root',
    name: 'Sync',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    syncLink: { providerConnectionId: 'connection', remoteFolderId: 'remote', providerType }
  }
  const nested: FolderRecord = { ...root, id: 'nested', parentId: root.id, syncLink: undefined }
  const source: FileItemRecord = {
    id: 'source',
    parentId: nested.id,
    type: 'file',
    name: 'Source.txt',
    mimeType: 'text/plain',
    url: 'blob:source',
    size: 1,
    notes: 'Keep this note',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null
  }
  const db = await openFileExplorerDB()
  await db.put('folder-records', root)
  await db.put('folder-records', nested)
  await db.put('folder-items', source)
  const bytes = new NodeBlob(['A']) as Blob
  nativeFiles.set(source.id, bytes)
  await db.put(
    'file-blobs',
    native
      ? { id: source.id, storage: 'native-fs', size: 1, refCount: 1 }
      : { id: source.id, blob: bytes, refCount: 1 }
  )
  useFileExplorerStore.setState({
    folders: { sync: root, nested },
    items: { source },
    _foldersArray: [root, nested],
    _itemsArray: [source],
    _itemsByParent: { nested: [source] },
    _childFoldersByParent: {},
    isLoading: false
  })
}

it.each(['local-fs', 'onedrive', 'hhc-line', 'hhc-share'] as const)(
  'keeps a %s copy unchanged after source replacement and cache deletion',
  async (provider) => {
    await seed(provider)
    const db = await openFileExplorerDB()
    const id = await copyExplorerFile('source', 'file-root')
    const copy = (await db.get('folder-items', id!)) as FileItemRecord
    expect(getBlobId(copy)).not.toBe('source')
    expect(copy).toMatchObject({
      name: 'Source.txt',
      notes: 'Keep this note',
      parentId: 'file-root'
    })
    expect(copy.expiresAt).toBeGreaterThan(Date.now())
    await db.put('file-blobs', { id: 'source', blob: new NodeBlob(['B']) as Blob, refCount: 1 })
    await db.delete('file-blobs', 'source')
    expect(await (await db.get('file-blobs', getBlobId(copy)))?.blob?.text()).toBe('A')
    expect(await db.getAll('resource-cleanup-journal')).toEqual([])
  }
)

it('imports independent native bytes rather than retaining the mutable native path', async () => {
  await seed('local-fs', true)
  const db = await openFileExplorerDB()
  const id = await copyExplorerFile('source', 'file-root')
  const copy = (await db.get('folder-items', id!)) as FileItemRecord
  expect(getBlobId(copy)).not.toBe('source')
  nativeFiles.set('source', new NodeBlob(['B']) as Blob)
  nativeFiles.delete('source')
  expect(await nativeFiles.get(getBlobId(copy))?.text()).toBe('A')
  expect(await db.get('file-blobs', getBlobId(copy))).toMatchObject({
    storage: 'native-fs',
    refCount: 1
  })
})

it('does not publish a copy when reading the source fails', async () => {
  await seed('onedrive')
  fetchSource.mockRejectedValueOnce(new Error('Read failed'))
  await expect(copyExplorerFile('source', 'file-root')).rejects.toThrow('Read failed')
  const db = await openFileExplorerDB()
  expect((await db.getAll('folder-items')).map((item) => item.id)).toEqual(['source'])
  expect((await db.getAll('file-blobs')).map((blob) => blob.id)).toEqual(['source'])
})

it('keeps personal-copy failure as null and reports it without publishing a copy', async () => {
  await seed('onedrive')
  const { usePersonalSyncStore } = await import('../../stores/personal-sync')
  const state = useFileExplorerStore.getState()
  useFileExplorerStore.setState({
    folders: {
      ...state.folders,
      personal: {
        id: 'personal',
        parentId: 'file-root',
        name: 'Personal',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        personalOwnerId: 'owner'
      }
    }
  })
  fetchSource.mockRejectedValueOnce(new Error('Read failed'))
  expect(await copyExplorerFile('source', 'personal')).toBeNull()
  expect(usePersonalSyncStore.getState()).toMatchObject({
    syncStatus: 'failed',
    errorCode: 'Read failed'
  })
  const db = await openFileExplorerDB()
  expect((await db.getAll('folder-items')).map((item) => item.id)).toEqual(['source'])
  expect(Object.keys(useFileExplorerStore.getState().items)).toEqual(['source'])
})
