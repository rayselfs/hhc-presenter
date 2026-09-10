import { act, renderHook } from '@testing-library/react'
import {
  publishPersistedFileItem,
  useCurrentFolderDisplay,
  useFavoritesExplorerSettings,
  useFileExplorerStore,
  useFileExplorerSettings,
  useTrashExplorerSettings
} from '@renderer/stores/file-explorer'
import type { FileItemRecord } from '@shared/types/folder'

type AddFileItemData = Omit<FileItemRecord, 'id' | 'sortIndex' | 'createdAt' | 'expiresAt'> & {
  id?: string
  expiresAt?: number | null
}

function addFileItem(data: AddFileItemData): void {
  useFileExplorerStore.getState().addItem(data)
}

vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: vi.fn().mockResolvedValue({}),
  storeFileBlob: vi.fn().mockResolvedValue(undefined),
  getFileBlob: vi.fn().mockResolvedValue(null),
  deleteFileBlob: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@renderer/lib/folder-db', () => ({
  createFolderDB: vi.fn(() => ({
    loadAllFolders: vi.fn().mockResolvedValue([]),
    saveFolder: vi.fn().mockResolvedValue(undefined),
    saveFolders: vi.fn().mockResolvedValue(undefined),
    deleteFolders: vi.fn().mockResolvedValue(undefined),
    loadItemsByParent: vi.fn().mockResolvedValue([]),
    saveItem: vi.fn().mockResolvedValue(undefined),
    saveItems: vi.fn().mockResolvedValue(undefined),
    deleteItem: vi.fn().mockResolvedValue(undefined),
    deleteItems: vi.fn().mockResolvedValue(undefined),
    deleteItemsByParent: vi.fn().mockResolvedValue(undefined),
    deleteExpiredFolders: vi.fn().mockResolvedValue([]),
    deleteExpiredItems: vi.fn().mockResolvedValue([]),
    purgeTrashOlderThan: vi.fn().mockResolvedValue({ folderIds: [], itemIds: [] })
  }))
}))

vi.mock('@renderer/lib/persist-storage', () => ({
  hhcPersistStorage: {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn()
  },
  createPersistName: vi.fn((name: string) => `hhc-${name}`)
}))

const initialStoreState = {
  folders: {},
  items: {},
  _foldersArray: [],
  _itemsArray: [],
  _childFoldersByParent: {},
  _itemsByParent: {},
  loadedParents: new Set<string>(),
  currentFolderId: 'file-root',
  isLoading: true,
  isInitialized: false,
  persistenceStatus: 'initializing' as const,
  persistenceError: null,
  pendingPersistenceCount: 0
}

describe.each([
  ['files', useFileExplorerSettings],
  ['favorites', useFavoritesExplorerSettings],
  ['trash', useTrashExplorerSettings]
] as const)('%s explorer settings', (_name, store) => {
  it('migrates only the legacy Created column width', async () => {
    const options = store.persist.getOptions()
    const migrate = options.migrate

    expect(options.version).toBe(5)
    await expect(
      Promise.resolve(
        migrate?.({ colWidths: { created: 112, size: 80, kind: 96 }, marker: true }, 0)
      )
    ).resolves.toEqual({
      colWidths: { created: 160, size: 80, kind: 96 },
      marker: true,
      folderDisplay: {}
    })
    await expect(
      Promise.resolve(
        migrate?.({ colWidths: { created: 180, size: 80, kind: 96 }, marker: true }, 1)
      )
    ).resolves.toEqual({
      colWidths: { created: 180, size: 80, kind: 96 },
      marker: true,
      folderDisplay: {}
    })
  })
})

