import React, { useCallback, useMemo, useRef } from 'react'
import { Cloud, Folder, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { formatFileKind } from '@renderer/lib/format-file-kind'
import type { SortField, SortDir } from '@renderer/stores/file-explorer'
import { getFileIcon } from './getFileIcon'
import type { GridViewItem } from './GridView'
import { InlineRenameInput } from '../InlineRenameInput'
import { splitFileName } from '@renderer/lib/file-naming'
import { FileItemStatus } from '../FileItemStatus'
import { formatLocalDateTime } from '@renderer/lib/format-local-date-time'

export interface ListViewProps {
  items: GridViewItem[]
  sortField: SortField
  sortDir: SortDir
  onSortChange: (field: SortField) => void
  colWidths: { created: number; size: number; kind: number }
  onColWidthChange: (col: 'created' | 'size' | 'kind', width: number) => void
  onItemClick: (id: string, event: React.MouseEvent) => void
  onItemDoubleClick: (id: string, event: React.MouseEvent) => void
  onItemContextMenu: (id: string, event: React.MouseEvent) => void
  renamingItemId?: string | null
  onRenameSubmit?: (id: string, baseName: string) => boolean | void | Promise<boolean | void>
  onRenameCancel?: () => void
  renderItemWrapper?: (item: GridViewItem, children: React.ReactNode) => React.ReactNode
}

function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export const ListView = React.memo(function ListView({
  items,
  sortField,
  sortDir,
  onSortChange,
  colWidths,
  onColWidthChange,
  onItemClick,
  onItemDoubleClick,
  onItemContextMenu,
  renamingItemId,
  onRenameSubmit,
  onRenameCancel,
  renderItemWrapper
}: ListViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, col: 'created' | 'size' | 'kind') => {
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const startWidth = colWidths[col]

      const onPointerMove = (moveEvent: PointerEvent): void => {
        const delta = moveEvent.clientX - startX
        onColWidthChange(col, Math.max(60, startWidth - delta))
      }

      const onPointerUp = (upEvent: PointerEvent): void => {
        target.releasePointerCapture(upEvent.pointerId)
        target.removeEventListener('pointermove', onPointerMove)
        target.removeEventListener('pointerup', onPointerUp)
      }

      target.addEventListener('pointermove', onPointerMove)
      target.addEventListener('pointerup', onPointerUp)
    },
    [colWidths, onColWidthChange]
  )

  const renderSortIcon = (field: SortField): React.ReactNode => {
    if (sortDir === 'none' || sortField !== field) {
      return <ArrowUpDown size={12} className="opacity-30" />
    }
    return sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
  }

  const rows = useMemo(
    () =>
      items.flatMap(
        (item, index): Array<GridViewItem | string> =>
          item.dateGroup !== undefined &&
          (index === 0 || items[index - 1].dateGroup !== item.dateGroup)
            ? [item.dateGroup, item]
            : [item]
      ),
    [items]
  )

  // TanStack Virtual returns helper functions React Compiler cannot memoize safely.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 40,
    overscan: 3
  })

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
    <div className="flex flex-col h-full">
      <div className="sticky top-0 bg-background z-10 border-b border-default-200">
        <div className="flex items-center px-3 py-1.5">
          <div className="w-6 flex-shrink-0 mr-3" />
          <div
            className="flex-1 flex items-center gap-1 text-sm font-medium text-default-400 uppercase tracking-wide cursor-pointer hover:text-foreground"
            onClick={() => onSortChange('name')}
          >
            {t('fileExplorer.list.name', 'Name')}
            {renderSortIcon('name')}
          </div>

          <div
            className="w-1 cursor-col-resize flex-shrink-0 hover:bg-primary/40 h-6"
            onPointerDown={(e) => handlePointerDown(e, 'created')}
          />
          <div
            className="flex-shrink-0 flex items-center gap-1 text-sm font-medium text-default-400 uppercase tracking-wide cursor-pointer hover:text-foreground pl-2"
            style={{ width: colWidths.created }}
            onClick={() => onSortChange('createdAt')}
          >
            {t('fileExplorer.list.createdAt', 'Created')}
            {renderSortIcon('createdAt')}
          </div>

          <div
            className="w-1 cursor-col-resize flex-shrink-0 hover:bg-primary/40 h-6"
            onPointerDown={(e) => handlePointerDown(e, 'size')}
          />
          <div
            className="flex-shrink-0 flex items-center gap-1 text-sm font-medium text-default-400 uppercase tracking-wide cursor-pointer hover:text-foreground pl-2"
            style={{ width: colWidths.size }}
            onClick={() => onSortChange('size')}
          >
            {t('fileExplorer.list.size', 'Size')}
            {renderSortIcon('size')}
          </div>

          <div
            className="w-1 cursor-col-resize flex-shrink-0 hover:bg-primary/40 h-6"
            onPointerDown={(e) => handlePointerDown(e, 'kind')}
          />
          <div
            className="flex-shrink-0 flex items-center gap-1 text-sm font-medium text-default-400 uppercase tracking-wide cursor-pointer hover:text-foreground pl-2"
            style={{ width: colWidths.kind }}
            onClick={() => onSortChange('kind')}
          >
            {t('fileExplorer.list.kind', 'Kind')}
            {renderSortIcon('kind')}
          </div>
        </div>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto p-2">
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative'
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = rows[virtualRow.index]
            if (typeof item === 'string')
              return (
                <div
                  key={`date-${item}`}
                  data-date-group={item}
                  className="absolute left-0 top-0 w-full border-t border-divider px-3 py-2 text-sm font-semibold"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {item || t('fileExplorer.group.unknownDate')}
                </div>
              )
            const isRenaming = renamingItemId === item.id
            const splitName = splitFileName(item.name)
            const content = (
              <div
                data-file-item
                data-item-id={item.id}
                className={`flex items-center rounded-md px-3 py-2 cursor-default transition-colors hover:bg-content2/60 ${
                  item.isSelected ? 'bg-surface' : ''
                }`}
                onClick={(e) => onItemClick(item.id, e)}
                onDoubleClick={(e) => onItemDoubleClick(item.id, e)}
                onContextMenu={(e) => onItemContextMenu(item.id, e)}
              >
                <div className="flex-shrink-0 w-6 flex items-center justify-center mr-3">
                  {item.isFolder ? (
                    <span
                      className="relative flex items-center justify-center"
                      aria-label={
                        item.syncProviderType
                          ? t(`fileExplorer.provider.${item.syncProviderType}`)
                          : undefined
                      }
                    >
                      {item.isPersonalRoot ? (
                        <Cloud size={20} className="text-accent" />
                      ) : (
                        <Folder size={20} className="text-accent" fill="currentColor" />
                      )}
                    </span>
                  ) : (
                    <div className="text-danger">
                      {getFileIcon(item.mimeType, item.isFolder, 20)}
                    </div>
                  )}
                </div>
                {isRenaming ? (
                  <div className="flex-1" onClick={(event) => event.stopPropagation()}>
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
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div
                      data-file-name-region
                      className="truncate text-base text-foreground"
                      title={item.name}
                    >
                      {item.name}
                    </div>
                    <FileItemStatus
                      personalStatus={item.personalStatus}
                      variant="badge"
                      folderHealth={item.syncFolderHealth}
                      folderHealthTooltip={item.syncFolderHealthTooltip}
                      syncStatus={item.syncStatus}
                      downloadedBytes={item.downloadedBytes}
                      downloadTotalBytes={item.downloadTotalBytes}
                      processingStatus={item.processingStatus}
                      processingProgress={item.processingProgress}
                    />
                  </div>
                )}
                <div className="w-1 flex-shrink-0" />
                <div
                  className="flex-shrink-0 text-sm text-default-400 pl-2"
                  style={{ width: colWidths.created }}
                >
                  {formatLocalDateTime(item.createdAt)}
                </div>
                <div className="w-1 flex-shrink-0" />
                <div
                  className="flex-shrink-0 text-sm text-default-400 pl-2"
                  style={{ width: colWidths.size }}
                >
                  {item.isFolder ? '—' : formatFileSize(item.size)}
                </div>
                <div className="w-1 flex-shrink-0" />
                <div
                  className="flex-shrink-0 text-sm text-default-400 truncate pl-2"
                  style={{ width: colWidths.kind }}
                >
                  {formatFileKind(item.mimeType, item.isFolder, t)}
                </div>
              </div>
            )

            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                {renderItemWrapper?.(item, content) ?? content}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})
