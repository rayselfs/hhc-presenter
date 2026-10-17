import { validateDisplayName } from '@renderer/lib/file-naming'
import { createPersistenceOperationQueue } from '@renderer/lib/persistence-operation-queue'
import {
  createLocalCatalogFolder,
  moveLocalCatalogEntry,
  softDeleteLocalCatalogEntry,
  updateLocalCatalogEntry,
  restoreLocalCatalogEntry
} from '@renderer/lib/file-catalog-mutations'
import { createFileExplorerFolderDB } from '@renderer/lib/folder-db'
import { useCallback } from 'react'
import { FOLDER_DURATION_MS } from '@shared/types/folder'
import { assertLocalDestination, commitLocalFileItem } from '@renderer/lib/file-catalog-mutations'
import {
  createResourceCleanupRecord,
  retryResourceCleanup
} from '@renderer/lib/resource-cleanup-journal'
import { isElectron } from '@renderer/lib/env'
import { isFolderReadOnlyBySyncLink } from '@renderer/lib/sync-readonly'
import { isPersonalRecordVisible, usePersonalSyncStore } from './personal-sync'
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand'
import { persist } from 'zustand/middleware'
import { getFileSource, openFileExplorerDB, storeFileBlob } from '@renderer/lib/file-explorer-db'
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

const filePersistenceQueue = createPersistenceOperationQueue()

export const useFileExplorerStore = createFolderStore(
  {
    rootId: FILE_EXPLORER_ROOT_ID,
    rootName: 'Files',
    isVisible: isPersonalRecordVisible,
    persistence: createFileExplorerFolderDB()
  },
  filePersistenceQueue
)

function sortByIndex<T extends { sortIndex: number }>(items: T[]): T[] {
  return items.slice().sort((a, b) => a.sortIndex - b.sortIndex)
}

export function publishPersistedSyncRoot(root: FolderRecord): void {
  useFileExplorerStore.setState((state) => {
    const folders = { ...state.folders, [root.id]: root }
    const siblings = [
      ...(state._childFoldersByParent[root.parentId!] ?? []).filter(
        (folder) => folder.id !== root.id
      ),
      root
    ].sort((left, right) => left.sortIndex - right.sortIndex)
    return {
      folders,
      _foldersArray: Object.values(folders),
      _childFoldersByParent: {
        ...state._childFoldersByParent,
        [root.parentId!]: siblings
      }
    }
  })
}

export function mergePersistedSyncCatalog(folders: FolderRecord[], items: FileItemRecord[]): void {
  const importedParentIds = new Set<string>(folders.map((folder) => folder.id))
  importedParentIds.add(FILE_EXPLORER_ROOT_ID)
  for (const item of items) importedParentIds.add(item.parentId)

  useFileExplorerStore.setState((state) => {
    const nextFolders = { ...state.folders }
    const nextItems = { ...state.items }
    for (const folder of folders) nextFolders[folder.id] = folder
    for (const item of items) nextItems[item.id] = item

    const childFoldersByParent: typeof state._childFoldersByParent = {}
    for (const folder of Object.values(nextFolders)) {
      if (folder.parentId === null) continue
      const list = childFoldersByParent[folder.parentId] ?? []
      list.push(folder)
      childFoldersByParent[folder.parentId] = list
    }
    for (const parentId of Object.keys(childFoldersByParent)) {
      childFoldersByParent[parentId] = sortByIndex(childFoldersByParent[parentId])
    }

    const loadedParents = new Set([...state.loadedParents, ...importedParentIds])
    const itemsByParent: typeof state._itemsByParent = {}
    for (const parentId of loadedParents) {
      itemsByParent[parentId] = sortByIndex(
        Object.values(nextItems).filter((item) => item.parentId === parentId)
      )
    }

    return {
      folders: nextFolders,
      items: nextItems,
      _foldersArray: Object.values(nextFolders),
      _itemsArray: Object.values(nextItems),
      _childFoldersByParent: childFoldersByParent,
      _itemsByParent: itemsByParent,
      loadedParents
    }
  })
}

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
  canonicalMimeType = file.type || 'application/octet-stream',
  notes?: string
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
  const stagingLock = `local-blob:${id}`
  const stage = async (): Promise<void> => {
    const cleanup = createResourceCleanupRecord({
      blobId: id,
      storage: isElectron() ? 'native-fs' : 'indexed-db',
      deleteNativeFile: isElectron(),
      deleteDerivedAssets: true,
      deletePdfPageThumbs: true,
      deleteBlobRecord: true,
      itemThumbnailIds: [],
      stagingLock
    })
    await db.add('resource-cleanup-journal', cleanup)
    await storeFileBlob(db, id, file)
    await useFileExplorerStore.getState().flushPersistence()
    assertLocalDestination(parentId, Object.values(useFileExplorerStore.getState().folders))
    const now = Date.now()
    const item: FileItemRecord = {
      id,
      parentId,
      type: 'file',
      name: file.name,
      url: `blob:${id}`,
      size: file.size,
      mimeType: canonicalMimeType,
      ...(notes !== undefined ? { notes } : {}),
      sortIndex: useFileExplorerStore.getState().getItems(parentId).length,
      createdAt: now,
      expiresAt: parentId === FILE_EXPLORER_ROOT_ID ? now + FOLDER_DURATION_MS['1day'] : null
    }
    await commitLocalFileItem(item, { stagingCleanupId: cleanup.id })
    publishPersistedFileItem(item)
  }
  try {
    if (navigator.locks) await navigator.locks.request(stagingLock, stage)
    else await stage()
  } catch (error) {
    const pending = (await db.getAll('resource-cleanup-journal')).find(
      (record) => record.blobId === id
    )
    if (pending) await retryResourceCleanup(pending.id).catch(() => undefined)
    throw error
  }
  return id
}

