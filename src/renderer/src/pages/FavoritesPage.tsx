import React, { useCallback, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { StarOff } from 'lucide-react'
import {
  GridView,
  ListView,
  type GridViewItem
} from '@renderer/components/Control/FileExplorer/views'
import {
  useFileExplorerStore,
  useFileExplorerSearch,
  useFavoritesExplorerSettings
} from '@renderer/stores/file-explorer'
import { useContextMenu } from '@renderer/contexts/ContextMenuContext'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import { useItemSelection } from '@renderer/hooks/useItemSelection'
import { compareByField } from '@renderer/lib/file-explorer-sort'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import FileExplorerShell from '@renderer/components/Control/FileExplorer/FileExplorerShell'
import type { SortField } from '@renderer/stores/file-explorer'
import { buildFolderViewItem } from '@renderer/lib/file-view-item'

export default function FavoritesPage(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const foldersArray = useFileExplorerStore((state) => state._foldersArray)
  const navigateToFolder = useFileExplorerStore((state) => state.navigateToFolder)
  const toggleFavorite = useFileExplorerStore((state) => state.toggleFavorite)
  const setSearchQuery = useFileExplorerSearch((state) => state.setSearchQuery)
  const viewMode = useFavoritesExplorerSettings((state) => state.viewMode)
  const sortField = useFavoritesExplorerSettings((state) => state.sortField)
  const sortDir = useFavoritesExplorerSettings((state) => state.sortDir)
  const setSortDir = useFavoritesExplorerSettings((state) => state.setSortDir)
  const setSortFieldAndDir = useFavoritesExplorerSettings((state) => state.setSortFieldAndDir)
  const colWidths = useFavoritesExplorerSettings((state) => state.colWidths)
  const setColWidths = useFavoritesExplorerSettings((state) => state.setColWidths)
  const { showMenu } = useContextMenu()

  useEffect(() => {
    void useFileExplorerStore.getState().initialize()
  }, [])

  const sortedItems: GridViewItem[] = useMemo(() => {
    const favoritedFolders = foldersArray.filter((f) => f.isFavorited)
    const gridItems: GridViewItem[] = favoritedFolders.map((folder) => buildFolderViewItem(folder))
    if (sortDir !== 'none') {
      gridItems.sort((a, b) => compareByField(a, b, sortField, sortDir))
    } else {
      gridItems.sort((a, b) => a.name.localeCompare(b.name))
    }
    return gridItems
  }, [foldersArray, sortField, sortDir])

  const allIds = useMemo(() => sortedItems.map((i) => i.id), [sortedItems])

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

  const itemsWithSelection = useMemo(
    () => sortedItems.map((i) => ({ ...i, isSelected: selectedIds.has(i.id) })),
    [sortedItems, selectedIds]
  )

  const handleDoubleClick = useCallback(
    async (folderId: string): Promise<void> => {
      setSearchQuery('')
      await navigateToFolder(folderId)
      navigate('/files')
    },
    [navigateToFolder, navigate, setSearchQuery]
  )

  const handleContextMenu = useCallback(
    (folderId: string, event: React.MouseEvent): void => {
      const isAlreadySelected = selectedIds.has(folderId)
      if (!isAlreadySelected) {
        setSelectedIds(new Set([folderId]))
      }
      const effectiveIds =
        isAlreadySelected && selectedIds.size > 1 ? selectedIds : new Set([folderId])

      showMenu(
        [
          {
            id: 'remove-favorite',
            label: t('fileExplorer.contextMenu.removeFavorite'),
            icon: React.createElement(StarOff, { size: 14 }),
            onAction: () => {
              for (const id of effectiveIds) toggleFavorite(id)
              clearSelection()
            }
          }
        ],
        event
      )
    },
    [showMenu, t, toggleFavorite, selectedIds, setSelectedIds, clearSelection]
  )

  const handleSortChange = useCallback(
    (field: SortField): void => {
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

  const handleItemDoubleClick = useCallback(
    (id: string, e: React.MouseEvent): void => {
      e.stopPropagation()
      void handleDoubleClick(id)
    },
    [handleDoubleClick]
  )

  useKeyboardShortcuts(
    [
      { config: SHORTCUTS.EDIT.SELECT_ALL, handler: () => selectAll(), preventDefault: true },
      { config: SHORTCUTS.EDIT.ESCAPE, handler: clearSelection, preventDefault: true }
    ],
    { enabled: true, sectionKey: 'favorites' }
  )

  if (sortedItems.length === 0) {
    return (
      <FileExplorerShell itemCount={0} selectedCount={0}>
        <div className="flex h-full flex-col items-center justify-center text-center p-8">
          <h3 className="text-lg font-medium text-foreground">{t('favorites.empty.title')}</h3>
          <p className="text-sm text-default-400 mt-1">{t('favorites.empty.description')}</p>
        </div>
      </FileExplorerShell>
    )
  }

  return (
    <FileExplorerShell itemCount={sortedItems.length} selectedCount={selectedIds.size}>
      <div
        ref={containerRef}
        className="relative h-full overflow-auto"
        onClick={handleContainerClick}
        onMouseDown={handleContainerMouseDown}
      >
        {viewMode === 'list' ? (
          <ListView
            items={itemsWithSelection}
            sortField={sortField}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            colWidths={colWidths}
            onColWidthChange={(col, w) => setColWidths({ [col]: w })}
            onItemClick={handleItemClick}
            onItemDoubleClick={handleItemDoubleClick}
            onItemContextMenu={handleContextMenu}
          />
        ) : (
          <GridView
            items={itemsWithSelection}
            viewMode={viewMode}
            onItemClick={handleItemClick}
            onItemDoubleClick={handleItemDoubleClick}
            onItemContextMenu={handleContextMenu}
            onItemFavoriteToggle={toggleFavorite}
          />
        )}

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
      </div>
    </FileExplorerShell>
  )
}
