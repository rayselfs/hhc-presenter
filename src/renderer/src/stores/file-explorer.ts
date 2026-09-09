import { useCallback } from 'react'
import { isPersonalRecordVisible, usePersonalSyncStore } from './personal-sync'
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  deleteFileBlob,
  getFileSource,
  openFileExplorerDB,
  storeFileBlob
} from '@renderer/lib/file-explorer-db'
import { hhcPersistStorage, createPersistName } from '@renderer/lib/persist-storage'
import { createFolderStore } from '@renderer/stores/folder'
import type { FileExplorerViewMode, FileItemRecord, FolderRecord } from '@shared/types/folder'
import {
  cleanupFileResources,
  purgeExpiredFileTrash,
  type CleanupResult
} from '@renderer/lib/file-resource-cleanup'

export type SortField = 'name' | 'createdAt' | 'size' | 'kind'
export type SortDir = 'asc' | 'desc' | 'none'
export type GroupMode = 'none' | 'date'
export interface FolderDisplayPreference {
  viewMode: FileExplorerViewMode
  sortField: SortField
  sortDir: SortDir
  groupMode: GroupMode
  groupSortDir: 'asc' | 'desc'
}

interface FileExplorerSettingsState {
  folderDisplay: Record<string, Partial<FolderDisplayPreference>>
  setFolderDisplay: (folderId: string, preference: Partial<FolderDisplayPreference>) => void
  viewMode: FileExplorerViewMode
  setViewMode: (mode: FileExplorerViewMode) => void
  sortField: SortField
  sortDir: SortDir
  setSortField: (field: SortField) => void
  setSortDir: (dir: SortDir) => void
  setSortFieldAndDir: (field: SortField, dir: SortDir) => void
  colWidths: { created: number; size: number; kind: number }
  setColWidths: (widths: Partial<{ created: number; size: number; kind: number }>) => void
}

interface FileExplorerSearchState {
  searchQuery: string
  setSearchQuery: (query: string) => void
}

type FileExplorerSettingsStore = UseBoundStore<
  Mutate<StoreApi<FileExplorerSettingsState>, [['zustand/persist', unknown]]>
>

const CREATED_COLUMN_WIDTH = 160
const EXPLORER_SETTINGS_VERSION = 5

function migrateExplorerSettings(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  const persisted = state as Partial<FileExplorerSettingsState>
  return {
    ...persisted,
    ...(persisted.colWidths?.created === 112
      ? { colWidths: { ...persisted.colWidths, created: CREATED_COLUMN_WIDTH } }
      : {}),
    folderDisplay: Object.fromEntries(
      Object.entries(persisted.folderDisplay ?? {}).map(([id, display]) => [
        id,
        {
          ...display,
          groupSortDir:
            display.groupSortDir ??
            (display.groupMode !== 'none' && display.sortDir === 'asc' ? 'asc' : 'desc')
        }
      ])
    )
  }
}

export const FILE_EXPLORER_ROOT_ID = 'file-root'

export const useFileExplorerStore = createFolderStore({
  rootId: FILE_EXPLORER_ROOT_ID,
  rootName: 'Files',
  isVisible: isPersonalRecordVisible,
  getDB: () => openFileExplorerDB()
})

let personalCatalogGeneration = 0

export function publishPersistedFileItem(item: FileItemRecord): void {
  personalCatalogGeneration += 1
  if (!isPersonalRecordVisible(item)) return
  useFileExplorerStore.setState((state) => {
    const items = { ...state.items, [item.id]: item }
    const siblings = [
      ...(state._itemsByParent[item.parentId] ?? []).filter((entry) => entry.id !== item.id),
      item
    ].sort((a, b) => a.sortIndex - b.sortIndex)
    return {
      items,
      _itemsArray: Object.values(items),
      _itemsByParent: {
        ...Object.fromEntries(
          Object.entries(state._itemsByParent).map(([parentId, entries]) => [
            parentId,
            parentId === item.parentId ? entries : entries.filter((entry) => entry.id !== item.id)
          ])
        ),
        [item.parentId]: siblings
      }
    }
  })
}