export function removeFileItemFromStore(id: string): Promise<void> {
  return softDeleteExplorerEntry('file', id)
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
  await useFileExplorerStore.getState().flushPersistence()
  removeCleanedEntriesFromStore(await cleanupFileResources({ itemIds: [id] }))
}

export function deleteFolderFromStore(folderId: string): Promise<void> {
  return softDeleteExplorerEntry('folder', folderId)
}

export async function permanentDeleteFolderFromStore(folderId: string): Promise<void> {
  await useFileExplorerStore.getState().flushPersistence()
  removeCleanedEntriesFromStore(await cleanupFileResources({ folderIds: [folderId] }))
}

export async function purgeExpiredTrashFromStore(retentionMs: number): Promise<void> {
  await useFileExplorerStore.getState().flushPersistence()
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
  let createdId = ''
  await filePersistenceQueue.commit(async () => {
    const folder = await createLocalCatalogFolder(name, parent, expiresAt, isPersonalRecordVisible)
    publishPersistedExplorerEntry(folder)
    createdId = folder.id
  })
  return createdId
}

function runExplorerLocalAction(ids: string[], action: () => void): void {
  const state = useFileExplorerStore.getState()
  for (const id of ids) {
    let current: string | null = state.items[id]?.parentId ?? id
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      const pending = pendingExplorerTrashRoots.has(current)
        ? pendingExplorerEntryWrites.get(current)
        : undefined
      if (pending) {
        pending.metadata.push(() => runExplorerLocalAction(ids, action))
        return
      }
      current = state.folders[current]?.parentId ?? null
    }
    const pending = pendingExplorerEntryWrites.get(id)
    if (pending) {
      pending.metadata.push(() => runExplorerLocalAction(ids, action))
      return
    }
  }
  action()
}

function reportPersonalWriteError(error: unknown): void {
  usePersonalSyncStore.setState({
    syncStatus: 'failed',
    errorCode: error instanceof Error ? error.message : 'local-write-failed'
  })
}

const pendingExplorerTrashRoots = new Map<string, number>()
const pendingExplorerRestores = new Map<string, Promise<void>>()
const pendingExplorerEntryWrites = new Map<string, { count: number; metadata: Array<() => void> }>()

function withExplorerEntryWrite(id: string, operation: () => Promise<void>): Promise<void> {
  const pending = pendingExplorerEntryWrites.get(id) ?? { count: 0, metadata: [] }
  pending.count++
  pendingExplorerEntryWrites.set(id, pending)
  return operation().finally(() => {
    pending.count--
    if (pending.count > 0) return
    pendingExplorerEntryWrites.delete(id)
    for (const update of pending.metadata) update()
  })
}

async function mutateExplorerPersonalNode(
  ownerId: string,
  id: string,
  mutation: Parameters<typeof import('@renderer/lib/personal-file-actions').mutatePersonalNode>[1]
): Promise<void> {
  const controller = new AbortController()
  const unsubscribe = usePersonalSyncStore.subscribe((state) => {
    if (state.activeOwnerId !== ownerId) controller.abort()
  })
  try {
    if (usePersonalSyncStore.getState().activeOwnerId !== ownerId) controller.abort()
    const actions = await import('@renderer/lib/personal-file-actions')
    controller.signal.throwIfAborted()
    await actions.mutatePersonalNode(id, mutation, controller.signal)
  } catch (error) {
    controller.signal.throwIfAborted()
    throw error
  } finally {
    unsubscribe()
  }
}

