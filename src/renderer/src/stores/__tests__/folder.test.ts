import { copyBibleFolder } from '@renderer/lib/bible-folder-copy'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockLoadAllFolders = vi.fn()
const mockLoadItemsByParent = vi.fn()
const mockSaveFolder = vi.fn()
const mockSaveFolders = vi.fn()
const mockDeleteFolders = vi.fn()
const mockSaveItem = vi.fn()
const mockSaveItems = vi.fn()
const mockDeleteItem = vi.fn()
const mockDeleteItems = vi.fn()
const mockDeleteItemsByParent = vi.fn()
const mockDeleteExpiredFolders = vi.fn()
const mockDeleteExpiredItems = vi.fn()
const mockPurgeTrashOlderThan = vi.fn()

vi.mock('@renderer/lib/folder-db', () => ({
  createFolderDB: () => ({
    loadAllFolders: (...args: unknown[]) => mockLoadAllFolders(...args),
    loadItemsByParent: (...args: unknown[]) => mockLoadItemsByParent(...args),
    saveFolder: (...args: unknown[]) => mockSaveFolder(...args),
    saveFolders: (...args: unknown[]) => mockSaveFolders(...args),
    deleteFolders: (...args: unknown[]) => mockDeleteFolders(...args),
    saveItem: (...args: unknown[]) => mockSaveItem(...args),
    saveItems: (...args: unknown[]) => mockSaveItems(...args),
    deleteItem: (...args: unknown[]) => mockDeleteItem(...args),
    deleteItems: (...args: unknown[]) => mockDeleteItems(...args),
    deleteItemsByParent: (...args: unknown[]) => mockDeleteItemsByParent(...args),
    deleteExpiredFolders: (...args: unknown[]) => mockDeleteExpiredFolders(...args),
    deleteExpiredItems: (...args: unknown[]) => mockDeleteExpiredItems(...args),
    purgeTrashOlderThan: (...args: unknown[]) => mockPurgeTrashOlderThan(...args)
  })
}))

vi.mock('@renderer/lib/bible-db', () => ({
  openBibleDB: vi.fn()
}))

import { useBibleFolderStore } from '@renderer/stores/folder'
import type { FolderRecord, VerseItemRecord } from '@shared/types/folder'

const ROOT_ID = 'bible-root'

const rootFolder: FolderRecord = {
  id: ROOT_ID,
  name: 'Bible Library',
  parentId: null,
  sortIndex: 0,
  createdAt: Date.now(),
  expiresAt: null
}

const makeVerse = (id: string): Omit<VerseItemRecord, 'id' | 'sortIndex' | 'createdAt'> => ({
  type: 'verse',
  parentId: ROOT_ID,
  versionId: 1,
  bookNumber: 1,
  chapter: 1,
  verse: 1,
  text: `Verse ${id}`,
  expiresAt: null
})

const makeSyncedFolder = (id = 'synced-folder', parentId = ROOT_ID): FolderRecord => ({
  id,
  name: 'Synced Folder',
  parentId,
  sortIndex: 0,
  createdAt: Date.now(),
  expiresAt: null,
  syncLink: {
    providerConnectionId: 'connection-1',
    remoteFolderId: 'remote-folder-1',
    providerType: 'onedrive',
    offlinePolicy: 'on-demand'
  }
})

function addFolderRecord(folder: FolderRecord): void {
  useBibleFolderStore.setState((state) => ({
    folders: { ...state.folders, [folder.id]: folder },
    _foldersArray: [...state._foldersArray, folder],
    _childFoldersByParent:
      folder.parentId === null
        ? state._childFoldersByParent
        : {
            ...state._childFoldersByParent,
            [folder.parentId]: [...(state._childFoldersByParent[folder.parentId] ?? []), folder]
          }
  }))
}

function addVerseRecord(item: VerseItemRecord): void {
  useBibleFolderStore.setState((state) => ({
    items: { ...state.items, [item.id]: item },
    _itemsArray: [...state._itemsArray, item],
    _itemsByParent: {
      ...state._itemsByParent,
      [item.parentId]: [...(state._itemsByParent[item.parentId] ?? []), item]
    }
  }))
}

function makeVerseRecord(id: string, parentId = ROOT_ID, sortIndex = 0): VerseItemRecord {
  return {
    ...makeVerse(id),
    id,
    parentId,
    sortIndex,
    createdAt: Date.now()
  }
}

