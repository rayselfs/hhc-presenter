import { toast } from '@heroui/react/toast'
import { copyBibleFolder } from '@renderer/lib/bible-folder-copy'
import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  pointerWithin,
  closestCenter,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type Modifier
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { ScrollShadow } from '@heroui/react/scroll-shadow'
import { useTranslation } from 'react-i18next'
import type { FolderRecord, AnyItemRecord, FolderDuration } from '@shared/types/folder'
import { computeExpiresAt, inferDuration } from '@shared/types/folder'
import { useConfirm } from '@renderer/contexts/ConfirmDialogContext'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import type { FolderStoreState } from '@renderer/stores/folder'
import type { ClipboardState } from '@renderer/lib/createFolderContextMenu'
import type { UseFolderContextMenu } from '@renderer/lib/createFolderContextMenu'
import type { DndItemData } from './SortableFolderItem'
import { SortableFolderItem } from './SortableFolderItem'
import { SortableItem } from './SortableItem'
import { FolderModal } from './FolderModal'

function stripItemMeta<T extends { id: string; sortIndex: number; createdAt: number }>(
  item: T
): Omit<T, 'id' | 'sortIndex' | 'createdAt'> {
  const { id: _id, sortIndex: _si, createdAt: _ca, ...rest } = item
  return rest
}

const snapCenterToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (activatorEvent && draggingNodeRect) {
    return {
      ...transform,
      x:
        transform.x +
        (activatorEvent as PointerEvent).clientX -
        draggingNodeRect.left -
        draggingNodeRect.width / 2,
      y:
        transform.y +
        (activatorEvent as PointerEvent).clientY -
        draggingNodeRect.top -
        draggingNodeRect.height / 2
    }
  }
  return transform
}

function getNextUntitledName(baseName: string, existingNames: string[]): string {
  if (!existingNames.includes(baseName)) return baseName
  let n = 2
  while (existingNames.includes(`${baseName} ${n}`)) n++
  return `${baseName} ${n}`
}

export interface FolderBrowserProps {
  store: {
    getState: () => FolderStoreState;
    (): FolderStoreState
    <T>(selector: (s: FolderStoreState) => T): T
  }
  folders: FolderRecord[]
  items: AnyItemRecord[]
  contextMenu: UseFolderContextMenu
  renderFolderContent: (
    folder: FolderRecord,
    isSelected: boolean,
    isDragging: boolean,
    folderDropTargetId: string | null,
    handlers: FolderBrowserHandlers
  ) => React.ReactNode
  renderItemContent: (
    item: AnyItemRecord,
    isSelected: boolean,
    isDragging: boolean,
    handlers: FolderBrowserHandlers
  ) => React.ReactNode
  renderDragOverlay?: (item: FolderRecord | AnyItemRecord, draggedCount: number) => React.ReactNode
  getItemReference?: (item: AnyItemRecord) => string
  isModalOpen?: boolean
  onModalOpenChange?: (open: boolean) => void
  i18nPrefix?: string
  untitledFolderKey?: string
  emptyMessage?: string
}

export interface FolderBrowserHandlers {
  handleItemClick: (itemId: string, event: React.MouseEvent) => void
  handleDeleteFolder: (folderId: string, folderName: string) => Promise<void>
  handleDeleteItem: (item: AnyItemRecord) => Promise<void>
  handleContextMenuForItem: (item: AnyItemRecord, e: React.MouseEvent) => void
  handleContextMenuForFolder: (folder: FolderRecord, e: React.MouseEvent) => void
  navigateToFolder: (folderId: string) => Promise<void>
  openEditFolder: (folder: FolderRecord) => void
  selectedItemIds: Set<string>
}