function publishPersistedExplorerEntry(record: FolderRecord | FileItemRecord): void {
  if ('type' in record) {
    publishPersistedFileItem(record)
    return
  }
  publishPersistedExplorerFolders([record])
}

function publishPersistedExplorerFolders(records: FolderRecord[]): void {
  useFileExplorerStore.setState((state) => {
    const folders = { ...state.folders }
    for (const record of records) folders[record.id] = record
    const children: Record<string, FolderRecord[]> = Object.fromEntries(
      Object.keys(state._childFoldersByParent).map((id) => [id, []])
    )
    for (const folder of Object.values(folders)) {
      if (!folder.parentId) continue
      const siblings = children[folder.parentId] ?? []
      siblings.push(folder)
      children[folder.parentId] = siblings
    }
    for (const parentId of Object.keys(children))
      children[parentId] = sortByIndex(children[parentId])
    return { folders, _foldersArray: Object.values(folders), _childFoldersByParent: children }
  })
}

export function softDeleteExplorerEntry(kind: 'folder' | 'file', id: string): Promise<void> {
  if (kind === 'folder')
    pendingExplorerTrashRoots.set(id, (pendingExplorerTrashRoots.get(id) ?? 0) + 1)
  return withExplorerEntryWrite(id, async () => {
    const db = await openFileExplorerDB()
    const record =
      kind === 'folder' ? await db.get('folder-records', id) : await db.get('folder-items', id)
    if (!record || !isPersonalRecordVisible(record)) throw new Error('Trash source is unavailable')
    if (record.personalOwnerId) {
      await mutateExplorerPersonalNode(record.personalOwnerId, id, { type: 'delete' })
      return
    }
    await filePersistenceQueue.commit(async () => {
      const committed = await softDeleteLocalCatalogEntry(kind, id)
      if (committed.folders.length > 0) publishPersistedExplorerFolders(committed.folders)
      for (const item of committed.items) publishPersistedFileItem(item)
    })
  }).finally(() => {
    if (kind !== 'folder') return
    const count = (pendingExplorerTrashRoots.get(id) ?? 1) - 1
    if (count === 0) pendingExplorerTrashRoots.delete(id)
    else pendingExplorerTrashRoots.set(id, count)
  })
}

export function moveExplorerEntry(
  kind: 'folder' | 'file',
  id: string,
  parentId: string
): Promise<void> {
  return withExplorerEntryWrite(id, async () => {
    const db = await openFileExplorerDB()
    const [record, destination] = await Promise.all([
      kind === 'folder' ? db.get('folder-records', id) : db.get('folder-items', id),
      db.get('folder-records', parentId)
    ])
    if (
      !record ||
      !isPersonalRecordVisible(record) ||
      (destination && !isPersonalRecordVisible(destination))
    )
      throw new Error('Move source or destination is unavailable')
    if (record.personalOwnerId || destination?.personalOwnerId) {
      if (record.personalOwnerId && record.personalOwnerId === destination?.personalOwnerId)
        await mutateExplorerPersonalNode(record.personalOwnerId, id, { type: 'move', parentId })
      else if (kind === 'folder') await copyExplorerFolder(id, parentId)
      else if (!(await copyFileSnapshot(id, parentId))) throw new Error('File copy failed')
      return
    }
    await filePersistenceQueue.commit(async () => {
      const moved = await moveLocalCatalogEntry(kind, id, parentId, isPersonalRecordVisible)
      publishPersistedExplorerEntry(moved)
    })
  })
}

export function renameExplorerEntry(
  kind: 'folder' | 'file',
  id: string,
  name: string
): Promise<void> {
  return updateExplorerEntry(kind, id, { name })
}

export function updateExplorerFolderProperties(
  id: string,
  updates: { name: string; expiresAt: number | null }
): Promise<void> {
  return updateExplorerEntry('folder', id, { ...updates })
}

function updateExplorerEntry(
  kind: 'folder' | 'file',
  id: string,
  updates: { name: string; expiresAt?: number | null }
): Promise<void> {
  const { name } = updates
  return withExplorerEntryWrite(id, async () => {
    if (!validateDisplayName(name)) throw new Error('Rename name is invalid')
    const db = await openFileExplorerDB()
    const record =
      kind === 'folder' ? await db.get('folder-records', id) : await db.get('folder-items', id)
    if (!record || record.deletedAt || !isPersonalRecordVisible(record))
      throw new Error('Rename source is unavailable')
    if (record.personalOwnerId) {
      await mutateExplorerPersonalNode(record.personalOwnerId, id, { type: 'rename', name })
      return
    }
    await filePersistenceQueue.commit(async () => {
      publishPersistedExplorerEntry(await updateLocalCatalogEntry(kind, id, updates))
    })
  })
}