beforeEach(() => {
  useBibleFolderStore.setState({
    folders: { [ROOT_ID]: rootFolder },
    items: {},
    _foldersArray: [rootFolder],
    _itemsArray: [],
    _childFoldersByParent: {},
    _itemsByParent: {},
    loadedParents: new Set([ROOT_ID]),
    currentFolderId: ROOT_ID,
    isLoading: false,
    isInitialized: false,
    persistenceStatus: 'initializing',
    persistenceError: null,
    pendingPersistenceCount: 0
  })
  vi.clearAllMocks()
  mockSaveFolder.mockResolvedValue(undefined)
  mockSaveFolders.mockResolvedValue(undefined)
  mockDeleteFolders.mockResolvedValue(undefined)
  mockSaveItem.mockResolvedValue(undefined)
  mockSaveItems.mockResolvedValue(undefined)
  mockDeleteItem.mockResolvedValue(undefined)
  mockDeleteItems.mockResolvedValue(undefined)
  mockLoadAllFolders.mockResolvedValue([rootFolder])
  mockLoadItemsByParent.mockResolvedValue([])
  mockPurgeTrashOlderThan.mockResolvedValue({ folderIds: [], itemIds: [] })
})

describe('initialize()', () => {
  beforeEach(() => {
    // Reset store so the idempotent guard (checks _foldersArray.length) doesn't short-circuit
    useBibleFolderStore.setState({ _foldersArray: [], folders: {} })
  })

  it('loads stored folders when available', async () => {
    const childFolder: FolderRecord = {
      id: 'f1',
      name: 'Folder One',
      parentId: ROOT_ID,
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    }
    mockLoadAllFolders.mockResolvedValue([rootFolder, childFolder])
    await useBibleFolderStore.getState().initialize()
    const { folders } = useBibleFolderStore.getState()
    expect(folders['f1']).toBeDefined()
    expect(folders['f1'].name).toBe('Folder One')
  })

  it('creates fresh root and persists when no stored folders', async () => {
    mockLoadAllFolders.mockResolvedValue([])
    await useBibleFolderStore.getState().initialize()
    expect(useBibleFolderStore.getState().folders[ROOT_ID]).toBeDefined()
    expect(mockSaveFolder).toHaveBeenCalled()
  })

  it('loads root items on initialize', async () => {
    mockLoadAllFolders.mockResolvedValue([rootFolder])
    mockLoadItemsByParent.mockResolvedValue([])
    await useBibleFolderStore.getState().initialize()
    expect(mockLoadItemsByParent).toHaveBeenCalledWith(ROOT_ID)
  })

  it('sets isLoading false after completion', async () => {
    await useBibleFolderStore.getState().initialize()
    expect(useBibleFolderStore.getState().isLoading).toBe(false)
  })

  it('keeps initialization failures visible and retries without fabricating an empty root', async () => {
    mockLoadAllFolders.mockRejectedValueOnce(new Error('indexeddb unavailable'))

    await useBibleFolderStore.getState().initialize()

    expect(useBibleFolderStore.getState()).toMatchObject({
      folders: {},
      isInitialized: false,
      isLoading: false,
      persistenceStatus: 'degraded',
      persistenceError: 'indexeddb unavailable'
    })
    expect(mockSaveFolder).not.toHaveBeenCalled()

    mockLoadAllFolders.mockResolvedValueOnce([])
    await useBibleFolderStore.getState().retryInitialization()

    expect(useBibleFolderStore.getState()).toMatchObject({
      isInitialized: true,
      persistenceStatus: 'ready',
      persistenceError: null
    })
    expect(useBibleFolderStore.getState().folders[ROOT_ID]).toBeDefined()
    expect(mockSaveFolder).toHaveBeenCalledOnce()
  })
})

describe('ensureItemsLoaded()', () => {
  it('shares one database request between concurrent loads for the same folder', async () => {
    let resolveLoad: (items: VerseItemRecord[]) => void = () => {}
    mockLoadItemsByParent.mockImplementation(
      () =>
        new Promise<VerseItemRecord[]>((resolve) => {
          resolveLoad = resolve
        })
    )

    const firstLoad = useBibleFolderStore.getState().ensureItemsLoaded('folder-1')
    const secondLoad = useBibleFolderStore.getState().ensureItemsLoaded('folder-1')

    expect(mockLoadItemsByParent).toHaveBeenCalledOnce()

    resolveLoad([])
    await Promise.all([firstLoad, secondLoad])
    expect(useBibleFolderStore.getState().loadedParents.has('folder-1')).toBe(true)
  })

  it('keeps a failed parent load retryable and reports the read failure', async () => {
    mockLoadItemsByParent.mockRejectedValueOnce(new Error('read failed'))

    await expect(useBibleFolderStore.getState().ensureItemsLoaded('folder-1')).rejects.toThrow(
      'read failed'
    )

    expect(useBibleFolderStore.getState()).toMatchObject({
      persistenceStatus: 'degraded',
      persistenceError: 'read failed'
    })
    expect(useBibleFolderStore.getState().loadedParents.has('folder-1')).toBe(false)

    mockLoadItemsByParent.mockResolvedValueOnce([])
    await useBibleFolderStore.getState().ensureItemsLoaded('folder-1')

    expect(useBibleFolderStore.getState().loadedParents.has('folder-1')).toBe(true)
  })
})

