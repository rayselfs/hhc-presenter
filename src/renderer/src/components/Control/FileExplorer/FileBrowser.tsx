import { groupItemsByDate } from '@renderer/lib/file-explorer-grouping'
import { useSettingsStore } from '@renderer/stores/settings'
import { isPersonalRootFolder } from '@renderer/lib/sync-readonly'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { useCurrentFolderDisplay } from '@renderer/stores/file-explorer'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  rectSortingStrategy,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Folder, Upload } from 'lucide-react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useNavigate } from 'react-router-dom'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { useConfirm } from '@renderer/contexts/ConfirmDialogContext'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import { useItemSelection } from '@renderer/hooks/useItemSelection'
import { useOsFileDrop } from '@renderer/hooks/useOsFileDrop'
import { useThumbnails, canHaveThumbnail } from '@renderer/hooks/useThumbnails'
import { compareByField } from '@renderer/lib/file-explorer-sort'
import { searchAllItems } from '@renderer/lib/file-explorer-search'
import {
  FILE_EXPLORER_ROOT_ID,
  deleteFolderFromStore,
  removeFileItemFromStore,
  useFileExplorerCustomOrder,
  useFileExplorerSearch,
  useFileExplorerSettings,
  useFileExplorerStore
} from '@renderer/stores/file-explorer'
import { uploadFromDataTransfer } from '@renderer/lib/upload-utils'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import type { ClipboardState } from '@renderer/components/Control/FileExplorer'
import { getFileIcon } from './views/getFileIcon'
import { GridView, ListView, type GridViewItem } from './views'
import type { SearchResult } from '@renderer/lib/file-explorer-search'
import { formatFileKind } from '@renderer/lib/format-file-kind'
import { isPresentable } from '@renderer/lib/presentability'
import { getExplorerProjectionPlaylist } from '@renderer/lib/file-explorer-projection'
import { presentMediaItem, startMediaProjection } from '@renderer/lib/projection-actions'
import type { SortField } from '@renderer/stores/file-explorer'
import { hasNameConflict, splitFileName, validateDisplayName } from '@renderer/lib/file-naming'
import {
  listSyncEntries,
  SYNC_ENTRY_CHANGED_EVENT,
  type SyncEntryRecord,
  type SyncEntryStatus
} from '@renderer/lib/sync-db'
import { deriveSyncFolderHealth, type SyncFolderHealth } from '@renderer/lib/sync-folder-health'
import { buildFolderViewItem } from '@renderer/lib/file-view-item'
import { getSourceMediaMetadata } from '@renderer/lib/media-metadata'
import { getBlobId } from '@renderer/lib/blob-identity'
import { isWeb } from '@renderer/lib/env'
import { getPresentationWorkspacePath, isPresentationItem } from '@renderer/lib/presentation-media'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import { listMediaJobs, subscribeMediaJobs } from '@renderer/lib/media-work-db'
import { buildMediaJobViewState, type MediaJobViewState } from '@renderer/lib/media-job-view-state'
import { formatLocalDateTime } from '@renderer/lib/format-local-date-time'

export interface FileBrowserProps {
  onItemContextMenu?: (itemId: string, event: React.MouseEvent) => void
  onFolderContextMenu?: (folderId: string, event: React.MouseEvent) => void
  onEmptyAreaContextMenu?: (event: React.MouseEvent) => void
  onSelectionChange?: (selectedIds: Set<string>) => void
  onCopy?: (selectedIds: Set<string>) => void
  onCut?: (selectedIds: Set<string>) => void
  onDelete?: (selectedIds: Set<string>) => void | Promise<void>
  onPaste?: () => void
  clipboard?: ClipboardState | null
  onEscape?: () => void
  renameItemRequestId?: string | null
  onRenameItemRequestHandled?: () => void
  isCurrentFolderReadOnly?: boolean
}

type FileExplorerDndData =
  | { type: 'folder'; item: FolderRecord }
  | { type: 'item'; item: FileItemRecord }
  | { type: 'folder-dropzone'; folderId: string }

interface SortableViewItemProps {
  item: GridViewItem
  folder?: FolderRecord
  file?: FileItemRecord
  isDraggedAway: boolean
  isMultiDrag: boolean
  isCut?: boolean
  isOsDragTarget?: boolean
  onPointerDown?: (itemId: string, event: React.PointerEvent) => void
  onPointerMove?: (itemId: string, event: React.PointerEvent) => void
  children: React.ReactNode
}

interface SyncItemViewState {
  status: SyncEntryStatus
  downloadedBytes?: number
  downloadTotalBytes?: number
}

function formatSyncFolderHealthTooltip(health: SyncFolderHealth, t: TFunction): string {
  const parts = [
    t('fileExplorer.syncHealth.lastSync', {
      value: health.lastSyncedAt
        ? new Date(health.lastSyncedAt).toLocaleString()
        : t('fileExplorer.syncHealth.unknown')
    }),
    t('fileExplorer.syncHealth.downloading', { value: health.downloadingCount }),
    t('fileExplorer.syncHealth.queued', { value: health.queuedCount }),
    t('fileExplorer.syncHealth.failed', { value: health.failedCount })
  ]
  if (health.nextRetryAt) {
    parts.push(
      t('fileExplorer.syncHealth.nextRetry', {
        value: new Date(health.nextRetryAt).toLocaleString()
      })
    )
  }
  return parts.join('\n')
}

function isFileItemRecord(item: unknown): item is FileItemRecord {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'file' &&
    'name' in item &&
    'mimeType' in item &&
    'size' in item
  )
}