function createExplorerSettingsStore(
  persistName: string,
  defaults: { sortField: SortField; sortDir: SortDir },
  options: { version?: number; migrate?: (state: unknown) => unknown } = {}
): FileExplorerSettingsStore {
  return create<FileExplorerSettingsState>()(
    persist(
      (set) => ({
        folderDisplay: {},
        setFolderDisplay: (folderId, preference) =>
          set((state) => ({
            folderDisplay: {
              ...state.folderDisplay,
              [folderId]: { ...state.folderDisplay[folderId], ...preference }
            }
          })),
        viewMode: 'medium-icon',
        setViewMode: (viewMode) => set({ viewMode }),
        sortField: defaults.sortField,
        sortDir: defaults.sortDir,
        setSortField: (sortField) => set({ sortField }),
        setSortDir: (sortDir) => set({ sortDir }),
        setSortFieldAndDir: (sortField, sortDir) => set({ sortField, sortDir }),
        colWidths: { created: CREATED_COLUMN_WIDTH, size: 80, kind: 96 },
        setColWidths: (widths) => set((state) => ({ colWidths: { ...state.colWidths, ...widths } }))
      }),
      {
        name: createPersistName(persistName),
        storage: hhcPersistStorage,
        version: options.version ?? 0,
        ...(options.migrate ? { migrate: options.migrate } : {}),
        partialize: (state) => ({
          folderDisplay: state.folderDisplay,
          viewMode: state.viewMode,
          sortField: state.sortField,
          sortDir: state.sortDir,
          colWidths: state.colWidths
        })
      }
    )
  )
}

export const useFileExplorerSettings = createExplorerSettingsStore(
  'file-explorer-settings',
  { sortField: 'createdAt', sortDir: 'none' },
  { version: EXPLORER_SETTINGS_VERSION, migrate: migrateExplorerSettings }
)

export const useFileExplorerSearch = create<FileExplorerSearchState>()((set) => ({
  searchQuery: '',
  setSearchQuery: (searchQuery) => set({ searchQuery })
}))

export const useFavoritesExplorerSettings = createExplorerSettingsStore(
  'favorites-explorer-settings',
  { sortField: 'name', sortDir: 'asc' },
  { version: EXPLORER_SETTINGS_VERSION, migrate: migrateExplorerSettings }
)

export const useTrashExplorerSettings = createExplorerSettingsStore(
  'trash-explorer-settings',
  {
    sortField: 'createdAt',
    sortDir: 'desc'
  },
  { version: EXPLORER_SETTINGS_VERSION, migrate: migrateExplorerSettings }
)

interface FileExplorerCustomOrderState {
  orders: Record<string, string[]>
  setOrder: (folderId: string, orderedIds: string[]) => void
}

export const useFileExplorerCustomOrder = create<FileExplorerCustomOrderState>()(
  persist(
    (set) => ({
      orders: {},
      setOrder: (folderId, orderedIds) =>
        set((state) => ({ orders: { ...state.orders, [folderId]: orderedIds } }))
    }),
    {
      name: createPersistName('file-explorer-custom-order'),
      storage: hhcPersistStorage,
      version: 0,
      partialize: (state) => ({ orders: state.orders })
    }
  )
)

export async function addFileItemToStore(
  file: File,
  parentId: string,
  canonicalMimeType = file.type || 'application/octet-stream'
): Promise<string> {
  const parent =
    useFileExplorerStore.getState().folders[parentId] ??
    (await (await openFileExplorerDB()).get('folder-records', parentId))
  if (!parent && parentId !== FILE_EXPLORER_ROOT_ID)
    throw new Error('File destination is unavailable')
  if (parent?.personalOwnerId) {
    return (await import('@renderer/lib/personal-file-actions')).createPersonalFile(
      file,
      parentId,
      canonicalMimeType
    )
  }
  const db = await openFileExplorerDB()
  const id = crypto.randomUUID()

  await storeFileBlob(db, id, file)

  const item: Omit<FileItemRecord, 'sortIndex' | 'createdAt' | 'expiresAt'> = {
    id,
    parentId,
    type: 'file',
    name: file.name,
    url: `blob:${id}`,
    size: file.size,
    mimeType: canonicalMimeType
  }

  useFileExplorerStore.getState().addItem(item)
  const storedItem = useFileExplorerStore.getState().items[id]
  try {
    if (!storedItem) throw new Error(`Failed to create file metadata: ${id}`)
    await db.put('folder-items', storedItem)
  } catch (error) {
    useFileExplorerStore.getState().removeItem(id)
    await deleteFileBlob(db, id).catch(() => undefined)
    throw error
  }
  return id
}