describe('addFolder()', () => {
  it('creates a new folder at root level', () => {
    useBibleFolderStore.getState().addFolder('My Folder')
    const childFolders = useBibleFolderStore.getState().getChildFolders(ROOT_ID)
    expect(childFolders).toHaveLength(1)
    expect(childFolders[0].name).toBe('My Folder')
    expect(childFolders[0].parentId).toBe(ROOT_ID)
  })

  it('assigns unique id to new folder', () => {
    useBibleFolderStore.getState().addFolder('A')
    useBibleFolderStore.getState().addFolder('B')
    const childFolders = useBibleFolderStore.getState().getChildFolders(ROOT_ID)
    expect(childFolders[0].id).not.toBe(childFolders[1].id)
  })

  it('persists after adding folder', () => {
    useBibleFolderStore.getState().addFolder('Test')
    expect(mockSaveFolder).toHaveBeenCalled()
  })

  it('does not use soft-deleted folders when resolving a new folder name', () => {
    const firstId = useBibleFolderStore.getState().addFolder('Sunday')
    useBibleFolderStore.getState().softDeleteFolder(firstId)

    const secondId = useBibleFolderStore.getState().addFolder('Sunday')
    const activeFolders = useBibleFolderStore.getState().getChildFolders(ROOT_ID)

    expect(activeFolders).toHaveLength(1)
    expect(activeFolders[0].id).toBe(secondId)
    expect(activeFolders[0].name).toBe('Sunday')
  })

  it('does not create folders inside read-only sync folders', () => {
    const synced = makeSyncedFolder()
    addFolderRecord(synced)
    mockSaveFolder.mockClear()

    const id = useBibleFolderStore.getState().addFolder('Blocked', synced.id)

    expect(id).toBe('')
    expect(useBibleFolderStore.getState().getChildFolders(synced.id)).toHaveLength(0)
    expect(mockSaveFolder).not.toHaveBeenCalled()
  })
})

describe('updateFolder()', () => {
  it('renames an existing folder', () => {
    useBibleFolderStore.getState().addFolder('Old Name')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    useBibleFolderStore.getState().updateFolder(folderId, { name: 'New Name' })
    expect(useBibleFolderStore.getState().folders[folderId].name).toBe('New Name')
  })

  it('does not rename root folder', () => {
    useBibleFolderStore.getState().updateFolder(ROOT_ID, { name: 'Hacked' })
    expect(useBibleFolderStore.getState().folders[ROOT_ID].name).toBe('Bible Library')
  })

  it('persists after rename', async () => {
    useBibleFolderStore.getState().addFolder('X')
    await vi.waitFor(() => expect(useBibleFolderStore.getState().pendingPersistenceCount).toBe(0))
    mockSaveFolder.mockClear()
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    useBibleFolderStore.getState().updateFolder(folderId, { name: 'Y' })
    await vi.waitFor(() => expect(mockSaveFolder).toHaveBeenCalled())
  })

  it('does not rename read-only sync folders or descendants', () => {
    const synced = makeSyncedFolder()
    const child = makeSyncedFolder('synced-child', synced.id)
    child.syncLink = undefined
    addFolderRecord(synced)
    addFolderRecord(child)
    mockSaveFolder.mockClear()

    useBibleFolderStore.getState().updateFolder(child.id, { name: 'Blocked Rename' })

    expect(useBibleFolderStore.getState().folders[child.id].name).toBe('Synced Folder')
    expect(mockSaveFolder).not.toHaveBeenCalled()
  })

  it('retains failed folder writes and retries them before later writes', async () => {
    mockSaveFolder.mockRejectedValueOnce(new Error('quota exceeded'))

    const folderId = useBibleFolderStore.getState().addFolder('Before')
    useBibleFolderStore.getState().updateFolder(folderId, { name: 'After' })

    await vi.waitFor(() =>
      expect(useBibleFolderStore.getState().persistenceStatus).toBe('degraded')
    )
    expect(useBibleFolderStore.getState()).toMatchObject({
      persistenceError: 'quota exceeded',
      pendingPersistenceCount: 2
    })

    mockSaveFolder.mockResolvedValue(undefined)
    await useBibleFolderStore.getState().retryPersistence()

    expect(useBibleFolderStore.getState()).toMatchObject({
      persistenceStatus: 'ready',
      persistenceError: null,
      pendingPersistenceCount: 0
    })
    expect(mockSaveFolder).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: folderId, name: 'After' })
    )
  })
})

