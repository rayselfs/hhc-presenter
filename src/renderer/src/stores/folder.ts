import { create } from 'zustand'
import type { FolderRecord, AnyItemRecord, FolderStoreConfig } from '@shared/types/folder'
import { FOLDER_DURATION_MS } from '@shared/types/folder'
import { createFolderDB } from '@renderer/lib/folder-db'
import { openBibleDB } from '@renderer/lib/bible-db'
import { commitLocalFileItem } from '@renderer/lib/file-catalog-mutations'
import { resolveUniqueName } from '@renderer/lib/file-naming'
import { isFolderReadOnlyBySyncLink } from '@renderer/lib/sync-readonly'
import { createPersistenceOperationQueue } from '@renderer/lib/persistence-operation-queue'

export type FolderPersistenceStatus = 'initializing' | 'ready' | 'saving' | 'degraded'

export interface FolderStoreState {
  folders: Record<string, FolderRecord>
  items: Record<string, AnyItemRecord>
  _foldersArray: FolderRecord[]
  _itemsArray: AnyItemRecord[]
  _childFoldersByParent: Record<string, FolderRecord[]>
  _itemsByParent: Record<string, AnyItemRecord[]>
  loadedParents: Set<string>
  currentFolderId: string
  isLoading: boolean
  isInitialized: boolean
  persistenceStatus: FolderPersistenceStatus
  persistenceError: string | null
  pendingPersistenceCount: number

  initialize: () => Promise<void>
  retryInitialization: () => Promise<void>
  retryPersistence: () => Promise<void>
  flushPersistence: () => Promise<void>
  addFolder: (name: string, parentId?: string, expiresAt?: number | null) => string
  updateFolder: (id: string, updates: { name?: string; expiresAt?: number | null }) => void
  updateItem?: (id: string, updates: Partial<AnyItemRecord>) => void
  deleteFolder: (id: string) => void
  addItem: (
    item: Omit<AnyItemRecord, 'id' | 'sortIndex' | 'createdAt' | 'expiresAt'> & {
      id?: string
      expiresAt?: number | null
    }
  ) => void
  removeItem: (id: string) => void
  moveItem: (itemId: string, targetFolderId: string) => void
  copyItem: (itemId: string, targetFolderId: string) => Promise<string | null>
  moveFolder: (folderId: string, targetFolderId: string) => void
  reorderItems: (parentId: string, orderedIds: string[]) => void
  reorderFolders: (parentId: string, orderedIds: string[]) => void
  navigateToFolder: (folderId: string) => Promise<void>
  navigateToRoot: () => void
  navigateUp: () => void
  cleanupExpired: () => Promise<void>
  softDeleteExpired: () => void
  ensureItemsLoaded: (parentId: string) => Promise<void>
  toggleFavorite: (folderId: string) => void
  softDeleteFolder: (folderId: string) => void
  softDeleteItem: (itemId: string) => void
  restoreFolder: (folderId: string) => void
  restoreItem: (itemId: string) => void
  purgeTrash: (retentionMs: number) => Promise<void>

  getChildFolders: (parentId: string) => FolderRecord[]
  getItems: (parentId: string) => AnyItemRecord[]
  getFolderPath: (folderId: string) => FolderRecord[]
  isItemsLoaded: (parentId: string) => boolean
}

function isFolderReadOnly(folderId: string, folders: Record<string, FolderRecord>): boolean {
  return (
    Boolean(folders[folderId]?.personalOwnerId) || isFolderReadOnlyBySyncLink(folderId, folders)
  )
}