function SortableViewItem({
  item,
  folder,
  file,
  isDraggedAway,
  isMultiDrag,
  isCut,
  isOsDragTarget,
  onPointerDown,
  onPointerMove,
  children
}: SortableViewItemProps): React.JSX.Element {
  const sortable = useSortable({
    id: item.id,
    data: item.isFolder
      ? ({ type: 'folder', item: folder } as FileExplorerDndData)
      : ({ type: 'item', item: file } as FileExplorerDndData)
  })
  const droppable = useDroppable({
    id: `drop-${item.id}`,
    data: { type: 'folder-dropzone', folderId: item.id } as FileExplorerDndData,
    disabled: !item.isFolder || isDraggedAway
  })

  const sortableRef = sortable.setNodeRef
  const droppableRef = droppable.setNodeRef
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      sortableRef(el)
      if (item.isFolder) droppableRef(el)
    },
    [item.isFolder, sortableRef, droppableRef]
  )

  const style: React.CSSProperties = {
    transform: isMultiDrag ? undefined : CSS.Transform.toString(sortable.transform),
    transition: isMultiDrag ? undefined : sortable.transition,
    opacity: sortable.isDragging || isDraggedAway ? 0.4 : isCut ? 0.4 : 1
  }

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      onPointerDown?.(item.id, event)
      sortable.listeners?.onPointerDown?.(event)
    },
    [item.id, onPointerDown, sortable.listeners]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      onPointerMove?.(item.id, event)
      sortable.listeners?.onPointerMove?.(event)
    },
    [item.id, onPointerMove, sortable.listeners]
  )

  return (
    <div
      ref={setRef}
      style={style}
      data-file-item
      data-item-id={item.id}
      {...(item.isFolder ? { 'data-folder-id': item.id } : {})}
      className={`touch-none rounded-lg${isOsDragTarget ? ' ring-2 ring-inset ring-primary/50' : ''}${droppable.isOver && item.isFolder ? ' bg-surface' : ''}`}
      {...sortable.attributes}
      {...sortable.listeners}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    >
      {children}
    </div>
  )
}

function DragOverlayContent({
  name,
  count,
  isFolder,
  mimeType
}: {
  name: string
  count: number
  isFolder: boolean
  mimeType?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg bg-default-100 px-3 py-2 text-sm text-foreground shadow-lg ring-1 ring-border flex items-center gap-2">
      <div className="flex-shrink-0">
        {isFolder ? (
          <Folder size={16} className="text-accent" fill="currentColor" />
        ) : (
          <div className="text-danger">{getFileIcon(mimeType, false, 16)}</div>
        )}
      </div>
      {count > 1 ? t('fileExplorer.status.itemCount', { count }) : name}
    </div>
  )
}

function formatSearchFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

const SEARCH_COL = { created: 160, size: 72, kind: 96, path: 200 }
const EMPTY_ARRAY: never[] = []
const SLOW_CLICK_RENAME_MIN_MS = 320