describe('deleteFolder()', () => {
  it('removes folder by id', () => {
    useBibleFolderStore.getState().addFolder('Delete Me')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    useBibleFolderStore.getState().deleteFolder(folderId)
    expect(useBibleFolderStore.getState().folders[folderId]).toBeUndefined()
  })

  it('does not delete root folder', () => {
    useBibleFolderStore.getState().deleteFolder(ROOT_ID)
    expect(useBibleFolderStore.getState().folders[ROOT_ID]).toBeDefined()
    expect(useBibleFolderStore.getState().folders[ROOT_ID].id).toBe(ROOT_ID)
  })

  it('resets currentFolderId to root when deleting current folder', async () => {
    useBibleFolderStore.getState().addFolder('Nav Folder')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    await useBibleFolderStore.getState().navigateToFolder(folderId)
    expect(useBibleFolderStore.getState().currentFolderId).toBe(folderId)
    useBibleFolderStore.getState().deleteFolder(folderId)
    expect(useBibleFolderStore.getState().currentFolderId).toBe(ROOT_ID)
  })

  it('does not hard delete read-only sync folders', () => {
    const synced = makeSyncedFolder()
    addFolderRecord(synced)
    mockDeleteFolders.mockClear()

    useBibleFolderStore.getState().deleteFolder(synced.id)

    expect(useBibleFolderStore.getState().folders[synced.id]).toBeDefined()
    expect(mockDeleteFolders).not.toHaveBeenCalled()
  })
})

describe('addItem()', () => {
  it('adds item to root by default (via parentId)', () => {
    useBibleFolderStore.getState().addItem(makeVerse('v1'))
    const rootItems = useBibleFolderStore.getState().getItems(ROOT_ID)
    expect(rootItems).toHaveLength(1)
  })

  it('adds item to specified folder via parentId field', () => {
    useBibleFolderStore.getState().addFolder('Sub')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    useBibleFolderStore.getState().addItem({ ...makeVerse('v2'), parentId: folderId })
    expect(useBibleFolderStore.getState().getItems(folderId)).toHaveLength(1)
    expect(useBibleFolderStore.getState().getItems(ROOT_ID)).toHaveLength(0)
  })

  it('assigns sortIndex based on position', () => {
    useBibleFolderStore.getState().addItem(makeVerse('v1'))
    useBibleFolderStore.getState().addItem(makeVerse('v2'))
    const items = useBibleFolderStore.getState().getItems(ROOT_ID)
    expect(items[0].sortIndex).toBe(0)
    expect(items[1].sortIndex).toBe(1)
  })

  it('persists after adding item', () => {
    useBibleFolderStore.getState().addItem(makeVerse('v1'))
    expect(mockSaveItem).toHaveBeenCalled()
  })

  it('does not add items inside read-only sync folders', () => {
    const synced = makeSyncedFolder()
    addFolderRecord(synced)
    mockSaveItem.mockClear()

    useBibleFolderStore.getState().addItem({ ...makeVerse('blocked'), parentId: synced.id })

    expect(useBibleFolderStore.getState().getItems(synced.id)).toHaveLength(0)
    expect(mockSaveItem).not.toHaveBeenCalled()
  })
})

describe('removeItem()', () => {
  it('removes item by id from root', () => {
    useBibleFolderStore.getState().addItem(makeVerse('v1'))
    useBibleFolderStore.getState().addItem(makeVerse('v2'))
    const rootItems = useBibleFolderStore.getState().getItems(ROOT_ID)
    const firstId = rootItems[0].id
    const secondId = rootItems[1].id
    useBibleFolderStore.getState().removeItem(firstId)
    const remaining = useBibleFolderStore.getState().getItems(ROOT_ID)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(secondId)
  })

  it('removes item from nested folder', () => {
    useBibleFolderStore.getState().addFolder('Sub')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    useBibleFolderStore.getState().addItem({ ...makeVerse('nested'), parentId: folderId })
    const nestedId = useBibleFolderStore.getState().getItems(folderId)[0].id
    useBibleFolderStore.getState().removeItem(nestedId)
    expect(useBibleFolderStore.getState().getItems(folderId)).toHaveLength(0)
  })

  it('does not remove items from read-only sync folders', () => {
    const synced = makeSyncedFolder()
    addFolderRecord(synced)
    const item = makeVerseRecord('synced-item', synced.id)
    addVerseRecord(item)
    mockDeleteItem.mockClear()

    useBibleFolderStore.getState().removeItem(item.id)

    expect(useBibleFolderStore.getState().items[item.id]).toBeDefined()
    expect(mockDeleteItem).not.toHaveBeenCalled()
  })
})

