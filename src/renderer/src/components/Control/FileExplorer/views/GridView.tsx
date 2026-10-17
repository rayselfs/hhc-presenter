import React from 'react'
import { Cloud, Folder, Star } from 'lucide-react'
import type { PersonalItemStatus } from '@renderer/stores/personal-sync'
import { Skeleton } from '@heroui/react/skeleton'
import { useTranslation } from 'react-i18next'
import { getFileIcon } from './getFileIcon'
import { canHaveThumbnail } from '@renderer/hooks/useThumbnails'
import { InlineRenameInput } from '../InlineRenameInput'
import { splitFileName } from '@renderer/lib/file-naming'
import { SyncProviderIcon } from '@renderer/components/icons/SyncProviderIcon'
import type { SyncEntryStatus } from '@renderer/lib/sync-db'
import type { SyncProviderType } from '@shared/types/folder'
import type { SyncFolderHealthStatus } from '@renderer/lib/sync-folder-health'
import { FileItemStatus } from '../FileItemStatus'
import type { MediaProcessingStatus } from '@renderer/lib/media-job-view-state'

export interface GridViewItem {
  isPersonalRoot?: boolean
  personalStatus?: PersonalItemStatus
  id: string
  name: string
  isFolder: boolean
  mimeType?: string
  size?: number
  dateGroup?: string
  createdAt?: number
  thumbnailUrl?: string | null
  isSelected: boolean
  isFavorited?: boolean
  syncStatus?: SyncEntryStatus
  downloadedBytes?: number
  downloadTotalBytes?: number
  syncProviderType?: SyncProviderType
  syncFolderHealth?: SyncFolderHealthStatus
  syncFolderHealthTooltip?: string
  isUnsupportedMedia?: boolean
  processingStatus?: MediaProcessingStatus
  processingProgress?: number
}

function renderGridIcon(item: GridViewItem, iconSize: number): React.ReactNode {
  if (item.isFolder) {
    if (item.isPersonalRoot) return <Cloud size={iconSize} className="text-accent" />
    return <Folder size={iconSize} className="text-accent" fill="currentColor" />
  }

  if (item.isUnsupportedMedia) {
    return <div className="text-danger">{getFileIcon(item.mimeType, item.isFolder, iconSize)}</div>
  }

  if (item.thumbnailUrl) {
    return (
      <img
        src={item.thumbnailUrl}
        alt={item.name}
        className="object-cover rounded"
        style={{ width: iconSize, height: iconSize }}
      />
    )
  }

  if (item.thumbnailUrl === undefined && canHaveThumbnail(item.mimeType)) {
    return <Skeleton className="rounded" style={{ width: iconSize, height: iconSize }} />
  }

  return (
    <div className="text-default-500">{getFileIcon(item.mimeType, item.isFolder, iconSize)}</div>
  )
}

function renderSyncProviderIcon(providerType?: SyncProviderType): React.ReactNode {
  if (!providerType) return null
  const icon = <SyncProviderIcon providerType={providerType} className="size-5" />
  if (providerType === 'hhc-line') {
    return <span className="absolute inset-0 flex items-center justify-center">{icon}</span>
  }
  return (
    <span className="absolute inset-0 flex items-center justify-center text-white drop-shadow-sm">
      <span className="rounded-full bg-primary/90 p-1">{icon}</span>
    </span>
  )
}

export interface GridViewProps {
  items: GridViewItem[]
  viewMode: 'extra-large-icon' | 'large-icon' | 'medium-icon' | 'small-icon'
  onItemClick: (id: string, event: React.MouseEvent) => void
  onItemDoubleClick: (id: string, event: React.MouseEvent) => void
  onItemContextMenu: (id: string, event: React.MouseEvent) => void
  onItemFavoriteToggle?: (id: string) => void
  renamingItemId?: string | null
  onRenameSubmit?: (id: string, baseName: string) => boolean | void | Promise<boolean | void>
  onRenameCancel?: () => void
  renderItemWrapper?: (item: GridViewItem, children: React.ReactNode) => React.ReactNode
}

