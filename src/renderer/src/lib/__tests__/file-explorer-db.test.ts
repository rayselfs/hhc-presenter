import { beforeEach, describe, expect, it, vi } from 'vitest'

const { envState, mockImportFile, mockGetUrl, mockDeleteNativeFile, mockNativeFileExists } =
  vi.hoisted(() => ({
    envState: { isElectron: false },
    mockImportFile: vi.fn(),
    mockGetUrl: vi.fn(),
    mockDeleteNativeFile: vi.fn(),
    mockNativeFileExists: vi.fn()
  }))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => envState.isElectron
}))

interface StoredFileBlobRecord {
  id: string
  blob?: Blob
  storage?: 'indexed-db' | 'native-fs'
  size?: number
  refCount?: number
}

class FakeFileExplorerDB {
  records = new Map<string, StoredFileBlobRecord>()
  putCalls: StoredFileBlobRecord[] = []
  deleteCalls: string[] = []

  async put(_storeName: string, record: StoredFileBlobRecord): Promise<void> {
    this.records.set(record.id, record)
    this.putCalls.push(record)
  }

  async get(_storeName: string, id: string): Promise<StoredFileBlobRecord | undefined> {
    return this.records.get(id)
  }

  async delete(_storeName: string, id: string): Promise<void> {
    this.records.delete(id)
    this.deleteCalls.push(id)
  }
}

const mockSaveItem = vi.fn()

vi.mock('@renderer/lib/folder-db', () => ({
  createFolderDB: () => ({
    loadAllFolders: vi.fn().mockResolvedValue([]),
    loadItemsByParent: vi.fn().mockResolvedValue([]),
    saveFolder: vi.fn().mockResolvedValue(undefined),
    saveFolders: vi.fn().mockResolvedValue(undefined),
    deleteFolders: vi.fn().mockResolvedValue(undefined),
    saveItem: (...args: unknown[]) => mockSaveItem(...args),
    saveItems: vi.fn().mockResolvedValue(undefined),
    deleteItem: vi.fn().mockResolvedValue(undefined),
    deleteItems: vi.fn().mockResolvedValue(undefined),
    deleteItemsByParent: vi.fn().mockResolvedValue(undefined),
    deleteExpiredFolders: vi.fn().mockResolvedValue([]),
    deleteExpiredItems: vi.fn().mockResolvedValue([]),
    purgeTrashOlderThan: vi.fn().mockResolvedValue({ folderIds: [], itemIds: [] })
  })
}))

vi.mock('@renderer/lib/bible-db', () => ({
  openBibleDB: vi.fn()
}))