describe('moveItem()', () => {
  it('moves item from root to a subfolder', () => {
    useBibleFolderStore.getState().addItem(makeVerse('v1'))
    useBibleFolderStore.getState().addFolder('Target')
    const targetId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    const itemId = useBibleFolderStore.getState().getItems(ROOT_ID)[0].id
    useBibleFolderStore.getState().moveItem(itemId, targetId)
    expect(useBibleFolderStore.getState().getItems(ROOT_ID)).toHaveLength(0)
    expect(useBibleFolderStore.getState().getItems(targetId)).toHaveLength(1)
    expect(useBibleFolderStore.getState().getItems(targetId)[0].id).toBe(itemId)
  })

  it('moves item from subfolder back to root', () => {
    useBibleFolderStore.getState().addFolder('Source')
    const sourceId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    useBibleFolderStore.getState().addItem({ ...makeVerse('v1'), parentId: sourceId })
    const itemId = useBibleFolderStore.getState().getItems(sourceId)[0].id
    useBibleFolderStore.getState().moveItem(itemId, ROOT_ID)
    expect(useBibleFolderStore.getState().getItems(sourceId)).toHaveLength(0)
    expect(useBibleFolderStore.getState().getItems(ROOT_ID)).toHaveLength(1)
  })

  it('is a no-op when itemId does not exist', () => {
    useBibleFolderStore.getState().addFolder('Target')
    const targetId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    mockSaveItem.mockClear()
    useBibleFolderStore.getState().moveItem('nonexistent', targetId)
    expect(mockSaveItem).not.toHaveBeenCalled()
  })

  it('does not move items into or out of read-only sync folders', () => {
    const synced = makeSyncedFolder()
    addFolderRecord(synced)
    useBibleFolderStore.getState().addItem(makeVerse('normal'))
    const syncedItem = makeVerseRecord('synced-item', synced.id)
    addVerseRecord(syncedItem)
    const normalItemId = useBibleFolderStore.getState().getItems(ROOT_ID)[0].id
    mockSaveItem.mockClear()

    useBibleFolderStore.getState().moveItem(normalItemId, synced.id)
    useBibleFolderStore.getState().moveItem(syncedItem.id, ROOT_ID)

    expect(useBibleFolderStore.getState().items[normalItemId].parentId).toBe(ROOT_ID)
    expect(useBibleFolderStore.getState().items[syncedItem.id].parentId).toBe(synced.id)
    expect(mockSaveItem).not.toHaveBeenCalled()
  })
})

describe('reorderItems()', () => {
  it('reorders items in a folder via orderedIds', () => {
    useBibleFolderStore.getState().addItem(makeVerse('a'))
    useBibleFolderStore.getState().addItem(makeVerse('b'))
    useBibleFolderStore.getState().addItem(makeVerse('c'))
    const [idA, idB, idC] = useBibleFolderStore
      .getState()
      .getItems(ROOT_ID)
      .map((i) => i.id)
    useBibleFolderStore.getState().reorderItems(ROOT_ID, [idC, idA, idB])
    const items = useBibleFolderStore.getState().getItems(ROOT_ID)
    expect(items[0].id).toBe(idC)
    expect(items[0].sortIndex).toBe(0)
    expect(items[1].id).toBe(idA)
    expect(items[1].sortIndex).toBe(1)
    expect(items[2].id).toBe(idB)
    expect(items[2].sortIndex).toBe(2)
  })

  it('persists after reorder', async () => {
    useBibleFolderStore.getState().addItem(makeVerse('a'))
    useBibleFolderStore.getState().addItem(makeVerse('b'))
    const [idA, idB] = useBibleFolderStore
      .getState()
      .getItems(ROOT_ID)
      .map((i) => i.id)
    await vi.waitFor(() => expect(useBibleFolderStore.getState().pendingPersistenceCount).toBe(0))
    mockSaveItems.mockClear()
    useBibleFolderStore.getState().reorderItems(ROOT_ID, [idB, idA])
    await vi.waitFor(() => expect(mockSaveItems).toHaveBeenCalled())
  })

  it('does not reorder items inside read-only sync folders', () => {
    const synced = makeSyncedFolder()
    addFolderRecord(synced)
    addVerseRecord(makeVerseRecord('synced-a', synced.id, 0))
    addVerseRecord(makeVerseRecord('synced-b', synced.id, 1))
    const [idA, idB] = useBibleFolderStore
      .getState()
      .getItems(synced.id)
      .map((i) => i.id)
    mockSaveItems.mockClear()

    useBibleFolderStore.getState().reorderItems(synced.id, [idB, idA])

    expect(
      useBibleFolderStore
        .getState()
        .getItems(synced.id)
        .map((i) => i.id)
    ).toEqual([idA, idB])
    expect(mockSaveItems).not.toHaveBeenCalled()
  })
})