export const GridView = React.memo(function GridView({
  items,
  viewMode,
  onItemClick,
  onItemDoubleClick,
  onItemContextMenu,
  onItemFavoriteToggle,
  renamingItemId,
  onRenameSubmit,
  onRenameCancel,
  renderItemWrapper
}: GridViewProps): React.JSX.Element {
  const { t } = useTranslation()

  let gridColsClass = ''
  let iconSize = 32
  let nameClass = ''

  switch (viewMode) {
    case 'extra-large-icon':
      gridColsClass = 'grid-cols-[repeat(auto-fill,256px)]'
      iconSize = 160
      nameClass = 'line-clamp-2 text-base mt-2'
      break
    case 'large-icon':
      gridColsClass = 'grid-cols-[repeat(auto-fill,192px)]'
      iconSize = 96
      nameClass = 'line-clamp-2 text-base mt-2'
      break
    case 'medium-icon':
      gridColsClass = 'grid-cols-[repeat(auto-fill,128px)]'
      iconSize = 64
      nameClass = 'line-clamp-2 text-sm mt-2'
      break
    case 'small-icon':
      gridColsClass = 'grid-cols-[repeat(auto-fill,88px)]'
      iconSize = 40
      nameClass = 'line-clamp-2 text-xs mt-1'
      break
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-4">
        <h3 className="text-lg font-medium text-foreground">
          {t('fileExplorer.empty.title', 'No files yet')}
        </h3>
        <p className="text-sm text-default-400 mt-1">
          {t('fileExplorer.empty.description', 'Upload files to get started')}
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-y-auto h-full p-4">
      <div className={`grid gap-4 ${gridColsClass}`}>
        {items.map((item, index) => {
          const isRenaming = renamingItemId === item.id
          const splitName = splitFileName(item.name)
          const content = (
            <div
              data-file-item
              data-item-id={item.id}
              className={`group relative flex flex-col items-center justify-start rounded-lg p-2 cursor-default transition-colors hover:bg-content2/60 ${
                item.isSelected ? 'bg-surface' : ''
              }`}
              onClick={(e) => onItemClick(item.id, e)}
              onDoubleClick={(e) => onItemDoubleClick(item.id, e)}
              onContextMenu={(e) => onItemContextMenu(item.id, e)}
            >
              {item.isFolder && onItemFavoriteToggle && (
                <button
                  className={`absolute top-1 right-1 rounded p-0.5 transition-opacity ${
                    item.isFavorited
                      ? 'opacity-100 text-yellow-400'
                      : 'opacity-0 group-hover:opacity-100 text-default-400 hover:text-yellow-400'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onItemFavoriteToggle(item.id)
                  }}
                  aria-label={t(
                    item.isFavorited
                      ? 'fileExplorer.contextMenu.removeFavorite'
                      : 'fileExplorer.contextMenu.addFavorite'
                  )}
                >
                  <Star
                    size={16}
                    className={item.isFavorited ? 'fill-yellow-400 drop-shadow-sm' : ''}
                  />
                </button>
              )}
              <div className="relative flex items-center justify-center">
                {renderGridIcon(item, iconSize)}
                {item.isFolder ? renderSyncProviderIcon(item.syncProviderType) : null}
                {(item.syncFolderHealth && item.syncFolderHealth !== 'unknown') ||
                (!item.isFolder && (item.syncStatus || item.processingStatus)) ? (
                  <span className="absolute -bottom-1 -right-1 rounded-full bg-background/90 p-0.5">
                    <FileItemStatus
                      personalStatus={item.personalStatus}
                      variant="icon"
                      folderHealth={item.syncFolderHealth}
                      folderHealthTooltip={item.syncFolderHealthTooltip}
                      syncStatus={item.syncStatus}
                      downloadedBytes={item.downloadedBytes}
                      downloadTotalBytes={item.downloadTotalBytes}
                      processingStatus={item.processingStatus}
                      processingProgress={item.processingProgress}
                    />
                  </span>
                ) : null}
              </div>
              {isRenaming ? (
                <div
                  data-file-name-region
                  className="mt-2 w-full"
                  onClick={(event) => event.stopPropagation()}
                >
                  <InlineRenameInput
                    initialValue={item.isFolder ? item.name : splitName.base}
                    ariaLabel={
                      item.isFolder
                        ? t('fileExplorer.renameFolder', 'Rename folder')
                        : t('fileExplorer.renameFile', 'Rename file')
                    }
                    onSubmit={(value) => onRenameSubmit?.(item.id, value)}
                    onCancel={() => onRenameCancel?.()}
                  />
                </div>
              ) : (
                <div
                  data-file-name-region
                  className={`w-full text-center text-foreground break-words ${nameClass.replace('mt-', 'pt-')}`}
                >
                  <span title={item.name}>{item.name}</span>
                </div>
              )}
            </div>
          )

          return (
            <React.Fragment key={item.id}>
              {item.dateGroup !== undefined &&
                (index === 0 || items[index - 1].dateGroup !== item.dateGroup) && (
                  <div
                    data-date-group={item.dateGroup}
                    className="col-span-full border-t border-divider pt-3 text-sm font-semibold"
                  >
                    {item.dateGroup || t('fileExplorer.group.unknownDate')}
                  </div>
                )}
              {renderItemWrapper?.(item, content) ?? content}
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
})