export function removeFileItemFromStore(id: string): void {
  useFileExplorerStore.getState().softDeleteItem(id)
}

export function removeCleanedEntriesFromStore(result: CleanupResult): void {
  const folderIds = new Set(result.folderIds)
  const itemIds = new Set(result.itemIds)
  useFileExplorerStore.setState((state) => {
    const folders = Object.fromEntries(
      Object.entries(state.folders).filter(([id]) => !folderIds.has(id))
    )
    const items = Object.fromEntries(Object.entries(state.items).filter(([id]) => !itemIds.has(id)))
    const childFoldersByParent: typeof state._childFoldersByParent = {}
    for (const folder of Object.values(folders)) {
      if (folder.parentId === null) continue
      const list = childFoldersByParent[folder.parentId] ?? []
      list.push(folder)
      childFoldersByParent[folder.parentId] = list
    }
    const itemsByParent: typeof state._itemsByParent = {}
    for (const [parentId, loadedItems] of Object.entries(state._itemsByParent)) {
      if (folderIds.has(parentId)) continue
      itemsByParent[parentId] = loadedItems.filter((item) => !itemIds.has(item.id))
    }
    return {
      folders,
      items,
      _foldersArray: Object.values(folders),
      _itemsArray: Object.values(items),
      _childFoldersByParent: childFoldersByParent,
      _itemsByParent: itemsByParent,
      loadedParents: new Set([...state.loadedParents].filter((id) => !folderIds.has(id))),
      currentFolderId: folderIds.has(state.currentFolderId)
        ? FILE_EXPLORER_ROOT_ID
        : state.currentFolderId
    }
  })
}

export async function permanentDeleteFileItemFromStore(id: string): Promise<void> {
  removeCleanedEntriesFromStore(await cleanupFileResources({ itemIds: [id] }))
}

export function deleteFolderFromStore(folderId: string): void {
  useFileExplorerStore.getState().softDeleteFolder(folderId)
}

export async function permanentDeleteFolderFromStore(folderId: string): Promise<void> {
  removeCleanedEntriesFromStore(await cleanupFileResources({ folderIds: [folderId] }))
}

export async function purgeExpiredTrashFromStore(retentionMs: number): Promise<void> {
  removeCleanedEntriesFromStore(await purgeExpiredFileTrash(retentionMs))
}

export function resolveFolderDisplay(
  folderId: string,
  folders: Record<string, FolderRecord>,
  defaults: Pick<FolderDisplayPreference, 'viewMode' | 'sortField' | 'sortDir'>,
  override?: Partial<FolderDisplayPreference>
): FolderDisplayPreference {
  let folder = folders[folderId]
  const visited = new Set<string>()
  let isLine = false
  while (folder && !visited.has(folder.id)) {
    visited.add(folder.id)
    if (folder.syncLink) {
      isLine = folder.syncLink.providerType === 'hhc-line'
      break
    }
    if (!folder.parentId) break
    folder = folders[folder.parentId]
  }
  return {
    ...defaults,
    groupMode: 'none',
    groupSortDir: 'desc',
    ...(isLine
      ? { sortField: 'createdAt' as const, sortDir: 'desc' as const, groupMode: 'date' as const }
      : {}),
    ...override
  }
}