function SearchResultsList({
  results,
  selectedId,
  onSelectId,
  onFileClick,
  onFolderClick
}: {
  results: SearchResult[]
  selectedId: string | null
  onSelectId: (id: string) => void
  onFileClick: (result: SearchResult & { kind: 'file' }) => void
  onFolderClick: (result: SearchResult & { kind: 'folder' }) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 bg-background z-10 border-b border-default-200">
        <div className="flex items-center px-3 py-1.5">
          <div className="w-6 flex-shrink-0 mr-3" />
          <div className="flex-1 min-w-0 text-xs font-medium text-default-400 uppercase tracking-wide">
            {t('fileExplorer.list.name', 'Name')}
          </div>
          <div
            className="flex-shrink-0 text-xs font-medium text-default-400 uppercase tracking-wide pl-2"
            style={{ width: SEARCH_COL.created }}
          >
            {t('fileExplorer.list.createdAt', 'Created')}
          </div>
          <div
            className="flex-shrink-0 text-xs font-medium text-default-400 uppercase tracking-wide pl-2"
            style={{ width: SEARCH_COL.size }}
          >
            {t('fileExplorer.list.size', 'Size')}
          </div>
          <div
            className="flex-shrink-0 text-xs font-medium text-default-400 uppercase tracking-wide pl-2"
            style={{ width: SEARCH_COL.kind }}
          >
            {t('fileExplorer.list.kind', 'Kind')}
          </div>
          <div
            className="flex-shrink-0 text-xs font-medium text-default-400 uppercase tracking-wide pl-2"
            style={{ width: SEARCH_COL.path }}
          >
            {t('fileExplorer.list.path', 'Path')}
          </div>
        </div>
      </div>

      <div className="flex flex-col p-2">
        {results.map((result) => {
          const isFile = result.kind === 'file'
          const id = isFile ? result.item.id : result.folder.id
          const name = isFile ? result.item.name : result.folder.name
          const mimeType = isFile ? result.item.mimeType : undefined
          const size = isFile ? result.item.size : undefined
          const createdAt = isFile ? result.item.createdAt : result.folder.createdAt
          const isSelected = selectedId === id

          return (
            <div
              key={id}
              className={`flex items-center rounded-md px-3 py-2 cursor-default transition-colors hover:bg-content2/60 ${isSelected ? 'bg-surface' : ''}`}
              onClick={() => onSelectId(id)}
              onDoubleClick={() => {
                if (result.kind === 'file') onFileClick(result)
                else onFolderClick(result)
              }}
            >
              <div className="flex-shrink-0 w-6 flex items-center justify-center mr-3">
                {!isFile ? (
                  <Folder size={20} className="text-accent" fill="currentColor" />
                ) : (
                  <div className="text-danger">{getFileIcon(mimeType, false, 20)}</div>
                )}
              </div>
              <div className="flex-1 min-w-0 truncate text-sm text-foreground" title={name}>
                {name}
              </div>
              <div
                className="flex-shrink-0 text-sm text-default-400 pl-2"
                style={{ width: SEARCH_COL.created }}
              >
                {formatLocalDateTime(createdAt)}
              </div>
              <div
                className="flex-shrink-0 text-sm text-default-400 pl-2"
                style={{ width: SEARCH_COL.size }}
              >
                {!isFile ? '—' : formatSearchFileSize(size)}
              </div>
              <div
                className="flex-shrink-0 text-sm text-default-400 truncate pl-2"
                style={{ width: SEARCH_COL.kind }}
              >
                {formatFileKind(mimeType, !isFile, t)}
              </div>
              <div
                className="flex-shrink-0 text-sm text-default-400 truncate pl-2"
                style={{ width: SEARCH_COL.path }}
              >
                {result.folderPath}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function FileBrowser({
  onItemContextMenu,
  onFolderContextMenu,
  onEmptyAreaContextMenu,
  onSelectionChange,
  onCopy,
  onCut,
  onDelete,
  onPaste,
  clipboard,
  onEscape,
  renameItemRequestId,
  onRenameItemRequestHandled,
  isCurrentFolderReadOnly = false
}: FileBrowserProps): React.JSX.Element {
  const { ensureProjectionOpen } = useProjection()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const currentFolderId = useFileExplorerStore((state) => state.currentFolderId)
  const rawFolders = useFileExplorerStore(
    (s) => s._childFoldersByParent[s.currentFolderId] ?? EMPTY_ARRAY
  )
  const rawItems = useFileExplorerStore((s) => s._itemsByParent[s.currentFolderId] ?? EMPTY_ARRAY)
  const navigateToFolder = useFileExplorerStore((state) => state.navigateToFolder)
  const toggleFavorite = useFileExplorerStore((state) => state.toggleFavorite)
  const moveItem = useFileExplorerStore((state) => state.moveItem)
  const openPresentationDocument = usePresentationWorkspaceStore((state) => state.openDocument)
  const moveFolder = useFileExplorerStore((state) => state.moveFolder)
  const customOrders = useFileExplorerCustomOrder((state) => state.orders)
  const setCustomOrder = useFileExplorerCustomOrder((state) => state.setOrder)
  const { viewMode, sortField, sortDir, setSortFieldAndDir, setSortDir, groupMode, groupSortDir } =
    useCurrentFolderDisplay()
  const colWidths = useFileExplorerSettings((state) => state.colWidths)
  const setColWidths = useFileExplorerSettings((state) => state.setColWidths)
  const searchQuery = useFileExplorerSearch((state) => state.searchQuery)
  const setSearchQuery = useFileExplorerSearch((state) => state.setSearchQuery)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [draggedIds, setDraggedIds] = useState<Set<string>>(new Set())
  const [selectedSearchId, setSelectedSearchId] = useState<string | null>(null)
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null)
  const [syncStates, setSyncStates] = useState<Record<string, SyncItemViewState>>({})
  const [syncEntries, setSyncEntries] = useState<SyncEntryRecord[]>([])
  const [unsupportedMediaIds, setUnsupportedMediaIds] = useState<Set<string>>(new Set())
  const [mediaJobStates, setMediaJobStates] = useState<Record<string, MediaJobViewState>>({})
  const renameClickTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRenameItemIdRef = React.useRef<string | null>(null)
  const pointerRef = React.useRef<{
    itemId: string
    x: number
    y: number
    moved: boolean
  } | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 }
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 }
    })
  )

  const folders = useMemo(
    () =>
      rawFolders
        .filter((folder) => !folder.deletedAt && !isPersonalRootFolder(folder))
        .sort((a, b) => a.sortIndex - b.sortIndex),
    [rawFolders]
  )
  const fileItems = useMemo(
    () =>
      rawItems
        .filter((item): item is FileItemRecord => isFileItemRecord(item) && !item.deletedAt)
        .sort((a, b) => a.sortIndex - b.sortIndex),
    [rawItems]
  )
  const searchRevision = [
    ...rawFolders.map((folder) => `${folder.id}:${folder.name}:${folder.deletedAt ?? ''}`),
    ...rawItems.map(
      (item) => `${item.id}:${'name' in item ? item.name : ''}:${item.deletedAt ?? ''}`
    )
  ].join('|')

  const searchResults = useMemo(() => {
    void searchRevision
    if (!searchQuery.trim()) return []
    const raw = searchAllItems(
      searchQuery,
      useFileExplorerStore.getState(),
      t(
        useFileExplorerStore.getState().folders[currentFolderId]?.personalOwnerId
          ? 'nav.cloudFiles'
          : 'fileExplorer.breadcrumb.root'
      ),
      useFileExplorerStore.getState().folders[currentFolderId]?.personalOwnerId ?? null
    )
    return [...raw].sort((a, b) => {
      const nameA = a.kind === 'file' ? a.item.name : a.folder.name
      const nameB = b.kind === 'file' ? b.item.name : b.folder.name
      return nameA.localeCompare(nameB)
    })
  }, [currentFolderId, searchQuery, searchRevision, t])

  const thumbnails = useThumbnails(fileItems, { pendingAgeMs: 2 * 60 * 1000 })

  const syncFolderHealthById = useMemo(() => {
    const next: Record<string, SyncFolderHealth> = {}
    for (const folder of folders) {
      if (folder.parentId !== FILE_EXPLORER_ROOT_ID || !folder.syncLink) continue
      next[folder.id] = deriveSyncFolderHealth(syncEntries, folder)
    }
    return next
  }, [folders, syncEntries])

  useEffect(() => {
    let cancelled = false
    async function loadSyncStatuses(): Promise<void> {
      const ids = new Set([
        ...folders.map((folder) => folder.id),
        ...fileItems.map((item) => item.id)
      ])
      if (ids.size === 0) {
        setSyncStates({})
        setSyncEntries([])
        return
      }
      try {
        const entries = await listSyncEntries()
        if (cancelled) return
        setSyncEntries(entries)
        const next: Record<string, SyncItemViewState> = {}
        for (const entry of entries) {
          const localId = entry.itemId ?? entry.folderId
          if (localId && ids.has(localId)) {
            next[localId] = {
              status: entry.status,
              downloadedBytes: entry.downloadedBytes,
              downloadTotalBytes: entry.downloadTotalBytes
            }
          }
        }
        setSyncStates(next)
      } catch {
        if (!cancelled) {
          setSyncStates({})
          setSyncEntries([])
        }
      }
    }
    const handleSyncEntryChanged = (): void => {
      void loadSyncStatuses()
    }
    void loadSyncStatuses()
    window.addEventListener(SYNC_ENTRY_CHANGED_EVENT, handleSyncEntryChanged)
    return () => {
      cancelled = true
      window.removeEventListener(SYNC_ENTRY_CHANGED_EVENT, handleSyncEntryChanged)
    }
  }, [folders, fileItems])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const next = buildMediaJobViewState(await listMediaJobs())
      if (!cancelled) setMediaJobStates(next)
    }
    void load()
    const unsubscribe = subscribeMediaJobs(() => void load())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!isWeb()) {
      setUnsupportedMediaIds(new Set())
      return
    }

    let cancelled = false
    async function loadUnsupportedMedia(): Promise<void> {
      const next = new Set<string>()
      await Promise.all(
        fileItems
          .filter((item) => item.mimeType.startsWith('video/'))
          .map(async (item) => {
            const metadata = await getSourceMediaMetadata(getBlobId(item))
            if (metadata?.browserPlayback === 'unplayable') next.add(item.id)
          })
      )
      if (!cancelled) setUnsupportedMediaIds(next)
    }

    const onMetadataReady = (): void => {
      void loadUnsupportedMedia()
    }

    void loadUnsupportedMedia()
    window.addEventListener('hhc:media-metadata-ready', onMetadataReady)
    return () => {
      cancelled = true
      window.removeEventListener('hhc:media-metadata-ready', onMetadataReady)
    }
  }, [fileItems])

  const personalStatuses = usePersonalSyncStore((state) => state.itemStatuses)
  const allItems: GridViewItem[] = useMemo(
    () => [
      ...folders.map((folder) => ({
        ...buildFolderViewItem(folder, {
          health: syncFolderHealthById[folder.id],
          healthTooltip: syncFolderHealthById[folder.id]
            ? formatSyncFolderHealthTooltip(syncFolderHealthById[folder.id], t)
            : undefined,
          syncState: syncStates[folder.id]
        }),
        personalStatus: personalStatuses[folder.id]
      })),
      ...fileItems.map((item) => ({
        id: item.id,
        name: item.name,
        personalStatus: personalStatuses[item.id],
        isFolder: false,
        mimeType: item.mimeType,
        size: item.size,
        createdAt: item.createdAt,
        thumbnailUrl:
          unsupportedMediaIds.has(item.id) || item.url.startsWith('unsupported:')
            ? null
            : canHaveThumbnail(item.mimeType)
              ? thumbnails[item.id]
              : null,
        isSelected: false,
        syncStatus: syncStates[item.id]?.status,
        downloadedBytes: syncStates[item.id]?.downloadedBytes,
        downloadTotalBytes: syncStates[item.id]?.downloadTotalBytes,
        processingStatus: mediaJobStates[item.id]?.status,
        processingProgress: mediaJobStates[item.id]?.progress,
        isUnsupportedMedia: unsupportedMediaIds.has(item.id) || item.url.startsWith('unsupported:')
      }))
    ],
    [
      folders,
      personalStatuses,
      fileItems,
      syncFolderHealthById,
      thumbnails,
      syncStates,
      mediaJobStates,
      unsupportedMediaIds,
      t
    ]
  )

  const timezone = useSettingsStore((state) => state.timezone)
  const orderedItems = useMemo(() => {
    const foldersSubset = allItems.filter((item) => item.isFolder)
    const filesSubset = allItems.filter((item) => !item.isFolder)
    if (sortDir !== 'none') {
      foldersSubset.sort((a, b) => compareByField(a, b, sortField, sortDir))
      filesSubset.sort((a, b) => compareByField(a, b, sortField, sortDir))
      return [...foldersSubset, ...filesSubset]
    }
    const customOrder = customOrders[currentFolderId]
    if (!customOrder) {
      return [...foldersSubset, ...filesSubset]
    }
    const itemMap = new Map(allItems.map((item) => [item.id, item]))
    const ordered: GridViewItem[] = []
    for (const id of customOrder) {
      const item = itemMap.get(id)
      if (item) ordered.push(item)
    }
    const orderedIds = new Set(customOrder)
    const newFolders = foldersSubset.filter((item) => !orderedIds.has(item.id))
    const newFiles = filesSubset.filter((item) => !orderedIds.has(item.id))
    return [...ordered, ...newFolders, ...newFiles]
  }, [allItems, sortField, sortDir, currentFolderId, customOrders])

  const sortedItems = useMemo(
    () =>
      groupMode === 'date' ? groupItemsByDate(orderedItems, timezone, groupSortDir) : orderedItems,
    [orderedItems, groupMode, timezone, groupSortDir]
  )

  const sortedFileItems = useMemo(() => {
    const fileItemMap = new Map(fileItems.map((f) => [f.id, f]))
    return sortedItems
      .filter((item) => !item.isFolder)
      .map((item) => fileItemMap.get(item.id))
      .filter((item): item is FileItemRecord => item !== undefined)
  }, [sortedItems, fileItems])

  const allIds = useMemo(() => sortedItems.map((item) => item.id), [sortedItems])
  const folderIds = useMemo(
    () => sortedItems.filter((item) => item.isFolder).map((item) => item.id),
    [sortedItems]
  )
  const activeItem = activeId ? sortedItems.find((item) => item.id === activeId) : null
  const isMultiDrag = draggedIds.size > 1

  const {
    selectedIds,
    setSelectedIds,
    clearSelection,
    selectAll,
    handleItemClick,
    handleContainerClick,
    handleContainerMouseDown,
    rubberBandRect,
    containerRef
  } = useItemSelection(allIds)

  const {
    isOsDragOver,
    osDragTargetFolderId,
    handlers: osDragHandlers
  } = useOsFileDrop(containerRef, {
    onDrop: async (dataTransfer, targetId) => {
      if (isCurrentFolderReadOnly) return
      await uploadFromDataTransfer(dataTransfer.items, targetId ?? currentFolderId)
    }
  })

  const sortedItemsWithSelection = useMemo(
    () => sortedItems.map((i) => ({ ...i, isSelected: selectedIds.has(i.id) })),
    [sortedItems, selectedIds]
  )

  const cancelPendingRename = useCallback((): void => {
    if (renameClickTimerRef.current) {
      clearTimeout(renameClickTimerRef.current)
      renameClickTimerRef.current = null
    }
    pendingRenameItemIdRef.current = null
  }, [])

  useEffect(() => {
    onSelectionChange?.(selectedIds)
  }, [selectedIds, onSelectionChange])

  useEffect(() => {
    clearSelection()
  }, [currentFolderId, clearSelection])

  useEffect(() => {
    setSelectedSearchId(null)
  }, [searchQuery])

  useEffect(() => {
    if (!renameItemRequestId) return
    const item = sortedItems.find((entry) => entry.id === renameItemRequestId)
    if (item && !item.isFolder) {
      setSelectedIds(new Set([renameItemRequestId]))
      if (!isCurrentFolderReadOnly) setRenamingItemId(renameItemRequestId)
    }
    onRenameItemRequestHandled?.()
  }, [
    renameItemRequestId,
    sortedItems,
    setSelectedIds,
    onRenameItemRequestHandled,
    isCurrentFolderReadOnly
  ])

  useEffect(() => {
    cancelPendingRename()
    setRenamingItemId(null)
  }, [cancelPendingRename, currentFolderId, viewMode])

  useEffect(() => {
    const pendingItemId = pendingRenameItemIdRef.current
    if (pendingItemId && (!selectedIds.has(pendingItemId) || selectedIds.size !== 1)) {
      cancelPendingRename()
    }
  }, [cancelPendingRename, selectedIds])

  useEffect(() => {
    return () => cancelPendingRename()
  }, [cancelPendingRename])

  const handleEscape = useCallback((): void => {
    if (renamingItemId) {
      setRenamingItemId(null)
      return
    }
    clearSelection()
    onEscape?.()
  }, [clearSelection, onEscape, renamingItemId])

  const handleContainerContextMenu = useCallback(
    (event: React.MouseEvent): void => {
      if ((event.target as Element).closest('[data-file-item]')) return
      event.preventDefault()
      onEmptyAreaContextMenu?.(event)
    },
    [onEmptyAreaContextMenu]
  )

  const handleItemContextMenu = useCallback(
    (itemId: string, event: React.MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      cancelPendingRename()
      if (!selectedIds.has(itemId)) setSelectedIds(new Set([itemId]))
      const item = sortedItems.find((entry) => entry.id === itemId)
      if (item?.isFolder) {
        onFolderContextMenu?.(itemId, event)
      } else {
        onItemContextMenu?.(itemId, event)
      }
    },
    [
      sortedItems,
      selectedIds,
      setSelectedIds,
      onFolderContextMenu,
      onItemContextMenu,
      cancelPendingRename
    ]
  )

  const handleItemDoubleClick = useCallback(
    (itemId: string, event: React.MouseEvent): void => {
      cancelPendingRename()
      event.stopPropagation()
      const item = sortedItems.find((entry) => entry.id === itemId)
      if (item?.isFolder) {
        void navigateToFolder(itemId)
        return
      }
      const file = fileItems.find((entry) => entry.id === itemId)
      if (file && isPresentationItem(file)) {
        openPresentationDocument(file)
        navigate(getPresentationWorkspacePath(file.id))
        return
      }
      if (file && isPresentable(file.mimeType)) {
        const playlist = getExplorerProjectionPlaylist(sortedFileItems, file)
        void presentMediaItem({
          item: file,
          playlist,
          start: (items, startIndex, _, options) =>
            startMediaProjection(
              items,
              startIndex,
              {
                ensureProjectionOpen,
                onNoProjectableFiles: () => toast.warning(t('fileExplorer.noProjectableFiles'))
              },
              options
            ),
          navigate
        }).catch(() => undefined)
      }
    },
    [
      cancelPendingRename,
      sortedItems,
      fileItems,
      sortedFileItems,
      navigateToFolder,
      openPresentationDocument,
      navigate,
      ensureProjectionOpen,
      t
    ]
  )

  const handleRenameSubmit = useCallback(
    (itemId: string, baseName: string): void => {
      const folder = useFileExplorerStore.getState().folders[itemId]
      if (folder && isPersonalRootFolder(folder)) {
        setRenamingItemId(null)
        return
      }
      if (isCurrentFolderReadOnly) {
        setRenamingItemId(null)
        return
      }
      const item = sortedItems.find((entry) => entry.id === itemId)
      if (!item) {
        setRenamingItemId(null)
        return
      }

      const trimmedBase = baseName.trim()
      if (!validateDisplayName(trimmedBase)) {
        toast.danger(t('fileExplorer.invalidName', 'Invalid name'))
        return
      }

      if (item.isFolder) {
        const folder = folders.find((entry) => entry.id === itemId)
        if (!folder) {
          setRenamingItemId(null)
          return
        }
        const siblingNames = folders
          .filter((entry) => entry.parentId === folder.parentId)
          .map((entry) => entry.name)
        if (hasNameConflict(trimmedBase, siblingNames, { excludeName: folder.name })) {
          toast.danger(
            t('fileExplorer.folderAlreadyExists', 'A folder with this name already exists')
          )
          return
        }
        useFileExplorerStore.getState().updateFolder(itemId, { name: trimmedBase })
      } else {
        const file = fileItems.find((entry) => entry.id === itemId)
        if (!file) {
          setRenamingItemId(null)
          return
        }
        const { extension } = splitFileName(file.name)
        const nextName = `${trimmedBase}${extension}`
        const siblingNames = fileItems
          .filter((entry) => entry.parentId === file.parentId)
          .map((entry) => entry.name)
        if (hasNameConflict(nextName, siblingNames, { excludeName: file.name })) {
          toast.danger(t('fileExplorer.fileAlreadyExists', 'A file with this name already exists'))
          return
        }
        useFileExplorerStore.getState().updateItem?.(itemId, { name: nextName })
      }
      setRenamingItemId(null)
    },
    [fileItems, folders, sortedItems, t, isCurrentFolderReadOnly]
  )

  const handleRenameCancel = useCallback((): void => {
    cancelPendingRename()
    setRenamingItemId(null)
  }, [cancelPendingRename])

  const handleItemPointerDown = useCallback(
    (itemId: string, event: React.PointerEvent): void => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
        pointerRef.current = null
        cancelPendingRename()
        return
      }

      pointerRef.current = {
        itemId,
        x: event.clientX,
        y: event.clientY,
        moved: false
      }
    },
    [cancelPendingRename]
  )

  const handleItemPointerMove = useCallback(
    (itemId: string, event: React.PointerEvent): void => {
      const pointer = pointerRef.current
      if (!pointer || pointer.itemId !== itemId) return
      if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) {
        pointer.moved = true
        cancelPendingRename()
      }
    },
    [cancelPendingRename]
  )

  const handleViewItemClick = useCallback(
    (itemId: string, event: React.MouseEvent): void => {
      const wasAlreadySelected = selectedIds.has(itemId) && selectedIds.size === 1
      const isNameRegion = (event.target as Element).closest('[data-file-name-region]') !== null
      const pointer = pointerRef.current
      const hadPointerMovement = pointer?.itemId === itemId && pointer.moved
      handleItemClick(itemId, event)

      if (
        event.button !== 0 ||
        event.detail > 1 ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        hadPointerMovement
      ) {
        cancelPendingRename()
        return
      }

      if (!wasAlreadySelected) {
        cancelPendingRename()
        return
      }

      const item = sortedItems.find((entry) => entry.id === itemId)
      if (!item) return
      const folder = useFileExplorerStore.getState().folders[itemId]
      if (folder && isPersonalRootFolder(folder)) return
      if (isNameRegion && !isCurrentFolderReadOnly) {
        cancelPendingRename()
        pendingRenameItemIdRef.current = itemId
        renameClickTimerRef.current = setTimeout(() => {
          setRenamingItemId(itemId)
          renameClickTimerRef.current = null
          pendingRenameItemIdRef.current = null
        }, SLOW_CLICK_RENAME_MIN_MS)
      }
    },
    [cancelPendingRename, handleItemClick, selectedIds, sortedItems, isCurrentFolderReadOnly]
  )

  const handleDeleteSelected = useCallback(async (): Promise<void> => {
    if (isCurrentFolderReadOnly) return
    if (selectedIds.size === 0) return
    if (onDelete) {
      await onDelete(new Set(selectedIds))
      clearSelection()
      return
    }

    const confirmed = await confirm({
      title: t('folder.deleteSelectedTitle', {
        count: selectedIds.size,
        defaultValue: `Delete ${selectedIds.size} item(s)?`
      }),
      description: t('folder.deleteItemDescription', 'This action cannot be undone.'),
      status: 'danger'
    })

    if (!confirmed) return

    for (const id of selectedIds) {
      if (folderIds.includes(id)) {
        await deleteFolderFromStore(id)
      } else {
        await removeFileItemFromStore(id)
      }
    }
    clearSelection()
  }, [selectedIds, onDelete, confirm, t, folderIds, clearSelection, isCurrentFolderReadOnly])

  const handleCopySelected = useCallback((): void => {
    if (selectedIds.size === 0) return
    onCopy?.(selectedIds)
  }, [selectedIds, onCopy])

  const handleCutSelected = useCallback((): void => {
    if (isCurrentFolderReadOnly) return
    if (selectedIds.size === 0) return
    onCut?.(selectedIds)
  }, [selectedIds, onCut, isCurrentFolderReadOnly])

  const handlePasteSelected = useCallback((): void => {
    if (isCurrentFolderReadOnly) return
    onPaste?.()
  }, [onPaste, isCurrentFolderReadOnly])

  useKeyboardShortcuts(
    [
      { config: SHORTCUTS.EDIT.SELECT_ALL, handler: selectAll, preventDefault: true },
      { config: SHORTCUTS.EDIT.COPY, handler: handleCopySelected, preventDefault: true },
      { config: SHORTCUTS.EDIT.CUT, handler: handleCutSelected, preventDefault: true },
      { config: SHORTCUTS.EDIT.PASTE, handler: handlePasteSelected, preventDefault: true },
      { config: SHORTCUTS.EDIT.ESCAPE, handler: handleEscape, preventDefault: true },
      {
        config: SHORTCUTS.EDIT.DELETE,
        handler: () => void handleDeleteSelected(),
        preventDefault: true
      },
      {
        config: SHORTCUTS.EDIT.DELETE_ALT,
        handler: () => void handleDeleteSelected(),
        preventDefault: true
      },
      {
        config: SHORTCUTS.MEDIA.START_FROM_CURRENT,
        handler: () => {
          const requestedItem = sortedFileItems.find((item) => selectedIds.has(item.id))
          const playlist = getExplorerProjectionPlaylist(sortedFileItems, requestedItem)
          if (playlist.length === 0) {
            toast.warning(t('fileExplorer.noProjectableFiles'))
            return
          }
          const startIndex = requestedItem
            ? playlist.findIndex((entry) => entry.id === requestedItem.id)
            : 0
          if (startIndex < 0) return
          void startMediaProjection(
            playlist,
            startIndex,
            {
              ensureProjectionOpen,
              onNoProjectableFiles: () => toast.warning(t('fileExplorer.noProjectableFiles'))
            },
            { prioritizeStartItem: true }
          )
            .then((report) => {
              if (report.summary.ready > 0) navigate('/media')
            })
            .catch(() => undefined)
        },
        preventDefault: true
      }
    ],
    { enabled: true, sectionKey: 'edit' }
  )

  const handleSortChange = useCallback(
    (field: SortField) => {
      if (sortDir === 'none' || field !== sortField) {
        setSortFieldAndDir(field, 'asc')
      } else if (sortDir === 'asc') {
        setSortDir('desc')
      } else {
        setSortDir('asc')
      }
    },
    [sortField, sortDir, setSortDir, setSortFieldAndDir]
  )

  const handleDragStart = useCallback(
    (event: DragStartEvent): void => {
      if (isCurrentFolderReadOnly) return
      setRenamingItemId(null)
      cancelPendingRename()
      pointerRef.current = null
      const nextActiveId = String(event.active.id)
      setActiveId(nextActiveId)

      if (selectedIds.has(nextActiveId)) {
        setDraggedIds(new Set(selectedIds))
      } else {
        setSelectedIds(new Set([nextActiveId]))
        setDraggedIds(new Set([nextActiveId]))
      }
    },
    [cancelPendingRename, selectedIds, setSelectedIds, isCurrentFolderReadOnly]
  )

  const handleDragOver = useCallback((): void => {}, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      if (isCurrentFolderReadOnly) return
      const currentDraggedIds = draggedIds
      setActiveId(null)
      setDraggedIds(new Set())

      const { active, over } = event
      const catalog = useFileExplorerStore.getState().folders
      if (
        [String(active.id), ...currentDraggedIds].some(
          (id) => catalog[id] && isPersonalRootFolder(catalog[id])
        )
      )
        return
      if (!over || active.id === over.id) return

      const activeData = active.data.current as FileExplorerDndData | undefined
      const overData = over.data.current as FileExplorerDndData | undefined
      if (!activeData) return

      if (overData?.type === 'folder-dropzone') {
        const targetFolderId = overData.folderId
        for (const id of currentDraggedIds.size > 0
          ? currentDraggedIds
          : new Set([String(active.id)])) {
          if (id === targetFolderId) continue
          if (folderIds.includes(id)) {
            moveFolder(id, targetFolderId)
          } else {
            moveItem(id, targetFolderId)
          }
        }
        return
      }

      if (currentDraggedIds.size > 1) return

      const allSortedIds = sortedItems.map((item) => item.id)
      const oldIndex = allSortedIds.indexOf(String(active.id))
      const newIndex = allSortedIds.indexOf(String(over.id))
      if (
        groupMode === 'date' &&
        sortedItems[oldIndex]?.dateGroup !== sortedItems[newIndex]?.dateGroup
      )
        return
      if (oldIndex !== -1 && newIndex !== -1) {
        setCustomOrder(currentFolderId, arrayMove(allSortedIds, oldIndex, newIndex))
        setSortDir('none')
      }
    },
    [
      draggedIds,
      groupMode,
      folderIds,
      sortedItems,
      currentFolderId,
      moveFolder,
      moveItem,
      setCustomOrder,
      setSortDir,
      isCurrentFolderReadOnly
    ]
  )

  const customCollisionDetection: CollisionDetection = useCallback((args) => {
    const folderDropZones = args.droppableContainers.filter((container) => {
      const data = container.data.current as FileExplorerDndData | undefined
      if (data?.type !== 'folder-dropzone') return false
      if (args.active && container.id === `drop-${String(args.active.id)}`) return false
      const rect = args.droppableRects.get(container.id)
      const pointer = args.pointerCoordinates
      if (!rect || !pointer) return false
      return (
        pointer.x > rect.left + rect.width * 0.25 &&
        pointer.x < rect.right - rect.width * 0.25 &&
        pointer.y > rect.top + rect.height * 0.25 &&
        pointer.y < rect.bottom - rect.height * 0.25
      )
    })
    const folderHits = pointerWithin({ ...args, droppableContainers: folderDropZones })
    if (folderHits.length > 0) return folderHits
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => container.data.current?.type !== 'folder-dropzone'
      )
    })
  }, [])

  const renderItemWrapper = useCallback(
    (item: GridViewItem, children: React.ReactNode): React.ReactNode => {
      const folder = folders.find((entry) => entry.id === item.id)
      const file = fileItems.find((entry) => entry.id === item.id)
      const isCut = !!clipboard && clipboard.mode === 'cut' && clipboard.itemIds.has(item.id)
      const isOsDragTarget = item.isFolder && osDragTargetFolderId === item.id
      return (
        <SortableViewItem
          item={item}
          folder={folder}
          file={file}
          isDraggedAway={draggedIds.has(item.id)}
          isMultiDrag={isMultiDrag}
          isCut={isCut}
          isOsDragTarget={isOsDragTarget}
          onPointerDown={handleItemPointerDown}
          onPointerMove={handleItemPointerMove}
        >
          {children}
        </SortableViewItem>
      )
    },
    [
      folders,
      fileItems,
      draggedIds,
      isMultiDrag,
      clipboard,
      osDragTargetFolderId,
      handleItemPointerDown,
      handleItemPointerMove
    ]
  )

  if (searchQuery.trim()) {
    const handleSearchFileClick = (result: SearchResult & { kind: 'file' }): void => {
      if (isPresentationItem(result.item)) {
        openPresentationDocument(result.item)
        navigate(getPresentationWorkspacePath(result.item.id))
        setSearchQuery('')
        return
      }
      if (isPresentable(result.item.mimeType)) {
        void presentMediaItem({
          item: result.item,
          playlist: [result.item],
          start: (items, startIndex, _, options) =>
            startMediaProjection(items, startIndex, { ensureProjectionOpen }, options),
          navigate: (path) => {
            navigate(path)
            setSearchQuery('')
          }
        }).catch(() => undefined)
        return
      }
      void navigateToFolder(result.item.parentId)
      setSearchQuery('')
    }
    const handleSearchFolderClick = (result: SearchResult & { kind: 'folder' }): void => {
      void navigateToFolder(result.folder.id)
      setSearchQuery('')
    }

    return (
      <div className="h-full overflow-auto">
        {searchResults.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center p-4">
            <p className="text-sm text-default-400">{t('fileExplorer.search.noResults')}</p>
          </div>
        ) : (
          <SearchResultsList
            results={searchResults}
            selectedId={selectedSearchId}
            onSelectId={setSelectedSearchId}
            onFileClick={handleSearchFileClick}
            onFolderClick={handleSearchFolderClick}
          />
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full"
      onClick={handleContainerClick}
      onMouseDown={handleContainerMouseDown}
      onDragEnter={osDragHandlers.onDragEnter}
      onDragOver={osDragHandlers.onDragOver}
      onDragLeave={osDragHandlers.onDragLeave}
      onDrop={isCurrentFolderReadOnly ? undefined : osDragHandlers.onDrop}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={customCollisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setActiveId(null)
          setDraggedIds(new Set())
        }}
      >
        <div className="h-full" onContextMenu={handleContainerContextMenu}>
          <SortableContext
            items={allIds}
            strategy={viewMode === 'list' ? verticalListSortingStrategy : rectSortingStrategy}
          >
            {viewMode === 'list' ? (
              <ListView
                items={sortedItemsWithSelection}
                sortField={sortField}
                sortDir={sortDir}
                onSortChange={handleSortChange}
                colWidths={colWidths}
                onColWidthChange={(col, w) => setColWidths({ [col]: w })}
                onItemClick={handleViewItemClick}
                onItemDoubleClick={handleItemDoubleClick}
                onItemContextMenu={handleItemContextMenu}
                renamingItemId={renamingItemId}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={handleRenameCancel}
                renderItemWrapper={renderItemWrapper}
              />
            ) : (
              <GridView
                items={sortedItemsWithSelection}
                viewMode={viewMode}
                onItemClick={handleViewItemClick}
                onItemDoubleClick={handleItemDoubleClick}
                onItemContextMenu={handleItemContextMenu}
                onItemFavoriteToggle={toggleFavorite}
                renamingItemId={renamingItemId}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={handleRenameCancel}
                renderItemWrapper={renderItemWrapper}
              />
            )}
          </SortableContext>
        </div>
        <DragOverlay>
          {activeItem ? (
            <DragOverlayContent
              name={activeItem.name}
              count={draggedIds.size || 1}
              isFolder={activeItem.isFolder}
              mimeType={activeItem.mimeType}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {rubberBandRect && (
        <div
          className="pointer-events-none fixed z-50 rounded-sm border border-primary/60 bg-accent/20"
          style={{
            left: rubberBandRect.left,
            top: rubberBandRect.top,
            width: rubberBandRect.width,
            height: rubberBandRect.height
          }}
        />
      )}

      {isOsDragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <div className="absolute inset-2 rounded-xl border-2 border-dashed border-primary/60 bg-accent/10" />
          <div className="relative flex flex-col items-center gap-2 text-primary/80">
            <Upload size={32} />
            <span className="text-sm font-medium">
              {osDragTargetFolderId
                ? t('fileExplorer.upload.dropToFolder', 'Drop into folder')
                : t('fileExplorer.upload.dropToUpload', 'Drop to upload')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export default FileBrowser