function isItemInReadOnlyFolder(
  itemId: string,
  items: Record<string, AnyItemRecord>,
  folders: Record<string, FolderRecord>
): boolean {
  const item = items[itemId]
  return item ? isFolderReadOnly(item.parentId, folders) : false
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createFolderStore(config: FolderStoreConfig) {
  const ops = createFolderDB(config.getDB, config.rootId)
  const persistenceQueue = createPersistenceOperationQueue()
  let isInitializing = false
  const itemsLoadPromises = new Map<string, Promise<void>>()

  function sortByIndex<T extends { sortIndex: number }>(arr: T[]): T[] {
    return arr.slice().sort((a, b) => a.sortIndex - b.sortIndex)
  }

  const store = create<FolderStoreState>()((set, get) => ({
    folders: {},
    items: {},
    _foldersArray: [],
    _itemsArray: [],
    _childFoldersByParent: {},
    _itemsByParent: {},
    loadedParents: new Set<string>(),
    currentFolderId: config.rootId,
    isLoading: true,
    isInitialized: false,
    persistenceStatus: 'initializing',
    persistenceError: null,
    pendingPersistenceCount: 0,

    initialize: async () => {
      if (get().isInitialized || isInitializing) return
      isInitializing = true
      set({
        isLoading: true,
        persistenceStatus: 'initializing',
        persistenceError: null
      })
      try {
        const allFolders = await ops.loadAllFolders()
        const folderMap: Record<string, FolderRecord> = {}

        if (allFolders.length === 0) {
          const rootFolder: FolderRecord = {
            id: config.rootId,
            name: config.rootName,
            parentId: null,
            sortIndex: 0,
            createdAt: Date.now(),
            expiresAt: null
          }
          await ops.saveFolder(rootFolder)
          folderMap[config.rootId] = rootFolder
        } else {
          for (const f of allFolders) {
            folderMap[f.id] = f
          }
          if (!folderMap[config.rootId]) {
            const rootFolder: FolderRecord = {
              id: config.rootId,
              name: config.rootName,
              parentId: null,
              sortIndex: 0,
              createdAt: Date.now(),
              expiresAt: null
            }
            await ops.saveFolder(rootFolder)
            folderMap[config.rootId] = rootFolder
          }
        }

        const rootItems = (await ops.loadItemsByParent(config.rootId)).filter(
          (item) => config.isVisible?.(item) ?? true
        )
        for (const folder of Object.values(folderMap)) {
          if (config.isVisible && !config.isVisible(folder)) delete folderMap[folder.id]
        }
        const itemMap: Record<string, AnyItemRecord> = {}
        for (const item of rootItems) {
          itemMap[item.id] = item
        }

        const childFoldersByParent: Record<string, FolderRecord[]> = {}
        for (const f of Object.values(folderMap)) {
          if (f.parentId !== null) {
            const list = childFoldersByParent[f.parentId] ?? []
            list.push(f)
            childFoldersByParent[f.parentId] = list
          }
        }
        for (const key of Object.keys(childFoldersByParent)) {
          childFoldersByParent[key] = sortByIndex(childFoldersByParent[key])
        }

        set({
          folders: folderMap,
          items: itemMap,
          _foldersArray: Object.values(folderMap),
          _itemsArray: Object.values(itemMap),
          _childFoldersByParent: childFoldersByParent,
          _itemsByParent: { [config.rootId]: sortByIndex(rootItems) },
          loadedParents: new Set([config.rootId]),
          isLoading: false,
          isInitialized: true,
          persistenceStatus: 'ready',
          persistenceError: null
        })
      } catch (error) {
        set({
          isLoading: false,
          isInitialized: false,
          persistenceStatus: 'degraded',
          persistenceError: error instanceof Error ? error.message : String(error)
        })
      } finally {
        isInitializing = false
      }
    },

    retryInitialization: () => get().initialize(),
    retryPersistence: () => persistenceQueue.retry(),
    flushPersistence: () => persistenceQueue.flush(),

    ensureItemsLoaded: async (parentId: string) => {
      const { loadedParents } = get()
      if (loadedParents.has(parentId)) return
      const existingLoad = itemsLoadPromises.get(parentId)
      if (existingLoad) return existingLoad

      const loadPromise = ops
        .loadItemsByParent(parentId)
        .then((items) => {
          set((state) => {
            const newItems = { ...state.items }
            for (const item of items) {
              if (config.isVisible && !config.isVisible(item)) continue
              newItems[item.id] = item
            }
            const newLoaded = new Set(state.loadedParents)
            newLoaded.add(parentId)
            const forParent = Object.values(newItems).filter((i) => i.parentId === parentId)
            return {
              items: newItems,
              _itemsArray: Object.values(newItems),
              loadedParents: newLoaded,
              _itemsByParent: { ...state._itemsByParent, [parentId]: sortByIndex(forParent) }
            }
          })
          const queueSnapshot = persistenceQueue.snapshot()
          if (queueSnapshot.status !== 'failed') {
            set({
              persistenceStatus: queueSnapshot.status === 'saving' ? 'saving' : 'ready',
              persistenceError: null
            })
          }
        })
        .catch((error) => {
          set({
            persistenceStatus: 'degraded',
            persistenceError: error instanceof Error ? error.message : String(error)
          })
          throw error
        })
        .finally(() => {
          itemsLoadPromises.delete(parentId)
        })

      itemsLoadPromises.set(parentId, loadPromise)
      return loadPromise
    },

    addFolder: (name, parentId, expiresAt) => {
      const resolvedParentId = parentId ?? get().currentFolderId
      if (resolvedParentId !== config.rootId && !get().folders[resolvedParentId]) return ''
      if (isFolderReadOnly(resolvedParentId, get().folders)) return ''
      const siblings = get().getChildFolders(resolvedParentId)
      const resolvedName = resolveUniqueName(
        name,
        siblings.map((folder) => folder.name)
      )
      const newFolder: FolderRecord = {
        id: crypto.randomUUID(),
        name: resolvedName,
        parentId: resolvedParentId,
        sortIndex: siblings.length,
        createdAt: Date.now(),
        expiresAt:
          expiresAt !== undefined
            ? expiresAt
            : resolvedParentId === config.rootId
              ? Date.now() + FOLDER_DURATION_MS['1day']
              : (get().folders[resolvedParentId]?.expiresAt ?? null)
      }
      set((state) => ({
        folders: { ...state.folders, [newFolder.id]: newFolder },
        _foldersArray: [...state._foldersArray, newFolder],
        _childFoldersByParent: {
          ...state._childFoldersByParent,
          [resolvedParentId]: sortByIndex([
            ...(state._childFoldersByParent[resolvedParentId] ?? []),
            newFolder
          ])
        }
      }))
      persistenceQueue.enqueue(() => ops.saveFolder(newFolder))
      return newFolder.id
    },

    updateFolder: (id, updates) => {
      if (id === config.rootId) return
      const folder = get().folders[id]
      if (!folder) return
      if (isFolderReadOnly(id, get().folders)) return
      const updated = { ...folder, ...updates }
      set((state) => {
        const newFoldersArray = state._foldersArray.map((f) => (f.id === id ? updated : f))
        const newChildFolders = { ...state._childFoldersByParent }
        if (updated.parentId !== null) {
          newChildFolders[updated.parentId] = (newChildFolders[updated.parentId] ?? []).map((f) =>
            f.id === id ? updated : f
          )
        }
        return {
          folders: { ...state.folders, [id]: updated },
          _foldersArray: newFoldersArray,
          _childFoldersByParent: newChildFolders
        }
      })
      persistenceQueue.enqueue(() => ops.saveFolder(updated))
    },

    updateItem: (id, updates) => {
      const item = get().items[id]
      if (!item) return
      if (isFolderReadOnly(item.parentId, get().folders)) return
      if (updates.parentId && isFolderReadOnly(updates.parentId, get().folders)) return
      const updated = { ...item, ...updates } as AnyItemRecord
      set((state) => {
        const newItemsArray = state._itemsArray.map((entry) => (entry.id === id ? updated : entry))
        const newItemsByParent = item.parentId
          ? {
              ...state._itemsByParent,
              [item.parentId]: (state._itemsByParent[item.parentId] ?? []).map((i) =>
                i.id === id ? updated : i
              )
            }
          : state._itemsByParent
        return {
          items: { ...state.items, [id]: updated },
          _itemsArray: newItemsArray,
          _itemsByParent: newItemsByParent
        }
      })
      persistenceQueue.enqueue(() => ops.saveItem(updated))
    },

    deleteFolder: (id) => {
      if (id === config.rootId) return
      if (isFolderReadOnly(id, get().folders)) return
      const { folders, items, currentFolderId } = get()

      const descendantIds = getDescendantFolderIds(id, folders)
      const allFolderIds = [id, ...descendantIds]
      const folderIdSet = new Set(allFolderIds)

      const newFolders = { ...folders }
      for (const fid of allFolderIds) delete newFolders[fid]

      const itemIdsToDelete: string[] = []
      const newItems = Object.fromEntries(
        Object.entries(items).filter(([, item]) => {
          if (folderIdSet.has(item.parentId)) {
            itemIdsToDelete.push(item.id)
            return false
          }
          return true
        })
      )

      const nextCurrentId = allFolderIds.includes(currentFolderId) ? config.rootId : currentFolderId

      set((state) => {
        const newChildFoldersByParent: Record<string, FolderRecord[]> = {}
        for (const f of Object.values(newFolders)) {
          if (f.parentId !== null) {
            const list = newChildFoldersByParent[f.parentId] ?? []
            list.push(f)
            newChildFoldersByParent[f.parentId] = list
          }
        }
        for (const k of Object.keys(newChildFoldersByParent)) {
          newChildFoldersByParent[k] = sortByIndex(newChildFoldersByParent[k])
        }
        const newLoadedParents = new Set<string>()
        const newItemsByParent: Record<string, AnyItemRecord[]> = {}
        for (const parentId of state.loadedParents) {
          if (folderIdSet.has(parentId)) continue
          newLoadedParents.add(parentId)
          newItemsByParent[parentId] = sortByIndex(
            Object.values(newItems).filter((i) => i.parentId === parentId)
          )
        }
        return {
          folders: newFolders,
          items: newItems,
          _foldersArray: Object.values(newFolders),
          _itemsArray: Object.values(newItems),
          _childFoldersByParent: newChildFoldersByParent,
          _itemsByParent: newItemsByParent,
          loadedParents: newLoadedParents,
          currentFolderId: nextCurrentId
        }
      })
      persistenceQueue.enqueue(async () => {
        await ops.deleteFolders(allFolderIds)
        if (itemIdsToDelete.length > 0) await ops.deleteItems(itemIdsToDelete)
      })
    },

    addItem: (itemData) => {
      const parentId = itemData.parentId || get().currentFolderId
      if (isFolderReadOnly(parentId, get().folders)) return
      const isRoot = parentId === config.rootId
      const siblings = get().getItems(parentId)
      const item: AnyItemRecord = {
        ...itemData,
        id: itemData.id || crypto.randomUUID(),
        parentId,
        sortIndex: siblings.length,
        createdAt: Date.now(),
        expiresAt:
          itemData.expiresAt !== undefined
            ? itemData.expiresAt
            : isRoot
              ? Date.now() + FOLDER_DURATION_MS['1day']
              : null
      } as AnyItemRecord
      set((state) => ({
        items: { ...state.items, [item.id]: item },
        _itemsArray: [...state._itemsArray, item],
        _itemsByParent: {
          ...state._itemsByParent,
          [parentId]: sortByIndex([...(state._itemsByParent[parentId] ?? []), item])
        }
      }))
      persistenceQueue.enqueue(() => ops.saveItem(item))
    },

    removeItem: (id) => {
      const { items, folders } = get()
      if (isItemInReadOnlyFolder(id, items, folders)) return
      set((state) => {
        const removedItem = state.items[id]
        const newItems = { ...state.items }
        delete newItems[id]
        const newItemsByParent = { ...state._itemsByParent }
        if (removedItem?.parentId) {
          newItemsByParent[removedItem.parentId] = (
            newItemsByParent[removedItem.parentId] ?? []
          ).filter((i) => i.id !== id)
        }
        return {
          items: newItems,
          _itemsArray: Object.values(newItems),
          _itemsByParent: newItemsByParent
        }
      })
      persistenceQueue.enqueue(() => ops.deleteItem(id))
    },

    moveItem: (itemId, targetFolderId) => {
      const item = get().items[itemId]
      if (!item || item.parentId === targetFolderId) return
      if (
        isFolderReadOnly(item.parentId, get().folders) ||
        isFolderReadOnly(targetFolderId, get().folders)
      ) {
        return
      }
      const targetSiblings = get().getItems(targetFolderId)
      const updated: AnyItemRecord = {
        ...item,
        parentId: targetFolderId,
        sortIndex: targetSiblings.length,
        expiresAt: targetFolderId === config.rootId ? Date.now() + FOLDER_DURATION_MS['1day'] : null
      }
      set((state) => {
        const newItemsArray = state._itemsArray.map((i) => (i.id === itemId ? updated : i))
        const newItemsByParent = { ...state._itemsByParent }
        if (newItemsByParent[item.parentId]) {
          newItemsByParent[item.parentId] = newItemsByParent[item.parentId].filter(
            (i) => i.id !== itemId
          )
        }
        newItemsByParent[targetFolderId] = sortByIndex([
          ...(newItemsByParent[targetFolderId] ?? []),
          updated
        ])
        return {
          items: { ...state.items, [itemId]: updated },
          _itemsArray: newItemsArray,
          _itemsByParent: newItemsByParent
        }
      })
      persistenceQueue.enqueue(() => ops.saveItem(updated))
    },

    copyItem: async (itemId, targetFolderId) => {
      const sourceItem = get().items[itemId]
      if (!sourceItem || sourceItem.type !== 'file') return null
      if (isFolderReadOnly(targetFolderId, get().folders)) return null

      const newId = crypto.randomUUID()
      const targetSiblings = get().getItems(targetFolderId)
      const now = Date.now()
      const copiedItem: AnyItemRecord = {
        ...sourceItem,
        id: newId,
        parentId: targetFolderId,
        sortIndex: targetSiblings.length,
        createdAt: now,
        expiresAt: targetFolderId === config.rootId ? now + FOLDER_DURATION_MS['1day'] : null,
        deletedAt: undefined,
        originalParentId: undefined
      }

      await persistenceQueue.flush()
      await commitLocalFileItem({ ...copiedItem, type: 'file' }, { copyFromId: itemId })

      set((state) => ({
        items: { ...state.items, [copiedItem.id]: copiedItem },
        _itemsArray: [...state._itemsArray, copiedItem],
        _itemsByParent: {
          ...state._itemsByParent,
          [targetFolderId]: sortByIndex([
            ...(state._itemsByParent[targetFolderId] ?? []),
            copiedItem
          ])
        }
      }))
      return newId
    },

    moveFolder: (folderId, targetFolderId) => {
      if (folderId === config.rootId || folderId === targetFolderId) return
      const folder = get().folders[folderId]
      if (!folder) return
      if (
        isFolderReadOnly(folderId, get().folders) ||
        isFolderReadOnly(targetFolderId, get().folders)
      ) {
        return
      }

      const descendants = getDescendantFolderIds(folderId, get().folders)
      if (descendants.includes(targetFolderId)) return

      const targetSiblings = get().getChildFolders(targetFolderId)
      const updated: FolderRecord = {
        ...folder,
        parentId: targetFolderId,
        sortIndex: targetSiblings.length
      }
      set((state) => {
        const newFoldersArray = state._foldersArray.map((f) => (f.id === folderId ? updated : f))
        const newChildFolders = { ...state._childFoldersByParent }
        if (folder.parentId !== null && newChildFolders[folder.parentId]) {
          newChildFolders[folder.parentId] = newChildFolders[folder.parentId].filter(
            (f) => f.id !== folderId
          )
        }
        newChildFolders[targetFolderId] = sortByIndex([
          ...(newChildFolders[targetFolderId] ?? []),
          updated
        ])
        return {
          folders: { ...state.folders, [folderId]: updated },
          _foldersArray: newFoldersArray,
          _childFoldersByParent: newChildFolders
        }
      })
      persistenceQueue.enqueue(() => ops.saveFolder(updated))
    },

    reorderItems: (parentId, orderedIds) => {
      if (isFolderReadOnly(parentId, get().folders)) return
      const { items } = get()
      const updated: AnyItemRecord[] = []
      for (let i = 0; i < orderedIds.length; i++) {
        const item = items[orderedIds[i]]
        if (item) {
          updated.push({ ...item, sortIndex: i })
        }
      }
      set((state) => {
        const newItems = { ...state.items }
        for (const item of updated) {
          newItems[item.id] = item
        }
        const newItemsByParent = { ...state._itemsByParent }
        if (state.loadedParents.has(parentId)) {
          newItemsByParent[parentId] = sortByIndex(
            Object.values(newItems).filter((i) => i.parentId === parentId)
          )
        }
        return {
          items: newItems,
          _itemsArray: Object.values(newItems),
          _itemsByParent: newItemsByParent
        }
      })
      persistenceQueue.enqueue(() => ops.saveItems(updated))
    },

    reorderFolders: (parentId, orderedIds) => {
      if (isFolderReadOnly(parentId, get().folders)) return
      const { folders } = get()
      const updated: FolderRecord[] = []
      for (let i = 0; i < orderedIds.length; i++) {
        const folder = folders[orderedIds[i]]
        if (folder) {
          updated.push({ ...folder, sortIndex: i })
        }
      }
      set((state) => {
        const newFolders = { ...state.folders }
        for (const folder of updated) {
          newFolders[folder.id] = folder
        }
        const newChildFolders = { ...state._childFoldersByParent }
        newChildFolders[parentId] = sortByIndex(
          Object.values(newFolders).filter((f) => f.parentId === parentId)
        )
        return {
          folders: newFolders,
          _foldersArray: Object.values(newFolders),
          _childFoldersByParent: newChildFolders
        }
      })
      persistenceQueue.enqueue(() => ops.saveFolders(updated))
    },

    navigateToFolder: async (folderId) => {
      const { folders } = get()
      if (!folders[folderId]) return
      set({ currentFolderId: folderId })
      await get().ensureItemsLoaded(folderId)
    },

    navigateToRoot: () => {
      set({ currentFolderId: config.rootId })
    },

    navigateUp: () => {
      const { folders, currentFolderId } = get()
      if (currentFolderId === config.rootId) return
      const current = folders[currentFolderId]
      set({ currentFolderId: current?.parentId ?? config.rootId })
    },

    toggleFavorite: (folderId) => {
      if (folderId === config.rootId) return
      const folder = get().folders[folderId]
      if (!folder) return
      let updated: FolderRecord
      if (!folder.isFavorited) {
        updated = { ...folder, isFavorited: true, expiresAt: null }
      } else {
        updated = { ...folder, isFavorited: false }
      }
      set((state) => ({
        folders: { ...state.folders, [folderId]: updated },
        _foldersArray: state._foldersArray.map((f) => (f.id === folderId ? updated : f)),
        _childFoldersByParent:
          updated.parentId !== null
            ? {
                ...state._childFoldersByParent,
                [updated.parentId]: (state._childFoldersByParent[updated.parentId] ?? []).map(
                  (f) => (f.id === folderId ? updated : f)
                )
              }
            : state._childFoldersByParent
      }))
      persistenceQueue.enqueue(() => ops.saveFolder(updated))
    },

    softDeleteFolder: (folderId) => {
      if (folderId === config.rootId) return
      if (isFolderReadOnly(folderId, get().folders)) return
      const { folders } = get()
      const folder = folders[folderId]
      if (!folder) return

      const descendantIds = getDescendantFolderIds(folderId, folders)

      const updated: FolderRecord = {
        ...folder,
        isFavorited: false,
        deletedAt: Date.now(),
        originalParentId: folder.parentId ?? config.rootId
      }

      const descendantUpdates: FolderRecord[] = []
      for (const id of descendantIds) {
        const f = folders[id]
        if (f?.isFavorited) descendantUpdates.push({ ...f, isFavorited: false })
      }

      set((state) => {
        const newFolders = { ...state.folders, [folderId]: updated }
        for (const f of descendantUpdates) newFolders[f.id] = f
        const newChildFolders = { ...state._childFoldersByParent }
        if (updated.parentId !== null) {
          newChildFolders[updated.parentId] = (newChildFolders[updated.parentId] ?? []).map((f) =>
            f.id === folderId ? updated : f
          )
        }
        for (const f of descendantUpdates) {
          if (f.parentId !== null && newChildFolders[f.parentId]) {
            newChildFolders[f.parentId] = newChildFolders[f.parentId].map((existing) =>
              existing.id === f.id ? f : existing
            )
          }
        }
        return {
          folders: newFolders,
          _foldersArray: state._foldersArray.map((f) => newFolders[f.id] ?? f),
          _childFoldersByParent: newChildFolders
        }
      })

      persistenceQueue.enqueue(async () => {
        await ops.saveFolder(updated)
        if (descendantUpdates.length > 0) await ops.saveFolders(descendantUpdates)
      })
    },

    softDeleteItem: (itemId) => {
      const item = get().items[itemId]
      if (!item) return
      if (isFolderReadOnly(item.parentId, get().folders)) return
      const updated: AnyItemRecord = {
        ...item,
        deletedAt: Date.now(),
        originalParentId: item.parentId
      }
      set((state) => ({
        items: { ...state.items, [itemId]: updated },
        _itemsArray: state._itemsArray.map((i) => (i.id === itemId ? updated : i)),
        _itemsByParent: item.parentId
          ? {
              ...state._itemsByParent,
              [item.parentId]: (state._itemsByParent[item.parentId] ?? []).map((i) =>
                i.id === itemId ? updated : i
              )
            }
          : state._itemsByParent
      }))
      persistenceQueue.enqueue(() => ops.saveItem(updated))
    },

    restoreFolder: (folderId) => {
      const { folders } = get()
      const folder = folders[folderId]
      if (!folder || !folder.deletedAt) return
      const parentId = folder.originalParentId
      const targetParentId =
        parentId && folders[parentId] && !folders[parentId].deletedAt ? parentId : config.rootId
      if (isFolderReadOnly(targetParentId, folders)) return
      const updated: FolderRecord = {
        ...folder,
        isFavorited: false,
        parentId: targetParentId,
        deletedAt: undefined,
        originalParentId: undefined
      }
      set((state) => {
        const oldParentId = folder.parentId
        const newChildFolders = { ...state._childFoldersByParent }
        if (oldParentId !== null && newChildFolders[oldParentId]) {
          newChildFolders[oldParentId] = newChildFolders[oldParentId].filter(
            (f) => f.id !== folderId
          )
        }
        newChildFolders[targetParentId] = sortByIndex([
          ...(newChildFolders[targetParentId] ?? []),
          updated
        ])
        return {
          folders: { ...state.folders, [folderId]: updated },
          _foldersArray: state._foldersArray.map((f) => (f.id === folderId ? updated : f)),
          _childFoldersByParent: newChildFolders
        }
      })
      persistenceQueue.enqueue(() => ops.saveFolder(updated))
    },

    restoreItem: (itemId) => {
      const { items, folders } = get()
      const item = items[itemId]
      if (!item || !item.deletedAt) return
      const parentId = item.originalParentId
      const targetParentId =
        parentId && folders[parentId] && !folders[parentId].deletedAt ? parentId : config.rootId
      if (isFolderReadOnly(targetParentId, folders)) return
      const updated: AnyItemRecord = {
        ...item,
        parentId: targetParentId,
        deletedAt: undefined,
        originalParentId: undefined
      }
      set((state) => {
        const newItemsByParent = { ...state._itemsByParent }
        if (item.parentId && newItemsByParent[item.parentId]) {
          newItemsByParent[item.parentId] = newItemsByParent[item.parentId].filter(
            (i) => i.id !== itemId
          )
        }
        newItemsByParent[targetParentId] = sortByIndex([
          ...(newItemsByParent[targetParentId] ?? []),
          updated
        ])
        return {
          items: { ...state.items, [itemId]: updated },
          _itemsArray: state._itemsArray.map((i) => (i.id === itemId ? updated : i)),
          _itemsByParent: newItemsByParent
        }
      })
      persistenceQueue.enqueue(() => ops.saveItem(updated))
    },

    purgeTrash: async (retentionMs) => {
      const { folderIds, itemIds } = await ops.purgeTrashOlderThan(Date.now(), retentionMs)
      if (folderIds.length === 0 && itemIds.length === 0) return
      set((state) => {
        const newFolders = { ...state.folders }
        const newItems = { ...state.items }
        const folderIdSet = new Set(folderIds)
        for (const id of folderIds) delete newFolders[id]
        for (const id of itemIds) delete newItems[id]
        for (const item of Object.values(newItems)) {
          if (folderIdSet.has(item.parentId)) delete newItems[item.id]
        }
        const newChildFoldersByParent: Record<string, FolderRecord[]> = {}
        for (const f of Object.values(newFolders)) {
          if (f.parentId !== null) {
            const list = newChildFoldersByParent[f.parentId] ?? []
            list.push(f)
            newChildFoldersByParent[f.parentId] = list
          }
        }
        for (const k of Object.keys(newChildFoldersByParent)) {
          newChildFoldersByParent[k] = sortByIndex(newChildFoldersByParent[k])
        }
        const newLoadedParents = new Set<string>()
        const newItemsByParent: Record<string, AnyItemRecord[]> = {}
        for (const parentId of state.loadedParents) {
          if (folderIdSet.has(parentId)) continue
          newLoadedParents.add(parentId)
          newItemsByParent[parentId] = sortByIndex(
            Object.values(newItems).filter((i) => i.parentId === parentId)
          )
        }
        return {
          folders: newFolders,
          items: newItems,
          _foldersArray: Object.values(newFolders),
          _itemsArray: Object.values(newItems),
          _childFoldersByParent: newChildFoldersByParent,
          _itemsByParent: newItemsByParent,
          loadedParents: newLoadedParents
        }
      })
    },

    cleanupExpired: async () => {
      const now = Date.now()
      const expiredFolderIds = await ops.deleteExpiredFolders(now)
      const expiredItemIds = await ops.deleteExpiredItems(now)

      if (expiredFolderIds.length === 0 && expiredItemIds.length === 0) return

      const { folders } = get()

      let cascadeFolderIds: string[] = []
      for (const fid of expiredFolderIds) {
        cascadeFolderIds = [...cascadeFolderIds, ...getDescendantFolderIds(fid, folders)]
      }
      const allExpiredFolderIds = [...expiredFolderIds, ...cascadeFolderIds]
      for (const fid of expiredFolderIds) {
        await ops.deleteItemsByParent(fid)
      }
      if (cascadeFolderIds.length > 0) {
        await ops.deleteFolders(cascadeFolderIds)
        for (const fid of cascadeFolderIds) {
          await ops.deleteItemsByParent(fid)
        }
      }

      set((state) => {
        const newFolders = { ...state.folders }
        const newItems = { ...state.items }
        const expiredFolderIdSet = new Set(allExpiredFolderIds)
        for (const id of allExpiredFolderIds) delete newFolders[id]
        for (const id of expiredItemIds) delete newItems[id]
        for (const item of Object.values(newItems)) {
          if (expiredFolderIdSet.has(item.parentId)) {
            delete newItems[item.id]
          }
        }
        const newChildFoldersByParent: Record<string, FolderRecord[]> = {}
        for (const f of Object.values(newFolders)) {
          if (f.parentId !== null) {
            const list = newChildFoldersByParent[f.parentId] ?? []
            list.push(f)
            newChildFoldersByParent[f.parentId] = list
          }
        }
        for (const k of Object.keys(newChildFoldersByParent)) {
          newChildFoldersByParent[k] = sortByIndex(newChildFoldersByParent[k])
        }
        const newLoadedParents = new Set<string>()
        const newItemsByParent: Record<string, AnyItemRecord[]> = {}
        for (const parentId of state.loadedParents) {
          if (expiredFolderIdSet.has(parentId)) continue
          newLoadedParents.add(parentId)
          newItemsByParent[parentId] = sortByIndex(
            Object.values(newItems).filter((i) => i.parentId === parentId)
          )
        }
        return {
          folders: newFolders,
          items: newItems,
          _foldersArray: Object.values(newFolders),
          _itemsArray: Object.values(newItems),
          _childFoldersByParent: newChildFoldersByParent,
          _itemsByParent: newItemsByParent,
          loadedParents: newLoadedParents
        }
      })
    },

    softDeleteExpired: () => {
      const now = Date.now()
      const { folders, items } = get()

      const expiredFolders: FolderRecord[] = []
      for (const folder of Object.values(folders)) {
        if (
          folder.expiresAt != null &&
          folder.expiresAt < now &&
          !folder.deletedAt &&
          folder.id !== config.rootId
        ) {
          expiredFolders.push(folder)
        }
      }

      const expiredItems: AnyItemRecord[] = []
      for (const item of Object.values(items)) {
        if (item.expiresAt != null && item.expiresAt < now && !item.deletedAt) {
          expiredItems.push(item)
        }
      }

      if (expiredFolders.length === 0 && expiredItems.length === 0) return

      const deletedAt = now
      const folderUpdates: FolderRecord[] = []
      const descendantUnfavorites: FolderRecord[] = []
      for (const folder of expiredFolders) {
        folderUpdates.push({
          ...folder,
          isFavorited: false,
          deletedAt,
          originalParentId: folder.parentId ?? config.rootId
        })
        for (const id of getDescendantFolderIds(folder.id, folders)) {
          const f = folders[id]
          if (f?.isFavorited) descendantUnfavorites.push({ ...f, isFavorited: false })
        }
      }

      const itemUpdates: AnyItemRecord[] = expiredItems.map((item) => ({
        ...item,
        deletedAt,
        originalParentId: item.parentId
      }))

      set((state) => {
        const newFolders = { ...state.folders }
        const newItems = { ...state.items }
        for (const f of [...folderUpdates, ...descendantUnfavorites]) newFolders[f.id] = f
        for (const i of itemUpdates) newItems[i.id] = i
        const newChildFolders = { ...state._childFoldersByParent }
        for (const f of [...folderUpdates, ...descendantUnfavorites]) {
          if (f.parentId !== null && newChildFolders[f.parentId]) {
            newChildFolders[f.parentId] = newChildFolders[f.parentId].map((existing) =>
              existing.id === f.id ? f : existing
            )
          }
        }
        const newItemsByParent = { ...state._itemsByParent }
        for (const i of itemUpdates) {
          if (i.parentId && newItemsByParent[i.parentId]) {
            newItemsByParent[i.parentId] = newItemsByParent[i.parentId].map((existing) =>
              existing.id === i.id ? i : existing
            )
          }
        }
        return {
          folders: newFolders,
          items: newItems,
          _foldersArray: Object.values(newFolders),
          _itemsArray: Object.values(newItems),
          _childFoldersByParent: newChildFolders,
          _itemsByParent: newItemsByParent
        }
      })

      persistenceQueue.enqueue(async () => {
        if (folderUpdates.length > 0) {
          await ops.saveFolders([...folderUpdates, ...descendantUnfavorites])
        }
        if (itemUpdates.length > 0) await ops.saveItems(itemUpdates)
      })
    },

    getChildFolders: (parentId) => {
      return (get()._childFoldersByParent[parentId] ?? []).filter((folder) => !folder.deletedAt)
    },

    getItems: (parentId) => {
      return (get()._itemsByParent[parentId] ?? []).filter((item) => !item.deletedAt)
    },

    getFolderPath: (folderId) => {
      const { folders } = get()
      const path: FolderRecord[] = []
      let current = folders[folderId]
      while (current) {
        path.unshift(current)
        if (current.parentId === null) break
        current = folders[current.parentId]
      }
      return path
    },

    isItemsLoaded: (parentId) => {
      return get().loadedParents.has(parentId)
    }
  }))

  persistenceQueue.subscribe((snapshot) => {
    store.setState({
      persistenceStatus:
        snapshot.status === 'failed'
          ? 'degraded'
          : snapshot.status === 'saving'
            ? 'saving'
            : 'ready',
      persistenceError: snapshot.error,
      pendingPersistenceCount: snapshot.pendingCount
    })
  })

  return store
}

function getDescendantFolderIds(folderId: string, folders: Record<string, FolderRecord>): string[] {
  // Build adjacency map once: O(n)
  const childrenByParent = new Map<string, string[]>()
  for (const f of Object.values(folders)) {
    if (f.parentId) {
      const list = childrenByParent.get(f.parentId) ?? []
      list.push(f.id)
      childrenByParent.set(f.parentId, list)
    }
  }
  // O(n) BFS
  const result: string[] = []
  const queue = [...(childrenByParent.get(folderId) ?? [])]
  while (queue.length > 0) {
    const current = queue.shift()!
    result.push(current)
    const children = childrenByParent.get(current)
    if (children) queue.push(...children)
  }
  return result
}

export const useBibleFolderStore = createFolderStore({
  rootId: 'bible-root',
  rootName: 'Bible Library',
  getDB: () => openBibleDB()
})