export function restoreExplorerEntry(
  kind: 'folder' | 'file',
  id: string,
  name?: string
): Promise<void> {
  const current = pendingExplorerRestores.get(id)
  if (current) return current
  const pending = withExplorerEntryWrite(id, () => runExplorerRestore(kind, id, name))
  const tracked = pending.finally(() => {
    if (pendingExplorerRestores.get(id) === tracked) pendingExplorerRestores.delete(id)
  })
  pendingExplorerRestores.set(id, tracked)
  return tracked
}

async function runExplorerRestore(
  kind: 'folder' | 'file',
  id: string,
  name?: string
): Promise<void> {
  const db = await openFileExplorerDB()
  const record =
    kind === 'folder' ? await db.get('folder-records', id) : await db.get('folder-items', id)
  if (!record || !isPersonalRecordVisible(record)) throw new Error('Restore source is unavailable')
  if (record.personalOwnerId) {
    await mutateExplorerPersonalNode(record.personalOwnerId, id, {
      type: 'restore',
      ...(name ? { name: name.trim() } : {})
    })
    return
  }
  await filePersistenceQueue.commit(async () => {
    publishPersistedExplorerEntry(await restoreLocalCatalogEntry(kind, id, name))
  })
}

async function copyFileSnapshot(itemId: string, parentId: string): Promise<string | null> {
  const item = useFileExplorerStore.getState().items[itemId]
  if (!item || item.type !== 'file' || !isPersonalRecordVisible(item)) return null
  const db = await openFileExplorerDB()
  const { getBlobId } = await import('@renderer/lib/blob-identity')
  const source = await getFileSource(db, getBlobId(item), item.mimeType)
  if (!source) throw new Error('Copy source is not available offline')
  try {
    const response = await fetch(source.url)
    if (!response.ok) throw new Error('Copy source could not be read')
    const blob = await response.blob()
    if (!isPersonalRecordVisible(item)) throw new Error('Personal account changed')
    return addFileItemToStore(
      new File([blob], item.name, { type: item.mimeType }),
      parentId,
      item.mimeType,
      item.notes
    )
  } finally {
    source.revoke()
  }
}