export function useCurrentFolderDisplay(): FolderDisplayPreference & {
  setViewMode: (mode: FileExplorerViewMode) => void
  setSortFieldAndDir: (field: SortField, dir: SortDir) => void
  setSortDir: (dir: SortDir) => void
  setGroupMode: (mode: GroupMode) => void
} {
  const folderId = useFileExplorerStore((state) => state.currentFolderId)
  const folders = useFileExplorerStore((state) => state.folders)
  const viewMode = useFileExplorerSettings((state) => state.viewMode)
  const sortField = useFileExplorerSettings((state) => state.sortField)
  const sortDir = useFileExplorerSettings((state) => state.sortDir)
  const override = useFileExplorerSettings((state) => state.folderDisplay[folderId])
  const setDisplay = useFileExplorerSettings((state) => state.setFolderDisplay)
  const setViewMode = useCallback(
    (mode: FileExplorerViewMode) => setDisplay(folderId, { viewMode: mode }),
    [folderId, setDisplay]
  )
  const setSortFieldAndDir = useCallback(
    (field: SortField, dir: SortDir) => setDisplay(folderId, { sortField: field, sortDir: dir }),
    [folderId, setDisplay]
  )
  const setSortDir = useCallback(
    (dir: SortDir) => setDisplay(folderId, { sortDir: dir }),
    [folderId, setDisplay]
  )
  const setGroupMode = useCallback(
    (mode: GroupMode) => setDisplay(folderId, { groupMode: mode }),
    [folderId, setDisplay]
  )
  return {
    ...resolveFolderDisplay(folderId, folders, { viewMode, sortField, sortDir }, override),
    setViewMode,
    setSortFieldAndDir,
    setSortDir,
    setGroupMode
  }
}

export async function refreshPersonalCatalog(ownerId: string): Promise<void> {
  const generation = ++personalCatalogGeneration
  const db = await openFileExplorerDB()
  const tx = db.transaction([
    'folder-records',
    'folder-items',
    'personal-sync-nodes',
    'personal-sync-outbox'
  ])
  // ponytail: full catalog scan; add an owner index if measured library sizes make this slow.
  const [allFolders, allItems, nodes, outbox] = await Promise.all([
    tx.objectStore('folder-records').getAll(),
    tx.objectStore('folder-items').getAll(),
    tx.objectStore('personal-sync-nodes').index('by-owner').getAll(ownerId),
    tx.objectStore('personal-sync-outbox').index('by-owner').getAll(ownerId)
  ])
  await tx.done
  if (
    generation !== personalCatalogGeneration ||
    usePersonalSyncStore.getState().activeOwnerId !== ownerId
  )
    return
  const failures = new Map(
    outbox
      .filter((operation) => operation.failure)
      .map((operation) => [operation.nodeId, operation.failure])
  )
  usePersonalSyncStore.setState({
    itemStatuses: Object.fromEntries(
      nodes.map((node) => {
        const failure = failures.get(node.id)
        return [
          node.id,
          failure === 'conflict'
            ? 'conflict'
            : failure
              ? 'failed'
              : node.localRevision === node.syncedLocalRevision
                ? 'synced'
                : 'pending'
        ]
      })
    )
  })
  useFileExplorerStore.setState((state) => {
    const folders = Object.fromEntries([
      ...Object.entries(state.folders).filter(([, folder]) => !folder.personalOwnerId),
      ...allFolders
        .filter((folder) => folder.personalOwnerId === ownerId)
        .map((folder) => [folder.id, folder] as const)
    ])
    const items = Object.fromEntries([
      ...Object.entries(state.items).filter(([, item]) => !item.personalOwnerId),
      ...allItems
        .filter((item) => item.personalOwnerId === ownerId)
        .map((item) => [item.id, item] as const)
    ])
    const childFoldersByParent: typeof state._childFoldersByParent = {}
    for (const folder of Object.values(folders)) {
      if (folder.parentId !== null) (childFoldersByParent[folder.parentId] ??= []).push(folder)
    }
    const itemsByParent: typeof state._itemsByParent = {}
    for (const item of Object.values(items)) (itemsByParent[item.parentId] ??= []).push(item)
    for (const entries of Object.values(childFoldersByParent))
      entries.sort((a, b) => a.sortIndex - b.sortIndex)
    for (const entries of Object.values(itemsByParent))
      entries.sort((a, b) => a.sortIndex - b.sortIndex)
    return {
      folders,
      items,
      _foldersArray: Object.values(folders),
      _itemsArray: Object.values(items),
      _childFoldersByParent: childFoldersByParent,
      _itemsByParent: itemsByParent,
      loadedParents: new Set([
        ...state.loadedParents,
        ...allFolders
          .filter((folder) => folder.personalOwnerId === ownerId)
          .map((folder) => folder.id)
      ])
    }
  })
}

