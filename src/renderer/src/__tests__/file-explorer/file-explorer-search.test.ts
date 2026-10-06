import { searchAllItems } from '@renderer/lib/file-explorer-search'
import type { FolderStoreState } from '@renderer/stores/folder'
import type { FileItemRecord, FolderRecord, AnyItemRecord } from '@shared/types/folder'

function makeFile(overrides: Partial<FileItemRecord> = {}): FileItemRecord {
  return {
    id: crypto.randomUUID(),
    parentId: 'file-root',
    type: 'file',
    name: 'untitled.txt',
    url: 'blob:test',
    size: 100,
    mimeType: 'text/plain',
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null,
    ...overrides
  }
}

function makeFolder(overrides: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id: crypto.randomUUID(),
    name: 'Folder',
    parentId: 'file-root',
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null,
    ...overrides
  }
}

function makeStoreState(items: AnyItemRecord[], folders: FolderRecord[] = []): FolderStoreState {
  const folderMap: Record<string, FolderRecord> = {}
  for (const f of folders) {
    folderMap[f.id] = f
  }

  return {
    folders: folderMap,
    items: {},
    _foldersArray: folders,
    _itemsArray: items,
    _childFoldersByParent: {},
    _itemsByParent: {},
    loadedParents: new Set(),
    currentFolderId: 'file-root',
    isLoading: false,
    isInitialized: false,
    persistenceStatus: 'ready',
    persistenceError: null,
    pendingPersistenceCount: 0,
    initialize: vi.fn(),
    retryInitialization: vi.fn(),
    flushPersistence: vi.fn(),
    retryPersistence: vi.fn(),
    addFolder: vi.fn(),
    updateFolder: vi.fn(),
    deleteFolder: vi.fn(),
    addItem: vi.fn(),
    removeItem: vi.fn(),
    moveItem: vi.fn(),
    moveFolder: vi.fn(),
    reorderItems: vi.fn(),
    reorderFolders: vi.fn(),
    navigateToFolder: vi.fn(),
    navigateToRoot: vi.fn(),
    navigateUp: vi.fn(),
    cleanupExpired: vi.fn(),
    ensureItemsLoaded: vi.fn(),
    toggleFavorite: vi.fn(),
    softDeleteFolder: vi.fn(),
    softDeleteItem: vi.fn(),
    restoreFolder: vi.fn(),
    restoreItem: vi.fn(),
    purgeTrash: vi.fn(),
    getChildFolders: vi.fn().mockReturnValue([]),
    getItems: vi.fn().mockReturnValue([]),
    getFolderPath: vi.fn().mockReturnValue([]),
    isItemsLoaded: vi.fn().mockReturnValue(false),
    copyItem: vi.fn(),
    softDeleteExpired: vi.fn()
  }
}

describe('searchAllItems', () => {
  it('returns empty array for empty query', () => {
    const file = makeFile({ name: 'photo.jpg' })
    const state = makeStoreState([file])
    expect(searchAllItems('', state, 'Files')).toEqual([])
  })

  it('returns empty array for whitespace-only query', () => {
    const file = makeFile({ name: 'photo.jpg' })
    const state = makeStoreState([file])
    expect(searchAllItems('   ', state, 'Files')).toEqual([])
  })

  it('returns matching file items', () => {
    const file = makeFile({ name: 'photo.jpg' })
    const state = makeStoreState([file])
    const results = searchAllItems('photo', state, 'Files')
    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.kind).toBe('file')
    if (r.kind === 'file') expect(r.item.name).toBe('photo.jpg')
  })

  it('is case-insensitive', () => {
    const file = makeFile({ name: 'MyDocument.pdf' })
    const state = makeStoreState([file])
    expect(searchAllItems('mydocument', state, 'Files')).toHaveLength(1)
    expect(searchAllItems('MYDOCUMENT', state, 'Files')).toHaveLength(1)
    expect(searchAllItems('MyDocument', state, 'Files')).toHaveLength(1)
  })

  it('filters out non-matching items', () => {
    const file1 = makeFile({ name: 'photo.jpg' })
    const file2 = makeFile({ name: 'report.pdf' })
    const state = makeStoreState([file1, file2])
    const results = searchAllItems('photo', state, 'Files')
    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.kind).toBe('file')
    if (r.kind === 'file') expect(r.item.name).toBe('photo.jpg')
  })

  it('returns all matching items when multiple match', () => {
    const file1 = makeFile({ name: 'photo1.jpg' })
    const file2 = makeFile({ name: 'photo2.jpg' })
    const file3 = makeFile({ name: 'document.pdf' })
    const state = makeStoreState([file1, file2, file3])
    const results = searchAllItems('photo', state, 'Files')
    expect(results).toHaveLength(2)
  })

  it('skips non-file items (verse type)', () => {
    const verseItem: AnyItemRecord = {
      id: crypto.randomUUID(),
      parentId: 'file-root',
      type: 'verse',
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null,
      versionId: 1,
      bookNumber: 1,
      chapter: 1,
      verse: 1,
      text: 'photo verse text'
    }
    const state = makeStoreState([verseItem])
    const results = searchAllItems('photo', state, 'Files')
    expect(results).toHaveLength(0)
  })

  it('limits results to 20 items', () => {
    const files = Array.from({ length: 25 }, (_, i) =>
      makeFile({ id: `file-${i}`, name: `photo-${i}.jpg` })
    )
    const state = makeStoreState(files)
    const results = searchAllItems('photo', state, 'Files')
    expect(results).toHaveLength(20)
  })

  it('includes folderPath in results', () => {
    const subfolder = makeFolder({ id: 'sub-1', name: 'Vacation', parentId: 'file-root' })
    const file = makeFile({ name: 'beach.jpg', parentId: 'sub-1' })
    const state = makeStoreState([file], [subfolder])
    state.getFolderPath = vi.fn().mockReturnValue([subfolder])

    const results = searchAllItems('beach', state, 'Files')
    expect(results).toHaveLength(1)
    expect(results[0].folderPath).toContain('Files')
    expect(results[0].folderPath).toContain('Vacation')
  })

  it('returns empty array when no items match', () => {
    const file = makeFile({ name: 'photo.jpg' })
    const state = makeStoreState([file])
    expect(searchAllItems('xyz-no-match', state, 'Files')).toEqual([])
  })

  it('returns empty array when store has no items', () => {
    const state = makeStoreState([])
    expect(searchAllItems('anything', state, 'Files')).toEqual([])
  })

  it('matches partial name substrings', () => {
    const file = makeFile({ name: 'annual-report-2024.pdf' })
    const state = makeStoreState([file])
    expect(searchAllItems('report', state, 'Files')).toHaveLength(1)
    expect(searchAllItems('2024', state, 'Files')).toHaveLength(1)
    expect(searchAllItems('annual', state, 'Files')).toHaveLength(1)
  })
})