export async function copyExplorerFolder(
  id: string,
  parentId: string,
  options: { includeDeleted?: boolean; name?: string } = {}
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
  const isLocalCopy = !source.personalOwnerId && !loaded.folders[parentId]?.personalOwnerId
  const target = await createExplorerFolder(
    options.name ?? source.name,
    parentId,
    isLocalCopy ? source.expiresAt : undefined
  )
  if (!target) throw new Error('Copy destination is unavailable')
  for (const item of items) {
    if (!(await copyExplorerFile(item.id, target))) throw new Error('File copy failed')
  }
  for (const folder of folders)
    await copyExplorerFolder(folder.id, target, { includeDeleted: options.includeDeleted })
  await useFileExplorerStore.getState().flushPersistence()
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
    if (!isPersonalNode(id))
      return runExplorerLocalAction([id], () => localFileActions.toggleFavorite(id))
    void import('@renderer/lib/personal-file-actions')
      .then((actions) => actions.togglePersonalFolderFavorite(id))
      .catch(reportPersonalWriteError)
  },
  updateFolder: (id, updates) => {
    if (!isPersonalNode(id)) {
      const patch = { ...updates }
      return runExplorerLocalAction([id], () => localFileActions.updateFolder(id, patch))
    }
    if (updates.name !== undefined) personalWrite(id, { type: 'rename', name: updates.name })
  },
  updateItem: (id, updates) => {
    if (!isPersonalNode(id)) {
      const patch = { ...updates }
      return runExplorerLocalAction([id, ...(updates.parentId ? [updates.parentId] : [])], () =>
        localFileActions.updateItem?.(id, patch)
      )
    }
    if ('name' in updates && updates.name !== undefined)
      personalWrite(id, { type: 'rename', name: updates.name })
    if ('notes' in updates) {
      void import('@renderer/lib/personal-file-actions')
        .then((actions) => actions.setPersonalFileNotes(id, updates.notes))
        .catch(reportPersonalWriteError)
    }
  },
  reorderItems: (parentId, orderedIds) => {
    const ids = [...orderedIds]
    return runExplorerLocalAction([parentId, ...ids], () =>
      localFileActions.reorderItems(parentId, ids)
    )
  },
  reorderFolders: (parentId, orderedIds) => {
    const ids = [...orderedIds]
    return runExplorerLocalAction([parentId, ...ids], () =>
      localFileActions.reorderFolders(parentId, ids)
    )
  },
  softDeleteFolder: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'delete' })
      : runExplorerLocalAction([id], () => localFileActions.softDeleteFolder(id)),
  softDeleteItem: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'delete' })
      : runExplorerLocalAction([id], () => localFileActions.softDeleteItem(id)),
  deleteFolder: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'delete' })
      : runExplorerLocalAction([id], () => localFileActions.deleteFolder(id)),
  removeItem: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'delete' })
      : runExplorerLocalAction([id], () => localFileActions.removeItem(id)),
  restoreFolder: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'restore' })
      : runExplorerLocalAction([id], () => localFileActions.restoreFolder(id)),
  restoreItem: (id) =>
    isPersonalNode(id)
      ? personalWrite(id, { type: 'restore' })
      : runExplorerLocalAction([id], () => localFileActions.restoreItem(id)),
  moveItem: (id, parentId) => {
    const source = useFileExplorerStore.getState().items[id]
    const destination = useFileExplorerStore.getState().folders[parentId]
    if (!source?.personalOwnerId && !destination?.personalOwnerId)
      return runExplorerLocalAction([id, parentId], () => localFileActions.moveItem(id, parentId))
    if (source?.personalOwnerId && source.personalOwnerId === destination?.personalOwnerId)
      personalWrite(id, { type: 'move', parentId })
    else void copyFileSnapshot(id, parentId).catch(reportPersonalWriteError)
  },
  moveFolder: (id, parentId) => {
    const state = useFileExplorerStore.getState()
    if (!state.folders[id]?.personalOwnerId && !state.folders[parentId]?.personalOwnerId)
      return runExplorerLocalAction([id, parentId], () => localFileActions.moveFolder(id, parentId))
    if (state.folders[id]?.personalOwnerId === state.folders[parentId]?.personalOwnerId)
      personalWrite(id, { type: 'move', parentId })
    else void copyExplorerFolder(id, parentId).catch(reportPersonalWriteError)
  }
})

async function copyLocalFileItem(itemId: string, targetFolderId: string): Promise<string | null> {
  const sourceItem = useFileExplorerStore.getState().items[itemId]
  if (!sourceItem || sourceItem.type !== 'file') return null
  if (
    Boolean(useFileExplorerStore.getState().folders[targetFolderId]?.personalOwnerId) ||
    isFolderReadOnlyBySyncLink(targetFolderId, useFileExplorerStore.getState().folders)
  )
    return null

  const newId = crypto.randomUUID()
  const targetSiblings = useFileExplorerStore.getState().getItems(targetFolderId)
  const now = Date.now()
  const copiedItem: FileItemRecord = {
    ...sourceItem,
    id: newId,
    parentId: targetFolderId,
    sortIndex: targetSiblings.length,
    createdAt: now,
    expiresAt: targetFolderId === FILE_EXPLORER_ROOT_ID ? now + FOLDER_DURATION_MS['1day'] : null,
    deletedAt: undefined,
    originalParentId: undefined
  }

  await useFileExplorerStore.getState().flushPersistence()
  await commitLocalFileItem({ ...copiedItem, type: 'file' }, { copyFromId: itemId })

  useFileExplorerStore.setState((state) => ({
    items: { ...state.items, [copiedItem.id]: copiedItem },
    _itemsArray: [...state._itemsArray, copiedItem],
    _itemsByParent: {
      ...state._itemsByParent,
      [targetFolderId]: [...(state._itemsByParent[targetFolderId] ?? []), copiedItem].sort(
        (a, b) => a.sortIndex - b.sortIndex
      )
    }
  }))
  return newId
}

export async function copyExplorerFile(id: string, parentId: string): Promise<string | null> {
  if (!isPersonalNode(id) && !isPersonalNode(parentId)) {
    const state = useFileExplorerStore.getState()
    const source = state.items[id]
    if (source && isFolderReadOnlyBySyncLink(source.parentId, state.folders))
      return copyFileSnapshot(id, parentId)
    return copyLocalFileItem(id, parentId)
  }
  try {
    return await copyFileSnapshot(id, parentId)
  } catch (error) {
    reportPersonalWriteError(error)
    return null
  }
}