describe('read-only sync folder mutations', () => {
  it('does not update items inside read-only sync folders', () => {
    const synced = makeSyncedFolder()
    addFolderRecord(synced)
    const item = makeVerseRecord('synced-update', synced.id)
    addVerseRecord(item)
    mockSaveItem.mockClear()

    useBibleFolderStore.getState().updateItem?.(item.id, { text: 'blocked' })

    expect((useBibleFolderStore.getState().items[item.id] as VerseItemRecord).text).toBe(
      'Verse synced-update'
    )
    expect(mockSaveItem).not.toHaveBeenCalled()
  })

  it('does not move folders into or out of read-only sync folders', () => {
    const synced = makeSyncedFolder()
    const normal = {
      ...makeSyncedFolder('normal-folder'),
      name: 'Normal',
      syncLink: undefined
    }
    const syncedChild = {
      ...makeSyncedFolder('synced-child', synced.id),
      syncLink: undefined
    }
    addFolderRecord(synced)
    addFolderRecord(normal)
    addFolderRecord(syncedChild)
    mockSaveFolder.mockClear()

    useBibleFolderStore.getState().moveFolder(normal.id, synced.id)
    useBibleFolderStore.getState().moveFolder(syncedChild.id, ROOT_ID)

    expect(useBibleFolderStore.getState().folders[normal.id].parentId).toBe(ROOT_ID)
    expect(useBibleFolderStore.getState().folders[syncedChild.id].parentId).toBe(synced.id)
    expect(mockSaveFolder).not.toHaveBeenCalled()
  })

  it('does not reorder child folders inside read-only sync folders', () => {
    const synced = makeSyncedFolder()
    const first = {
      ...makeSyncedFolder('synced-child-a', synced.id),
      syncLink: undefined
    }
    const second = {
      ...makeSyncedFolder('synced-child-b', synced.id),
      sortIndex: 1,
      syncLink: undefined
    }
    addFolderRecord(synced)
    addFolderRecord(first)
    addFolderRecord(second)
    mockSaveFolders.mockClear()

    useBibleFolderStore.getState().reorderFolders(synced.id, [second.id, first.id])

    expect(
      useBibleFolderStore
        .getState()
        .getChildFolders(synced.id)
        .map((f) => f.id)
    ).toEqual([first.id, second.id])
    expect(mockSaveFolders).not.toHaveBeenCalled()
  })

  it('does not soft delete read-only sync folders or items', () => {
    const synced = makeSyncedFolder()
    addFolderRecord(synced)
    const item = makeVerseRecord('synced-soft-delete', synced.id)
    addVerseRecord(item)
    mockSaveFolder.mockClear()
    mockSaveItem.mockClear()

    useBibleFolderStore.getState().softDeleteFolder(synced.id)
    useBibleFolderStore.getState().softDeleteItem(item.id)

    expect(useBibleFolderStore.getState().folders[synced.id].deletedAt).toBeUndefined()
    expect(useBibleFolderStore.getState().items[item.id].deletedAt).toBeUndefined()
    expect(mockSaveFolder).not.toHaveBeenCalled()
    expect(mockSaveItem).not.toHaveBeenCalled()
  })

  it('hides soft-deleted items from active getters', () => {
    useBibleFolderStore.getState().addItem(makeVerse('v1'))
    const itemId = useBibleFolderStore.getState().getItems(ROOT_ID)[0].id

    useBibleFolderStore.getState().softDeleteItem(itemId)

    expect(useBibleFolderStore.getState().getItems(ROOT_ID)).toHaveLength(0)
  })
})

describe('navigateToFolder() / navigateUp() / navigateToRoot()', () => {
  it('navigateToFolder sets currentFolderId', async () => {
    useBibleFolderStore.getState().addFolder('Sub')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    await useBibleFolderStore.getState().navigateToFolder(folderId)
    expect(useBibleFolderStore.getState().currentFolderId).toBe(folderId)
  })

  it('navigateToFolder is a no-op for nonexistent folder', async () => {
    await useBibleFolderStore.getState().navigateToFolder('ghost-id')
    expect(useBibleFolderStore.getState().currentFolderId).toBe(ROOT_ID)
  })

  it('navigateToRoot returns to root', async () => {
    useBibleFolderStore.getState().addFolder('Sub')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    await useBibleFolderStore.getState().navigateToFolder(folderId)
    useBibleFolderStore.getState().navigateToRoot()
    expect(useBibleFolderStore.getState().currentFolderId).toBe(ROOT_ID)
  })

  it('navigateUp from subfolder goes to root (parent)', async () => {
    useBibleFolderStore.getState().addFolder('Sub')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    await useBibleFolderStore.getState().navigateToFolder(folderId)
    useBibleFolderStore.getState().navigateUp()
    expect(useBibleFolderStore.getState().currentFolderId).toBe(ROOT_ID)
  })

  it('navigateUp from root is a no-op', () => {
    useBibleFolderStore.getState().navigateUp()
    expect(useBibleFolderStore.getState().currentFolderId).toBe(ROOT_ID)
  })
})