usePersonalSyncStore.subscribe((state, previous) => {
  if (state.activeOwnerId === previous.activeOwnerId) return
  personalCatalogGeneration += 1
  const catalog = useFileExplorerStore.getState()
  removeCleanedEntriesFromStore({
    folderIds: Object.values(catalog.folders)
      .filter((folder) => !isPersonalRecordVisible(folder))
      .map((folder) => folder.id),
    itemIds: Object.values(catalog.items)
      .filter((item) => !isPersonalRecordVisible(item))
      .map((item) => item.id)
  })
  if (state.activeOwnerId) {
    const refresh = refreshPersonalCatalog(state.activeOwnerId)
    const generation = personalCatalogGeneration
    void refresh.catch(() => {
      if (generation === personalCatalogGeneration) {
        usePersonalSyncStore.setState({ syncStatus: 'failed', errorCode: 'catalog-unavailable' })
      }
    })
  }
})

export async function createExplorerFolder(
  name: string,
  parentId?: string,
  expiresAt?: number | null
): Promise<string> {
  const store = useFileExplorerStore.getState()
  const parent = parentId ?? store.currentFolderId
  const destination =
    store.folders[parent] ?? (await (await openFileExplorerDB()).get('folder-records', parent))
  if (!destination && parent !== FILE_EXPLORER_ROOT_ID)
    throw new Error('Folder destination is unavailable')
  if (destination?.personalOwnerId) {
    return (await import('@renderer/lib/personal-file-actions')).createPersonalFolder(name, parent)
  }
  return store.addFolder(name, parent, expiresAt)
}

function reportPersonalWriteError(error: unknown): void {
  usePersonalSyncStore.setState({
    syncStatus: 'failed',
    errorCode: error instanceof Error ? error.message : 'local-write-failed'
  })
}

async function copyPersonalBoundaryFile(itemId: string, parentId: string): Promise<string | null> {
  const item = useFileExplorerStore.getState().items[itemId]
  if (!item || item.type !== 'file' || !isPersonalRecordVisible(item)) return null
  const db = await openFileExplorerDB()
  const { getBlobId } = await import('@renderer/lib/blob-identity')
  const source = await getFileSource(db, getBlobId(item), item.mimeType)
  if (!source) throw new Error('Personal copy source is not available offline')
  try {
    const response = await fetch(source.url)
    if (!response.ok) throw new Error('Personal copy source could not be read')
    const blob = await response.blob()
    if (!isPersonalRecordVisible(item)) throw new Error('Personal account changed')
    return addFileItemToStore(
      new File([blob], item.name, { type: item.mimeType }),
      parentId,
      item.mimeType
    )
  } finally {
    source.revoke()
  }
}