export function FolderBrowser({
  store,
  folders,
  items,
  contextMenu,
  renderFolderContent,
  renderItemContent,
  renderDragOverlay,
  getItemReference,
  isModalOpen = false,
  onModalOpenChange = () => {},
  i18nPrefix = 'folder',
  untitledFolderKey = 'folder.untitledFolder',
  emptyMessage
}: FolderBrowserProps): React.JSX.Element {
  const currentFolderId = store((s) => s.currentFolderId)
  const {
    addFolder,
    deleteFolder,
    removeItem,
    navigateToFolder,
    moveItem,
    moveFolder,
    reorderItems,
    reorderFolders,
    addItem,
    updateFolder
  } = store.getState()
  const confirm = useConfirm()
  const { t } = useTranslation()
  const { showItemMenu, showFolderMenu, showMultiSelectMenu, showEmptyAreaMenu } = contextMenu

  const [newFolderName, setNewFolderName] = useState('')
  const [folderDuration, setFolderDuration] = useState<FolderDuration>('1day')
  const [editingFolder, setEditingFolder] = useState<FolderRecord | null>(null)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [draggedIds, setDraggedIds] = useState<Set<string>>(new Set())
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null)
  const pastePendingRef = useRef(false)
  const lastClickedIdRef = useRef<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 }
    })
  )

  const allItems = useMemo(() => [...folders, ...items], [folders, items])

  const activeDragItem = useMemo(
    () => (activeDragId ? allItems.find((i) => i.id === activeDragId) : null),
    [activeDragId, allItems]
  )
  const isMultiDrag = draggedIds.size > 1

  const tKey = useCallback(
    (key: string, fallback?: string): string =>
      (t as (k: string, opts?: string) => string)(key, fallback),
    [t]
  )

  const tp = useCallback(
    (key: string, options?: Record<string, unknown>): string =>
      (t as (k: string, opts?: Record<string, unknown>) => string)(`${i18nPrefix}.${key}`, options),
    [t, i18nPrefix]
  )

  const generateUntitledName = useCallback((): string => {
    const baseName = tKey(untitledFolderKey)
    const existingNames = folders.map((f) => f.name)
    return getNextUntitledName(baseName, existingNames)
  }, [folders, tKey, untitledFolderKey])

  const openNewFolderModal = useCallback((): void => {
    setEditingFolder(null)
    setNewFolderName(generateUntitledName())
    setFolderDuration('1day')
    onModalOpenChange(true)
  }, [generateUntitledName, onModalOpenChange])

  useEffect(() => {
    if (isModalOpen && !editingFolder) {
      // Pre-fill folder name when modal opens for "new folder" — intentional setState in effect
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNewFolderName(generateUntitledName())
    }
  }, [isModalOpen, editingFolder, generateUntitledName])

  const handleItemClick = useCallback(
    (itemId: string, event: React.MouseEvent) => {
      event.stopPropagation()

      if (event.shiftKey && lastClickedIdRef.current) {
        const allIds = allItems.map((i) => i.id)
        const lastIndex = allIds.indexOf(lastClickedIdRef.current)
        const currentIndex = allIds.indexOf(itemId)
        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex)
          const end = Math.max(lastIndex, currentIndex)
          const rangeIds = allIds.slice(start, end + 1)
          setSelectedItemIds(new Set(rangeIds))
          return
        }
      }

      if (event.ctrlKey || event.metaKey) {
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          if (next.has(itemId)) {
            next.delete(itemId)
          } else {
            next.add(itemId)
          }
          return next
        })
      } else {
        setSelectedItemIds(new Set([itemId]))
      }

      lastClickedIdRef.current = itemId
    },
    [allItems]
  )

  const handleContainerClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) {
      setSelectedItemIds(new Set())
      lastClickedIdRef.current = null
    }
  }, [])

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent): void => {
      const container = containerRef.current
      if (!container) return
      if (container.contains(event.target as Node)) return
      setSelectedItemIds(new Set())
      lastClickedIdRef.current = null
    }

    document.addEventListener('mousedown', handleDocumentClick)
    return () => document.removeEventListener('mousedown', handleDocumentClick)
  }, [])

  const handleSelectAll = useCallback(() => {
    setSelectedItemIds(new Set(allItems.map((i) => i.id)))
  }, [allItems])

  const handleCopy = useCallback(
    (targetIds?: Set<string>) => {
      const ids = targetIds ?? selectedItemIds
      if (ids.size === 0) return
      setClipboard({ itemIds: ids, mode: 'copy' })
    },
    [selectedItemIds]
  )

  const handleCut = useCallback(
    (targetIds?: Set<string>) => {
      const ids = targetIds ?? selectedItemIds
      if (ids.size === 0) return
      setClipboard({ itemIds: ids, mode: 'cut' })
    },
    [selectedItemIds]
  )

  const handleCopyKeyboard = useCallback(() => handleCopy(), [handleCopy])
  const handleCutKeyboard = useCallback(() => handleCut(), [handleCut])

  const handleEscape = useCallback(() => {
    if (clipboard?.mode === 'cut') {
      setClipboard(null)
      return
    }
    if (selectedItemIds.size > 0) {
      setSelectedItemIds(new Set())
      lastClickedIdRef.current = null
    }
  }, [clipboard, selectedItemIds])

  const handlePaste = useCallback(async () => {
    if (!clipboard || pastePendingRef.current) return
    pastePendingRef.current = true
    try {
      const state = store.getState()

      if (clipboard.mode === 'cut') {
        for (const id of clipboard.itemIds) {
          if (state.folders[id]) {
            moveFolder(id, currentFolderId)
          } else {
            moveItem(id, currentFolderId)
          }
        }
      } else {
        for (const id of clipboard.itemIds) {
          if (state.folders[id]) {
            await copyBibleFolder(store.getState, id, currentFolderId)
          } else {
            const item = state.items[id]
            if (item) {
              const rest = stripItemMeta(item)
              addItem({ ...rest, parentId: currentFolderId, expiresAt: null })
            }
          }
        }
      }

      await store.getState().flushPersistence()
      if (clipboard.mode === 'cut')
        setClipboard((current) => (current === clipboard ? null : current))
      setSelectedItemIds(new Set())
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : String(error))
    } finally {
      pastePendingRef.current = false
    }
  }, [clipboard, currentFolderId, addItem, moveItem, moveFolder, store])

  const handleDeleteSelected = useCallback(
    async (targetIds?: Set<string>) => {
      const ids = targetIds ?? selectedItemIds
      if (ids.size === 0) return

      let title: string
      if (ids.size === 1) {
        const [id] = ids
        const storeState = store.getState()
        const folder = storeState.folders[id]
        const name = folder
          ? folder.name
          : getItemReference && storeState.items[id]
            ? getItemReference(storeState.items[id])
            : id
        title = tp('deleteTitle', { name, defaultValue: `Delete '${name}'?` })
      } else {
        title = tp('deleteSelectedTitle', {
          count: ids.size,
          defaultValue: `Delete ${ids.size} item(s)?`
        })
      }

      const confirmed = await confirm({
        title,
        description: tp('deleteItemDescription', {
          defaultValue: 'This action cannot be undone.'
        }),
        status: 'danger'
      })

      if (!confirmed) return

      for (const id of ids) {
        const folder = store.getState().folders[id]
        if (folder) {
          deleteFolder(id)
        } else {
          removeItem(id)
        }
      }
      setSelectedItemIds(new Set())
      lastClickedIdRef.current = null
    },
    [selectedItemIds, confirm, tp, removeItem, deleteFolder, store, getItemReference]
  )

  const handleDeleteSelectedKeyboard = useCallback(
    () => handleDeleteSelected(),
    [handleDeleteSelected]
  )

  useKeyboardShortcuts(
    [
      { config: SHORTCUTS.EDIT.SELECT_ALL, handler: handleSelectAll, preventDefault: true },
      { config: SHORTCUTS.EDIT.COPY, handler: handleCopyKeyboard, preventDefault: true },
      { config: SHORTCUTS.EDIT.CUT, handler: handleCutKeyboard, preventDefault: true },
      { config: SHORTCUTS.EDIT.PASTE, handler: handlePaste, preventDefault: true },
      {
        config: SHORTCUTS.EDIT.DELETE,
        handler: handleDeleteSelectedKeyboard,
        preventDefault: true
      },
      {
        config: SHORTCUTS.EDIT.DELETE_ALT,
        handler: handleDeleteSelectedKeyboard,
        preventDefault: true
      },
      { config: SHORTCUTS.EDIT.ESCAPE, handler: handleEscape, preventDefault: true }
    ],
    { enabled: true, sectionKey: 'edit' }
  )

  const handleContextMenuForItem = useCallback(
    (item: AnyItemRecord, e: React.MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const isAlreadySelected = selectedItemIds.has(item.id)
      if (selectedItemIds.size > 1 && isAlreadySelected) {
        showMultiSelectMenu({
          selectedIds: selectedItemIds,
          event: e,
          onCopy: handleCopy,
          onCut: handleCut,
          onDelete: handleDeleteSelected
        })
      } else {
        if (!isAlreadySelected) {
          setSelectedItemIds(new Set([item.id]))
        }
        showItemMenu({
          item,
          isAlreadySelected,
          event: e,
          setSelected: setSelectedItemIds,
          onCopy: handleCopy,
          onCut: handleCut,
          onDelete: handleDeleteSelected
        })
      }
    },
    [
      selectedItemIds,
      showMultiSelectMenu,
      showItemMenu,
      handleCopy,
      handleCut,
      handleDeleteSelected
    ]
  )

  const openEditFolder = useCallback(
    (folder: FolderRecord) => {
      setEditingFolder(folder)
      setNewFolderName(folder.name)
      setFolderDuration(inferDuration(folder.expiresAt, folder.createdAt))
      onModalOpenChange(true)
    },
    [onModalOpenChange]
  )

  const handleContextMenuForFolder = useCallback(
    (folder: FolderRecord, e: React.MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const isAlreadySelected = selectedItemIds.has(folder.id)
      if (selectedItemIds.size > 1 && isAlreadySelected) {
        showMultiSelectMenu({
          selectedIds: selectedItemIds,
          event: e,
          onCopy: handleCopy,
          onCut: handleCut,
          onDelete: handleDeleteSelected
        })
      } else {
        if (!isAlreadySelected) {
          setSelectedItemIds(new Set([folder.id]))
        }
        showFolderMenu({
          folder,
          isAlreadySelected,
          event: e,
          setSelected: setSelectedItemIds,
          clipboard,
          onCopy: handleCopy,
          onCut: handleCut,
          onPaste: handlePaste,
          onDelete: handleDeleteSelected,
          onEdit: openEditFolder
        })
      }
    },
    [
      selectedItemIds,
      clipboard,
      showMultiSelectMenu,
      showFolderMenu,
      handleCopy,
      handleCut,
      handlePaste,
      handleDeleteSelected,
      openEditFolder
    ]
  )

  const handleContextMenuForContainer = useCallback(
    (e: React.MouseEvent): void => {
      if (allItems.length > 0 && e.target !== e.currentTarget) return
      e.preventDefault()
      showEmptyAreaMenu({
        event: e,
        clipboard,
        onPaste: handlePaste,
        onNewFolder: openNewFolderModal
      })
    },
    [allItems.length, clipboard, showEmptyAreaMenu, handlePaste, openNewFolderModal]
  )

  const handleDeleteFolder = useCallback(
    async (folderId: string, folderName: string): Promise<void> => {
      const confirmed = await confirm({
        title: tp('deleteTitle', {
          name: folderName,
          defaultValue: `Delete '${folderName}'?`
        }),
        description: tp('deleteFolderDescription', {
          defaultValue: 'This action cannot be undone. All items inside will be lost.'
        }),
        status: 'danger'
      })
      if (confirmed) {
        deleteFolder(folderId)
      }
    },
    [confirm, tp, deleteFolder]
  )

  const handleDeleteItem = useCallback(
    async (item: AnyItemRecord): Promise<void> => {
      const reference = getItemReference ? getItemReference(item) : item.id
      const confirmed = await confirm({
        title: tp('deleteTitle', {
          name: reference,
          defaultValue: `Delete '${reference}'?`
        }),
        description: tp('deleteItemDescription', {
          defaultValue: 'This action cannot be undone.'
        }),
        status: 'danger'
      })
      if (confirmed) {
        removeItem(item.id)
      }
    },
    [confirm, tp, removeItem, getItemReference]
  )

  const handlers: FolderBrowserHandlers = useMemo(
    () => ({
      handleItemClick,
      handleDeleteFolder,
      handleDeleteItem,
      handleContextMenuForItem,
      handleContextMenuForFolder,
      navigateToFolder,
      openEditFolder,
      selectedItemIds
    }),
    [
      handleItemClick,
      handleDeleteFolder,
      handleDeleteItem,
      handleContextMenuForItem,
      handleContextMenuForFolder,
      navigateToFolder,
      openEditFolder,
      selectedItemIds
    ]
  )

  const handleAddFolder = (): void => {
    if (newFolderName.trim()) {
      addFolder(newFolderName.trim(), currentFolderId, computeExpiresAt(folderDuration))
      setNewFolderName('')
      setFolderDuration('1day')
      onModalOpenChange(false)
    }
  }

  const handleEditFolderSubmit = (): void => {
    if (!editingFolder || !newFolderName.trim()) return
    updateFolder(editingFolder.id, {
      name: newFolderName.trim(),
      expiresAt: computeExpiresAt(folderDuration)
    })
    setEditingFolder(null)
    setNewFolderName('')
    setFolderDuration('1day')
    onModalOpenChange(false)
  }

  const handleModalClose = (): void => {
    setEditingFolder(null)
    setNewFolderName('')
    setFolderDuration('1day')
    onModalOpenChange(false)
  }

  const handleModalSubmit = editingFolder ? handleEditFolderSubmit : handleAddFolder

  const handleDragStart = useCallback(
    (event: DragStartEvent): void => {
      const activeId = String(event.active.id)
      setActiveDragId(activeId)
      setFolderDropTargetId(null)

      if (selectedItemIds.has(activeId)) {
        setDraggedIds(new Set(selectedItemIds))
      } else {
        setSelectedItemIds(new Set([activeId]))
        setDraggedIds(new Set([activeId]))
        lastClickedIdRef.current = activeId
      }
    },
    [selectedItemIds]
  )

  const handleDragOver = useCallback(
    (event: DragOverEvent): void => {
      const { over } = event
      if (!over) {
        setFolderDropTargetId(null)
        return
      }
      const overData = over.data.current as DndItemData | undefined
      if (overData?.type === 'folder-dropzone' && !draggedIds.has(overData.folderId)) {
        setFolderDropTargetId(overData.folderId)
      } else {
        setFolderDropTargetId(null)
      }
    },
    [draggedIds]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const currentDraggedIds = draggedIds
      setActiveDragId(null)
      setDraggedIds(new Set())
      setFolderDropTargetId(null)

      const { active, over } = event
      if (!over || active.id === over.id) return

      const activeData = active.data.current as DndItemData | undefined
      const overData = over.data.current as DndItemData | undefined

      if (!activeData) return

      const isDragMulti = currentDraggedIds.size > 1

      if (overData?.type === 'folder-dropzone') {
        const targetFolderId = overData.folderId
        if (isDragMulti) {
          for (const id of currentDraggedIds) {
            if (id === targetFolderId) continue
            const isAFolder = !!store.getState().folders[id]
            if (isAFolder) {
              moveFolder(id, targetFolderId)
            } else {
              moveItem(id, targetFolderId)
            }
          }
        } else {
          const activeId = String(active.id)
          if (activeId === targetFolderId) return
          if (activeData.type === 'folder') {
            moveFolder(activeId, targetFolderId)
          } else {
            moveItem(activeId, targetFolderId)
          }
        }
        return
      }

      if (isDragMulti) return

      if (activeData.type === 'folder' && overData?.type === 'folder') {
        const folderIds = folders.map((f) => f.id)
        const oldIndex = folderIds.indexOf(String(active.id))
        const newIndex = folderIds.indexOf(String(over.id))
        if (oldIndex !== -1 && newIndex !== -1) {
          reorderFolders(currentFolderId, arrayMove(folderIds, oldIndex, newIndex))
        }
        return
      }

      if (activeData.type === 'item' && overData?.type === 'item') {
        const itemIds = items.map((i) => i.id)
        const oldIndex = itemIds.indexOf(String(active.id))
        const newIndex = itemIds.indexOf(String(over.id))
        if (oldIndex !== -1 && newIndex !== -1) {
          reorderItems(currentFolderId, arrayMove(itemIds, oldIndex, newIndex))
        }
        return
      }
    },
    [
      currentFolderId,
      folders,
      items,
      draggedIds,
      moveItem,
      moveFolder,
      reorderItems,
      reorderFolders,
      store
    ]
  )

  const customCollisionDetection: CollisionDetection = useCallback((args) => {
    const folderDropZones = args.droppableContainers.filter(
      (c) => (c.data.current as DndItemData | undefined)?.type === 'folder-dropzone'
    )
    const folderHits = pointerWithin({ ...args, droppableContainers: folderDropZones })
    if (folderHits.length > 0) return folderHits
    return closestCenter(args)
  }, [])

  const folderIdList = folders.map((f) => f.id)
  const itemIdList = items.map((v) => v.id)

  const resolvedEmptyMessage =
    emptyMessage ?? tp('emptyFolder', { defaultValue: 'Folder is empty' })

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      <DndContext
        sensors={sensors}
        collisionDetection={customCollisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <ScrollShadow
          className="flex-1 min-h-0 p-2 pt-0"
          onClick={handleContainerClick}
          onContextMenu={handleContextMenuForContainer}
        >
          {allItems.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted">
              {resolvedEmptyMessage}
            </div>
          ) : (
            <ul className="list-none p-0 m-0 flex flex-col gap-2">
              <SortableContext
                items={folderIdList}
                strategy={isMultiDrag ? undefined : verticalListSortingStrategy}
              >
                {folders.map((folder) => {
                  const isItemSelected = selectedItemIds.has(folder.id)
                  const isItemCut = clipboard?.mode === 'cut' && clipboard.itemIds.has(folder.id)
                  return (
                    <SortableFolderItem
                      key={folder.id}
                      id={folder.id}
                      folder={folder}
                      isSelected={isItemSelected}
                      isFolderDropTarget={folderDropTargetId === folder.id}
                      isCut={isItemCut}
                      isDraggedAway={draggedIds.has(folder.id)}
                      isMultiDrag={isMultiDrag}
                    >
                      {(isDragging) =>
                        renderFolderContent(
                          folder,
                          isItemSelected,
                          isDragging,
                          folderDropTargetId,
                          handlers
                        )
                      }
                    </SortableFolderItem>
                  )
                })}
              </SortableContext>

              <SortableContext
                items={itemIdList}
                strategy={isMultiDrag ? undefined : verticalListSortingStrategy}
              >
                {items.map((item) => {
                  const isItemSelected = selectedItemIds.has(item.id)
                  const isItemCut = clipboard?.mode === 'cut' && clipboard.itemIds.has(item.id)
                  return (
                    <SortableItem
                      key={item.id}
                      id={item.id}
                      item={item}
                      isSelected={isItemSelected}
                      isCut={isItemCut}
                      isDraggedAway={draggedIds.has(item.id)}
                      isMultiDrag={isMultiDrag}
                    >
                      {(isDragging) =>
                        renderItemContent(item, isItemSelected, isDragging, handlers)
                      }
                    </SortableItem>
                  )
                })}
              </SortableContext>
            </ul>
          )}
        </ScrollShadow>

        <DragOverlay modifiers={[snapCenterToCursor]}>
          {activeDragItem && renderDragOverlay
            ? renderDragOverlay(activeDragItem, draggedIds.size)
            : null}
        </DragOverlay>
      </DndContext>

      <FolderModal
        isOpen={isModalOpen}
        onClose={handleModalClose}
        onSubmit={handleModalSubmit}
        editingFolder={editingFolder}
        folderName={newFolderName}
        onFolderNameChange={setNewFolderName}
        folderDuration={folderDuration}
        onFolderDurationChange={setFolderDuration}
        i18nPrefix={i18nPrefix}
        isRetentionLocked={editingFolder?.isFavorited ?? false}
      />
    </div>
  )
}