describe('current folder via folders[currentFolderId]', () => {
  it('returns root when at root', () => {
    const { folders, currentFolderId } = useBibleFolderStore.getState()
    expect(folders[currentFolderId].id).toBe(ROOT_ID)
  })

  it('returns correct subfolder when navigated', async () => {
    useBibleFolderStore.getState().addFolder('Deep')
    const folderId = useBibleFolderStore.getState().getChildFolders(ROOT_ID)[0].id
    await useBibleFolderStore.getState().navigateToFolder(folderId)
    const { folders, currentFolderId } = useBibleFolderStore.getState()
    expect(folders[currentFolderId].id).toBe(folderId)
    expect(folders[currentFolderId].name).toBe('Deep')
  })
})

describe('getDescendantFolderIds (via deleteFolder cascade)', () => {
  it('returns all descendants in a 100-folder 3-level tree', () => {
    const level1Ids: string[] = []
    const level2Ids: string[] = []
    const level3Ids: string[] = []

    for (let i = 0; i < 10; i++) {
      const l1Id = useBibleFolderStore.getState().addFolder(`L1-${i}`)
      level1Ids.push(l1Id)
      for (let j = 0; j < 3; j++) {
        const l2Id = useBibleFolderStore.getState().addFolder(`L2-${i}-${j}`, l1Id)
        level2Ids.push(l2Id)
        for (let k = 0; k < 3; k++) {
          const l3Id = useBibleFolderStore.getState().addFolder(`L3-${i}-${j}-${k}`, l2Id)
          level3Ids.push(l3Id)
        }
      }
    }

    const targetL1 = level1Ids[0]
    useBibleFolderStore.getState().deleteFolder(targetL1)

    expect(useBibleFolderStore.getState().folders[targetL1]).toBeUndefined()

    const expectedDeletedL2 = level2Ids.slice(0, 3)
    const expectedDeletedL3 = level3Ids.slice(0, 9)
    for (const id of [...expectedDeletedL2, ...expectedDeletedL3]) {
      expect(useBibleFolderStore.getState().folders[id]).toBeUndefined()
    }

    for (const id of level1Ids.slice(1)) {
      expect(useBibleFolderStore.getState().folders[id]).toBeDefined()
    }
  })
})

describe('deleteFolder() — items in subfolder removed, sibling items preserved', () => {
  it('removes items in deleted subfolder but keeps items in sibling folder', () => {
    const targetId = useBibleFolderStore.getState().addFolder('Target')
    const siblingId = useBibleFolderStore.getState().addFolder('Sibling')

    useBibleFolderStore.getState().addItem({ ...makeVerse('in-target'), parentId: targetId })
    useBibleFolderStore.getState().addItem({ ...makeVerse('in-sibling'), parentId: siblingId })

    const targetItemId = useBibleFolderStore.getState().getItems(targetId)[0].id
    const siblingItemId = useBibleFolderStore.getState().getItems(siblingId)[0].id

    useBibleFolderStore.getState().deleteFolder(targetId)

    expect(useBibleFolderStore.getState().items[targetItemId]).toBeUndefined()
    expect(useBibleFolderStore.getState().items[siblingItemId]).toBeDefined()
  })

  it('removes items in nested subfolders when parent is deleted', () => {
    const parentId = useBibleFolderStore.getState().addFolder('Parent')
    const childId = useBibleFolderStore.getState().addFolder('Child', parentId)

    useBibleFolderStore.getState().addItem({ ...makeVerse('in-child'), parentId: childId })
    const childItemId = useBibleFolderStore.getState().getItems(childId)[0].id

    useBibleFolderStore.getState().deleteFolder(parentId)

    expect(useBibleFolderStore.getState().items[childItemId]).toBeUndefined()
  })
})