export async function copyExplorerFolder(
  id: string,
  parentId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<string> {
  const state = useFileExplorerStore.getState()
  const source = state.folders[id]
  if (!source || !isPersonalRecordVisible(source)) throw new Error('Copy source is unavailable')
  let ancestor: string | null = parentId
  const seen = new Set<string>()
  while (ancestor && !seen.has(ancestor)) {
    if (ancestor === id) throw new Error('Cannot copy a folder into itself')
    seen.add(ancestor)
    ancestor = state.folders[ancestor]?.parentId ?? null
  }
  await state.ensureItemsLoaded(id)
  const loaded = useFileExplorerStore.getState()
  const items = loaded._itemsArray.filter(
    (item) => item.parentId === id && (options.includeDeleted || !item.deletedAt)
  )
  const folders = loaded._foldersArray.filter(
    (folder) => folder.parentId === id && (options.includeDeleted || !folder.deletedAt)
  )
  const target = await createExplorerFolder(source.name, parentId)
  if (!target) throw new Error('Copy destination is unavailable')
  for (const item of items) {
    if (!(await useFileExplorerStore.getState().copyItem(item.id, target)))
      throw new Error('File copy failed')
  }
  for (const folder of folders) await copyExplorerFolder(folder.id, target, options)
  return target
}

const localFileActions = useFileExplorerStore.getState()
function isPersonalNode(id: string): boolean {
  const state = useFileExplorerStore.getState()
  return Boolean(state.folders[id]?.personalOwnerId || state.items[id]?.personalOwnerId)
}
function personalWrite(
  id: string,
  mutation: Parameters<typeof import('@renderer/lib/personal-file-actions').mutatePersonalNode>[1]
): void {
  void import('@renderer/lib/personal-file-actions')
    .then((actions) => actions.mutatePersonalNode(id, mutation))
    .catch(reportPersonalWriteError)
}
useFileExplorerStore.setState({
  purgeTrash: purgeExpiredTrashFromStore,
  toggleFavorite: (id) => {
    if (!isPersonalNode(id)) return localFileActions.toggleFavorite(id)
    void import('@renderer/lib/personal-file-actions')
      .then((actions) => actions.togglePersonalFolderFavorite(id))
      .catch(reportPersonalWriteError)
  },
  updateFolder: (id, updates) => {
    if (!isPersonalNode(id)) return localFileActions.updateFolder(id, updates)
    if (updates.name !== undefined) personalWrite(id, { type: 'rename', name: updates.name })
  },
  updateItem: (id, updates) => {
    if (!isPersonalNode(id)) return localFileActions.updateItem?.(id, updates)
    if ('name' in updates && updates.name !== undefined)
      personalWrite(id, { type: 'rename', name: updates.name })
    if ('notes' in updates) {
      void import('@renderer/lib/personal-file-actions')
        .then((actions) => actions.setPersonalFileNotes(id, updates.notes))
        .catch(reportPersonalWriteError)
    }
  },
  softDeleteFolder: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'delete' })
      : localFileActions.softDeleteFolder(id),
  softDeleteItem: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'delete' })
      : localFileActions.softDeleteItem(id),
  deleteFolder: (id) =>
    isPersonalNode(id) ? personalWrite(id, { type: 'delete' }) : localFileActions.deleteFolder(id),
  removeItem: (id) =>
    isPersonalNode(id) ? personalWrite(id, { type: 'delete' }) : localFileActions.removeItem(id),
  restoreFolder: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'restore' })
      : localFileActions.restoreFolder(id),
  restoreItem: (id) =>
    isPersonalNode(id) ? personalWrite(id, { type: 'restore' }) : localFileActions.restoreItem(id),
  moveItem: (id, parentId) => {
    const source = useFileExplorerStore.getState().items[id]
    const destination = useFileExplorerStore.getState().folders[parentId]
    if (!source?.personalOwnerId && !destination?.personalOwnerId)
      return localFileActions.moveItem(id, parentId)
    if (source?.personalOwnerId && source.personalOwnerId === destination?.personalOwnerId)
      personalWrite(id, { type: 'move', parentId })
    else void copyPersonalBoundaryFile(id, parentId).catch(reportPersonalWriteError)
  },
  moveFolder: (id, parentId) => {
    const state = useFileExplorerStore.getState()
    if (!state.folders[id]?.personalOwnerId && !state.folders[parentId]?.personalOwnerId)
      return localFileActions.moveFolder(id, parentId)
    if (state.folders[id]?.personalOwnerId === state.folders[parentId]?.personalOwnerId)
      personalWrite(id, { type: 'move', parentId })
    else void copyExplorerFolder(id, parentId).catch(reportPersonalWriteError)
  },
  copyItem: async (id, parentId) => {
    if (!isPersonalNode(id) && !isPersonalNode(parentId))
      return localFileActions.copyItem(id, parentId)
    try {
      return await copyPersonalBoundaryFile(id, parentId)
    } catch (error) {
      reportPersonalWriteError(error)
      return null
    }
  }
})