describe('file-explorer-db blob refCount', () => {
  let db: FakeFileExplorerDB

  beforeEach(() => {
    db = new FakeFileExplorerDB()
    vi.clearAllMocks()
    envState.isElectron = false
    mockImportFile.mockResolvedValue({ size: 5 })
    mockGetUrl.mockImplementation(
      (id: string, mimeType: string) => `hhc-media://file/${id}?type=${mimeType}`
    )
    mockDeleteNativeFile.mockResolvedValue(undefined)
    mockNativeFileExists.mockResolvedValue(true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        nativeFs: {
          importFile: mockImportFile,
          getUrl: mockGetUrl,
          delete: mockDeleteNativeFile,
          exists: mockNativeFileExists
        }
      }
    })
  })

  it('storeFileBlob writes refCount=1', async () => {
    const { storeFileBlob } = await import('../file-explorer-db')
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

    await storeFileBlob(db as never, 'file-1', file)

    expect(db.records.get('file-1')).toMatchObject({ id: 'file-1', blob: file, refCount: 1 })
  })

  it('stores every Electron upload in native filesystem metadata', async () => {
    envState.isElectron = true
    const { storeFileBlob } = await import('../file-explorer-db')
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

    await storeFileBlob(db as never, 'file-1', file)

    expect(mockImportFile).toHaveBeenCalledWith('file-1', file)
    expect(db.records.get('file-1')).toEqual({
      id: 'file-1',
      storage: 'native-fs',
      size: 5,
      refCount: 1
    })
  })

  it('uses the same native import path for Electron files larger than 2GB', async () => {
    envState.isElectron = true
    const size = 3 * 1024 ** 3
    mockImportFile.mockResolvedValue({ size })
    const { storeFileBlob } = await import('../file-explorer-db')
    const file = new File([], 'large-video.mp4', { type: 'video/mp4' })
    Object.defineProperty(file, 'size', { value: size })
    const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer')

    await storeFileBlob(db as never, 'file-large', file)

    expect(mockImportFile).toHaveBeenCalledWith('file-large', file)
    expect(arrayBufferSpy).not.toHaveBeenCalled()
    expect(db.records.get('file-large')).toMatchObject({
      storage: 'native-fs',
      size
    })
  })

  it('returns a protocol URL for native media without creating an object URL', async () => {
    envState.isElectron = true
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL')
    db.records.set('file-1', {
      id: 'file-1',
      storage: 'native-fs',
      size: 5,
      refCount: 1
    })
    const { getFileSource } = await import('../file-explorer-db')

    const source = await getFileSource(db as never, 'file-1', 'video/mp4')

    expect(source?.url).toBe('hhc-media://file/file-1?type=video/mp4')
    expect(createObjectUrlSpy).not.toHaveBeenCalled()
  })

  it('does not return a native media source when the native file is missing', async () => {
    envState.isElectron = true
    mockNativeFileExists.mockResolvedValue(false)
    db.records.set('file-1', {
      id: 'file-1',
      storage: 'native-fs',
      size: 5,
      refCount: 1
    })
    const { getFileSource, isFileBlobAvailable } = await import('../file-explorer-db')

    await expect(isFileBlobAvailable('file-1')).resolves.toBe(false)
    await expect(getFileSource(db as never, 'file-1', 'image/png')).resolves.toBeNull()
  })

  it('can create a native media URL without statting from projection renderers', async () => {
    envState.isElectron = true
    mockNativeFileExists.mockResolvedValue(false)
    db.records.set('file-1', {
      id: 'file-1',
      storage: 'native-fs',
      size: 5,
      refCount: 1
    })
    const { getFileSource } = await import('../file-explorer-db')

    const source = await getFileSource(db as never, 'file-1', 'image/png', {
      verifyNativeFile: false
    })

    expect(source?.url).toBe('hhc-media://file/file-1?type=image/png')
    expect(mockNativeFileExists).not.toHaveBeenCalled()
  })

  it('incrementBlobRef increments refCount to 2', async () => {
    const { incrementBlobRef } = await import('../file-explorer-db')
    const blob = new Blob(['hello'])
    db.records.set('file-1', { id: 'file-1', blob, refCount: 1 })

    await incrementBlobRef(db as never, 'file-1')

    expect(db.records.get('file-1')).toMatchObject({ id: 'file-1', blob, refCount: 2 })
  })

  it('deleteFileBlob with refCount=2 decrements to 1 without deleting', async () => {
    const { deleteFileBlob } = await import('../file-explorer-db')
    const blob = new Blob(['hello'])
    db.records.set('file-1', { id: 'file-1', blob, refCount: 2 })

    const deleted = await deleteFileBlob(db as never, 'file-1')

    expect(deleted).toBe(false)
    expect(db.records.get('file-1')).toMatchObject({ id: 'file-1', blob, refCount: 1 })
    expect(db.deleteCalls).toEqual([])
  })

  it('deleteFileBlob with refCount=1 deletes the blob record', async () => {
    const { deleteFileBlob } = await import('../file-explorer-db')
    db.records.set('file-1', { id: 'file-1', blob: new Blob(['hello']), refCount: 1 })

    const deleted = await deleteFileBlob(db as never, 'file-1')

    expect(deleted).toBe(true)
    expect(db.records.has('file-1')).toBe(false)
    expect(db.deleteCalls).toEqual(['file-1'])
  })

  it('deletes a native file only when its final reference is removed', async () => {
    envState.isElectron = true
    const { deleteFileBlob } = await import('../file-explorer-db')
    db.records.set('file-1', {
      id: 'file-1',
      storage: 'native-fs',
      size: 5,
      refCount: 2
    })

    await deleteFileBlob(db as never, 'file-1')
    expect(mockDeleteNativeFile).not.toHaveBeenCalled()

    await deleteFileBlob(db as never, 'file-1')
    expect(mockDeleteNativeFile).toHaveBeenCalledWith('file-1')
    expect(db.records.has('file-1')).toBe(false)
  })

  it('deleteFileBlob deletes legacy blob records without refCount', async () => {
    const { deleteFileBlob } = await import('../file-explorer-db')
    db.records.set('legacy-file', { id: 'legacy-file', blob: new Blob(['legacy']) })

    const deleted = await deleteFileBlob(db as never, 'legacy-file')

    expect(deleted).toBe(true)
    expect(db.records.has('legacy-file')).toBe(false)
    expect(db.deleteCalls).toEqual(['legacy-file'])
  })
})

describe('copyItem blob sharing', () => {
  it('commits shared blob references and copy metadata together', async () => {
    const { openFileExplorerDB, resetFileExplorerDBForTests } = await import('../file-explorer-db')
    await resetFileExplorerDBForTests()
    const db = await openFileExplorerDB()
    const { useFileExplorerStore } = await import('@renderer/stores/file-explorer')
    const source = {
      id: 'file-1',
      parentId: 'file-root',
      type: 'file' as const,
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'original.txt',
      url: 'blob:file-1',
      size: 5,
      mimeType: 'text/plain'
    }
    const target = {
      id: 'target-folder',
      parentId: 'file-root',
      name: 'Target',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    }
    await db.put('folder-records', target)
    await db.put('folder-items', source)
    await db.put('file-blobs', { id: 'file-1', blob: new Blob(['hello']), refCount: 1 })
    useFileExplorerStore.setState({
      folders: { 'target-folder': target },
      items: { 'file-1': source },
      _itemsArray: [source],
      _foldersArray: [target],
      _itemsByParent: { 'file-root': [source] },
      isLoading: false
    })
    const copiedId = await useFileExplorerStore.getState().copyItem('file-1', 'target-folder')
    expect(copiedId).toEqual(expect.any(String))
    expect((await db.get('file-blobs', 'file-1'))?.refCount).toBe(2)
    expect(await db.get('folder-items', copiedId!)).toMatchObject({
      parentId: 'target-folder',
      url: 'blob:file-1'
    })
    expect(await db.get('file-blobs', copiedId!)).toBeUndefined()
  })
})