describe('purgeTrash() — correct items purged via Set lookup', () => {
  it('removes purged folder and its items from state', async () => {
    const deletedFolderId = 'deleted-folder-1'
    const deletedItemId = 'deleted-item-1'
    const survivingItemId = 'surviving-item-1'

    const deletedFolder: FolderRecord = {
      id: deletedFolderId,
      name: 'Deleted',
      parentId: ROOT_ID,
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null,
      deletedAt: Date.now() - 100000
    }

    useBibleFolderStore.setState((state) => ({
      folders: { ...state.folders, [deletedFolderId]: deletedFolder },
      _foldersArray: [...state._foldersArray, deletedFolder],
      items: {
        [deletedItemId]: {
          id: deletedItemId,
          type: 'verse' as const,
          parentId: deletedFolderId,
          sortIndex: 0,
          createdAt: Date.now(),
          expiresAt: null,
          versionId: 1,
          bookNumber: 1,
          chapter: 1,
          verse: 1,
          text: 'deleted verse'
        },
        [survivingItemId]: {
          id: survivingItemId,
          type: 'verse' as const,
          parentId: ROOT_ID,
          sortIndex: 0,
          createdAt: Date.now(),
          expiresAt: null,
          versionId: 1,
          bookNumber: 1,
          chapter: 1,
          verse: 1,
          text: 'surviving verse'
        }
      },
      _itemsArray: []
    }))

    mockPurgeTrashOlderThan.mockResolvedValue({
      folderIds: [deletedFolderId],
      itemIds: []
    })

    await useBibleFolderStore.getState().purgeTrash(86400000)

    expect(useBibleFolderStore.getState().folders[deletedFolderId]).toBeUndefined()
    expect(useBibleFolderStore.getState().items[deletedItemId]).toBeUndefined()
    expect(useBibleFolderStore.getState().items[survivingItemId]).toBeDefined()
  })
})

describe('Bible folder copy', () => {
  it.each(['source', 'child'])('rejects target %s before any write', async (target) => {
    addFolderRecord({ ...rootFolder, id: 'source', parentId: ROOT_ID })
    addFolderRecord({ ...rootFolder, id: 'child', parentId: 'source' })
    await expect(copyBibleFolder(useBibleFolderStore.getState, 'source', target)).rejects.toThrow(
      'Cannot copy a folder into itself'
    )
    expect(mockSaveFolder).not.toHaveBeenCalled()
    expect(mockSaveItem).not.toHaveBeenCalled()
  })

  it('loads a full snapshot and preserves nested expiry and unique names', async () => {
    addFolderRecord({
      ...rootFolder,
      id: 'source',
      name: 'Source',
      parentId: ROOT_ID,
      expiresAt: 100
    })
    addFolderRecord({
      ...rootFolder,
      id: 'child',
      name: 'Child',
      parentId: 'source',
      expiresAt: 200
    })
    const verse = { ...makeVerseRecord('verse', 'child'), expiresAt: 300 }
    mockLoadItemsByParent.mockImplementation(async (id: string) => (id === 'child' ? [verse] : []))
    const target = await copyBibleFolder(useBibleFolderStore.getState, 'source', ROOT_ID)
    const state = useBibleFolderStore.getState()
    expect(state.folders[target]).toMatchObject({ name: 'Source 2', expiresAt: 100 })
    const [child] = state.getChildFolders(target)
    expect(child).toMatchObject({ name: 'Child', expiresAt: 200 })
    const [copied] = state.getItems(child.id)
    expect(copied).toMatchObject({ text: verse.text, expiresAt: 300 })
    expect(copied.id).not.toBe(verse.id)
    expect(mockSaveItem).toHaveBeenCalledWith(copied)
    expect(state.pendingPersistenceCount).toBe(0)
  })

  it('does not create folders if a nested source fails to load', async () => {
    addFolderRecord({ ...rootFolder, id: 'source', parentId: ROOT_ID })
    addFolderRecord({ ...rootFolder, id: 'child', parentId: 'source' })
    mockLoadItemsByParent.mockImplementation(async (id: string) => {
      if (id === 'child') throw new Error('Read failed')
      return []
    })
    await expect(copyBibleFolder(useBibleFolderStore.getState, 'source', ROOT_ID)).rejects.toThrow(
      'Read failed'
    )
    expect(mockSaveFolder).not.toHaveBeenCalled()
  })

  it('rejects failed persistence and keeps queued operations available for retry', async () => {
    addFolderRecord({ ...rootFolder, id: 'source', parentId: ROOT_ID })
    addFolderRecord({ ...rootFolder, id: 'child', name: 'Child', parentId: 'source' })
    const verse = makeVerseRecord('verse', 'child')
    mockLoadItemsByParent.mockImplementation(async (id: string) => (id === 'child' ? [verse] : []))
    mockSaveFolder.mockRejectedValueOnce(new Error('Disk full'))
    await expect(copyBibleFolder(useBibleFolderStore.getState, 'source', ROOT_ID)).rejects.toThrow(
      'Disk full'
    )
    expect(useBibleFolderStore.getState().pendingPersistenceCount).toBe(3)
    const copiesBeforeRetry = Object.keys(useBibleFolderStore.getState().folders)
    await useBibleFolderStore.getState().retryPersistence()
    expect(useBibleFolderStore.getState().pendingPersistenceCount).toBe(0)
    expect(mockSaveFolder).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Child' }))
    expect(mockSaveItem).toHaveBeenCalledWith(expect.objectContaining({ text: verse.text }))
    expect(Object.keys(useBibleFolderStore.getState().folders)).toEqual(copiesBeforeRetry)
  })
})