describe('useFileExplorerStore', () => {
  beforeEach(() => {
    useFileExplorerStore.setState(initialStoreState)
  })

  it('has correct initial state', () => {
    const state = useFileExplorerStore.getState()
    expect(state.currentFolderId).toBe('file-root')
    expect(state.folders).toEqual({})
    expect(state.items).toEqual({})
    expect(state.isLoading).toBe(true)
  })

  describe('addFolder', () => {
    it('adds a folder to state', () => {
      const id = useFileExplorerStore.getState().addFolder('My Folder', 'file-root')
      const state = useFileExplorerStore.getState()
      expect(state.folders[id]).toBeDefined()
      expect(state.folders[id].name).toBe('My Folder')
      expect(state.folders[id].parentId).toBe('file-root')
    })

    it('returns the new folder id', () => {
      const id = useFileExplorerStore.getState().addFolder('Test')
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    it('adds folder to _foldersArray', () => {
      useFileExplorerStore.getState().addFolder('Folder A', 'file-root')
      const { _foldersArray } = useFileExplorerStore.getState()
      expect(_foldersArray).toHaveLength(1)
      expect(_foldersArray[0].name).toBe('Folder A')
    })
  })

  describe('deleteFolder', () => {
    it('removes a folder from state', () => {
      const id = useFileExplorerStore.getState().addFolder('To Delete', 'file-root')
      useFileExplorerStore.getState().deleteFolder(id)
      const state = useFileExplorerStore.getState()
      expect(state.folders[id]).toBeUndefined()
    })

    it('does not remove root folder', () => {
      useFileExplorerStore.setState({
        folders: {
          'file-root': {
            id: 'file-root',
            name: 'Files',
            parentId: null,
            sortIndex: 0,
            createdAt: Date.now(),
            expiresAt: null
          }
        },
        _foldersArray: [
          {
            id: 'file-root',
            name: 'Files',
            parentId: null,
            sortIndex: 0,
            createdAt: Date.now(),
            expiresAt: null
          }
        ]
      })
      useFileExplorerStore.getState().deleteFolder('file-root')
      expect(useFileExplorerStore.getState().folders['file-root']).toBeDefined()
    })
  })

  describe('addItem', () => {
    it('adds an item to state', () => {
      addFileItem({
        parentId: 'file-root',
        type: 'file',
        name: 'photo.jpg',
        url: 'blob:abc',
        size: 1024,
        mimeType: 'image/jpeg'
      })
      const { _itemsArray } = useFileExplorerStore.getState()
      expect(_itemsArray).toHaveLength(1)
      const item = _itemsArray[0] as FileItemRecord
      expect(item.name).toBe('photo.jpg')
    })

    it('assigns a generated id if none provided', () => {
      addFileItem({
        parentId: 'file-root',
        type: 'file',
        name: 'doc.pdf',
        url: 'blob:xyz',
        size: 512,
        mimeType: 'application/pdf'
      })
      const { _itemsArray } = useFileExplorerStore.getState()
      expect(_itemsArray[0].id).toBeTruthy()
    })

    it('publishes an already-persisted item without scheduling another write', () => {
      const item: FileItemRecord = {
        id: 'persisted-item',
        parentId: 'file-root',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: 'Sunday.lpdeck',
        url: 'blob:persisted-item',
        size: 10,
        mimeType: 'application/x-hhc-presentation+json'
      }

      publishPersistedFileItem(item)

      expect(useFileExplorerStore.getState().items[item.id]).toEqual(item)
      expect(useFileExplorerStore.getState()._itemsByParent['file-root']).toEqual([item])
      expect(useFileExplorerStore.getState().pendingPersistenceCount).toBe(0)
    })
  })

  describe('removeItem', () => {
    it('removes an item from state', () => {
      addFileItem({
        parentId: 'file-root',
        type: 'file',
        name: 'remove-me.txt',
        url: 'blob:1',
        size: 100,
        mimeType: 'text/plain'
      })
      const { _itemsArray } = useFileExplorerStore.getState()
      const itemId = _itemsArray[0].id
      useFileExplorerStore.getState().removeItem(itemId)
      expect(useFileExplorerStore.getState().items[itemId]).toBeUndefined()
      expect(useFileExplorerStore.getState()._itemsArray).toHaveLength(0)
    })
  })

  describe('navigateToFolder / setCurrentFolder', () => {
    it('navigateToRoot resets to file-root', () => {
      useFileExplorerStore.setState({ currentFolderId: 'some-folder' })
      useFileExplorerStore.getState().navigateToRoot()
      expect(useFileExplorerStore.getState().currentFolderId).toBe('file-root')
    })

    it('navigateToFolder sets currentFolderId when folder exists', async () => {
      const id = useFileExplorerStore.getState().addFolder('Sub', 'file-root')
      await useFileExplorerStore.getState().navigateToFolder(id)
      expect(useFileExplorerStore.getState().currentFolderId).toBe(id)
    })

    it('navigateToFolder does nothing when folder does not exist', async () => {
      useFileExplorerStore.setState({ currentFolderId: 'file-root' })
      await useFileExplorerStore.getState().navigateToFolder('nonexistent')
      expect(useFileExplorerStore.getState().currentFolderId).toBe('file-root')
    })
  })

  describe('getChildFolders', () => {
    it('returns folders with matching parentId', () => {
      useFileExplorerStore.getState().addFolder('Child A', 'file-root')
      useFileExplorerStore.getState().addFolder('Child B', 'file-root')
      const children = useFileExplorerStore.getState().getChildFolders('file-root')
      expect(children).toHaveLength(2)
    })
  })

  describe('getItems', () => {
    it('returns items with matching parentId', () => {
      addFileItem({
        parentId: 'file-root',
        type: 'file',
        name: 'a.txt',
        url: 'blob:a',
        size: 1,
        mimeType: 'text/plain'
      })
      const items = useFileExplorerStore.getState().getItems('file-root')
      expect(items).toHaveLength(1)
      const item = items[0] as FileItemRecord
      expect(item.name).toBe('a.txt')
    })
  })
})

describe('useFileExplorerSettings', () => {
  beforeEach(() => {
    useFileExplorerSettings.setState({ viewMode: 'medium-icon', folderDisplay: {} })
  })

  it('has default viewMode of medium-icon', () => {
    expect(useFileExplorerSettings.getState().viewMode).toBe('medium-icon')
  })

  it('setViewMode updates viewMode', () => {
    useFileExplorerSettings.getState().setViewMode('list')
    expect(useFileExplorerSettings.getState().viewMode).toBe('list')
  })

  it('setViewMode accepts all valid modes', () => {
    const modes = ['large-icon', 'medium-icon', 'small-icon', 'list'] as const
    for (const mode of modes) {
      useFileExplorerSettings.getState().setViewMode(mode)
      expect(useFileExplorerSettings.getState().viewMode).toBe(mode)
    }
  })

  it('keeps a separate view mode for each folder', () => {
    useFileExplorerStore.setState({ currentFolderId: 'file-root' })
    const { result } = renderHook(() => useCurrentFolderDisplay())

    act(() => result.current.setViewMode('list'))
    expect(result.current.viewMode).toBe('list')

    act(() => useFileExplorerStore.setState({ currentFolderId: 'folder-a' }))
    expect(result.current.viewMode).toBe('medium-icon')

    act(() => result.current.setViewMode('extra-large-icon'))
    expect(result.current.viewMode).toBe('extra-large-icon')

    act(() => useFileExplorerStore.setState({ currentFolderId: 'file-root' }))
    expect(result.current.viewMode).toBe('list')
  })
})
