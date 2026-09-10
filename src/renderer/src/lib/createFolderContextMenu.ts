import { useContextMenu } from '@renderer/contexts/ContextMenuContext'
import type { ContextMenuEntry } from '@renderer/contexts/ContextMenuContext'
import { SyncProviderIcon } from '@renderer/components/icons/SyncProviderIcon'
import type { FolderRecord, FolderItem } from '@shared/types/folder'
import {
  Copy,
  Scissors,
  Clipboard,
  Trash2,
  FolderPlus,
  Pencil,
  Upload,
  Folder,
  FolderSync,
  Cloud,
  Presentation
} from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

type ClipboardMode = 'copy' | 'cut'

export interface ClipboardState {
  itemIds: Set<string>
  mode: ClipboardMode
}

export interface FolderContextMenuConfig {
  i18nPrefix?: string
  extraItemActions?: (itemId: string, t: (key: string) => string) => ContextMenuEntry[]
  extraFolderActions?: (folder: FolderRecord, t: (key: string) => string) => ContextMenuEntry[]
  extraEmptyAreaActions?: () => ContextMenuEntry[]
}

export interface ShowItemMenuOptions {
  item: FolderItem
  isAlreadySelected: boolean
  event: React.MouseEvent
  setSelected: (ids: Set<string>) => void
  onCopy: (targetIds: Set<string>) => void
  onCut: (targetIds: Set<string>) => void
  onDelete: (targetIds: Set<string>) => void
  onEdit?: (item: FolderItem) => void
  isReadOnly?: boolean
  canCopy?: boolean
  extraActions?: ContextMenuEntry[]
}

export interface ShowFolderMenuOptions {
  folder: FolderRecord
  isAlreadySelected: boolean
  event: React.MouseEvent
  setSelected: (ids: Set<string>) => void
  clipboard: ClipboardState | null
  onCopy: (targetIds: Set<string>) => void
  onCut: (targetIds: Set<string>) => void
  onPaste: () => void
  onDelete: (targetIds: Set<string>) => void
  onEdit?: (folder: FolderRecord) => void
  isReadOnly?: boolean
  canCopy?: boolean
  extraActions?: ContextMenuEntry[]
}

export interface ShowMultiSelectMenuOptions {
  selectedIds: Set<string>
  event: React.MouseEvent
  onCopy: (targetIds: Set<string>) => void
  onCut: (targetIds: Set<string>) => void
  onDelete: (targetIds: Set<string>) => void
  isReadOnly?: boolean
  canCopy?: boolean
}

export interface ShowEmptyAreaMenuOptions {
  event: React.MouseEvent
  clipboard: ClipboardState | null
  onPaste: () => void
  onNewFolder: () => void
  onUploadFiles?: () => void
  onUploadFolder?: () => void
  onCreatePresentation?: () => void
  onAddLocalSyncFolder?: () => void
  onAddOneDrive?: () => void
  onAddHhcLine?: () => void
  isAddOneDriveDisabled?: boolean
  isAddHhcLineDisabled?: boolean
  isReadOnly?: boolean
}

export interface UseFolderContextMenu {
  showItemMenu: (options: ShowItemMenuOptions) => void
  showFolderMenu: (options: ShowFolderMenuOptions) => void
  showMultiSelectMenu: (options: ShowMultiSelectMenuOptions) => void
  showEmptyAreaMenu: (options: ShowEmptyAreaMenuOptions) => void
}

const DEFAULT_I18N_PREFIX = 'folder.contextMenu'

export function createFolderContextMenu(
  config?: FolderContextMenuConfig
): () => UseFolderContextMenu {
  return function useFolderContextMenu(): UseFolderContextMenu {
    const { t } = useTranslation()
    const { showMenu } = useContextMenu()
    const p = config?.i18nPrefix ?? DEFAULT_I18N_PREFIX

    const tKey = (key: string): string => (t as (k: string) => string)(`${p}.${key}`)

    const showItemMenu = ({
      item,
      isAlreadySelected,
      event,
      setSelected,
      onCopy,
      onCut,
      onDelete,
      onEdit,
      isReadOnly = false,
      canCopy = true,
      extraActions = []
    }: ShowItemMenuOptions): void => {
      if (!isAlreadySelected) {
        setSelected(new Set([item.id]))
      }

      const targetIds = new Set([item.id])
      const editItems: ContextMenuEntry[] = []
      if (onEdit && !isReadOnly) {
        editItems.push({
          id: 'rename',
          label: tKey('rename'),
          icon: React.createElement(Pencil, { size: 14 }),
          onAction: () => onEdit(item)
        })
      }
      if (editItems.length > 0) {
        editItems.push('separator')
      }
      const baseItems: ContextMenuEntry[] = [
        ...editItems,
        ...(canCopy
          ? [
              {
                id: 'copy',
                label: tKey('copy'),
                icon: React.createElement(Copy, { size: 14 }),
                onAction: () => onCopy(targetIds)
              }
            ]
          : []),
        ...(isReadOnly
          ? []
          : [
              {
                id: 'cut',
                label: tKey('cut'),
                icon: React.createElement(Scissors, { size: 14 }),
                onAction: () => onCut(targetIds)
              },
              'separator' as const,
              {
                id: 'delete',
                label: tKey('delete'),
                icon: React.createElement(Trash2, { size: 14 }),
                variant: 'danger' as const,
                onAction: () => onDelete(targetIds)
              }
            ])
      ]

      const extra = config?.extraItemActions?.(item.id, t as (key: string) => string) ?? []
      showMenu([...baseItems, ...extra, ...extraActions], event)
    }

    const showFolderMenu = ({
      folder,
      isAlreadySelected,
      event,
      setSelected,
      clipboard,
      onCopy,
      onCut,
      onPaste,
      onDelete,
      onEdit,
      isReadOnly = false,
      canCopy = true,
      extraActions = []
    }: ShowFolderMenuOptions): void => {
      if (!isAlreadySelected) {
        setSelected(new Set([folder.id]))
      }

      const targetIds = new Set([folder.id])
      const pasteItems: ContextMenuEntry[] =
        clipboard && !isReadOnly
          ? [
              {
                id: 'paste',
                label: tKey('paste'),
                icon: React.createElement(Clipboard, { size: 14 }),
                onAction: onPaste
              }
            ]
          : []

      const editItems: ContextMenuEntry[] =
        onEdit && !isReadOnly
          ? [
              {
                id: 'edit',
                label: tKey('edit'),
                icon: React.createElement(Pencil, { size: 14 }),
                onAction: () => onEdit(folder)
              },
              'separator'
            ]
          : []

      const baseItems: ContextMenuEntry[] = [
        ...editItems,
        ...(canCopy
          ? [
              {
                id: 'copy',
                label: tKey('copy'),
                icon: React.createElement(Copy, { size: 14 }),
                onAction: () => onCopy(targetIds)
              }
            ]
          : []),
        ...(isReadOnly
          ? []
          : [
              {
                id: 'cut',
                label: tKey('cut'),
                icon: React.createElement(Scissors, { size: 14 }),
                onAction: () => onCut(targetIds)
              }
            ]),
        ...pasteItems,
        ...(isReadOnly
          ? []
          : [
              'separator' as const,
              {
                id: 'delete',
                label: tKey('delete'),
                icon: React.createElement(Trash2, { size: 14 }),
                variant: 'danger' as const,
                onAction: () => onDelete(targetIds)
              }
            ])
      ]

      const extra = config?.extraFolderActions?.(folder, t as (key: string) => string) ?? []
      showMenu([...baseItems, ...extra, ...extraActions], event)
    }

    const showMultiSelectMenu = ({
      selectedIds,
      event,
      onCopy,
      onCut,
      onDelete,
      isReadOnly = false,
      canCopy = true
    }: ShowMultiSelectMenuOptions): void => {
      const items: ContextMenuEntry[] = [
        ...(canCopy
          ? [
              {
                id: 'copy',
                label: tKey('copy'),
                icon: React.createElement(Copy, { size: 14 }),
                onAction: () => onCopy(selectedIds)
              }
            ]
          : []),
        ...(isReadOnly
          ? []
          : [
              {
                id: 'cut',
                label: tKey('cut'),
                icon: React.createElement(Scissors, { size: 14 }),
                onAction: () => onCut(selectedIds)
              },
              'separator' as const,
              {
                id: 'delete',
                label: tKey('delete'),
                icon: React.createElement(Trash2, { size: 14 }),
                variant: 'danger' as const,
                onAction: () => onDelete(selectedIds)
              }
            ])
      ]

      showMenu(items, event)
    }

    const showEmptyAreaMenu = ({
      event,
      clipboard,
      onPaste,
      onNewFolder,
      onUploadFiles,
      onUploadFolder,
      onCreatePresentation,
      onAddLocalSyncFolder,
      onAddOneDrive,
      onAddHhcLine,
      isAddOneDriveDisabled = false,
      isAddHhcLineDisabled = false,
      isReadOnly = false
    }: ShowEmptyAreaMenuOptions): void => {
      const pasteItems: ContextMenuEntry[] =
        clipboard && !isReadOnly
          ? [
              {
                id: 'paste',
                label: tKey('paste'),
                icon: React.createElement(Clipboard, { size: 14 }),
                onAction: onPaste
              },
              'separator'
            ]
          : []

      const uploadItems: ContextMenuEntry[] =
        !isReadOnly && (onUploadFiles || onUploadFolder || onCreatePresentation)
          ? [
              'separator',
              ...(onCreatePresentation
                ? [
                    {
                      id: 'create-presentation',
                      label: tKey('createPresentation'),
                      icon: React.createElement(Presentation, { size: 14 }),
                      onAction: onCreatePresentation
                    } as ContextMenuEntry
                  ]
                : []),
              ...(onUploadFiles
                ? [
                    {
                      id: 'upload-files',
                      label: tKey('uploadFiles'),
                      icon: React.createElement(Upload, { size: 14 }),
                      onAction: onUploadFiles
                    } as ContextMenuEntry
                  ]
                : []),
              ...(onUploadFolder
                ? [
                    {
                      id: 'upload-folder',
                      label: tKey('uploadFolder'),
                      icon: React.createElement(Folder, { size: 14 }),
                      onAction: onUploadFolder
                    } as ContextMenuEntry
                  ]
                : [])
            ]
          : []

      const baseItems: ContextMenuEntry[] = [
        ...pasteItems,
        ...(isReadOnly
          ? []
          : [
              {
                id: 'new-folder',
                label: tKey('newFolder'),
                icon: React.createElement(FolderPlus, { size: 14 }),
                onAction: onNewFolder
              }
            ]),
        ...uploadItems
      ]

      const sourceItems: ContextMenuEntry[] =
        onAddLocalSyncFolder || onAddOneDrive || onAddHhcLine
          ? [
              ...(baseItems.length > 0 ? (['separator'] as ContextMenuEntry[]) : []),
              ...(onAddLocalSyncFolder
                ? [
                    {
                      id: 'add-local-sync-folder',
                      label: tKey('addLocalSyncFolder'),
                      icon: React.createElement(FolderSync, { size: 14 }),
                      onAction: onAddLocalSyncFolder
                    } as ContextMenuEntry
                  ]
                : []),
              ...(onAddOneDrive
                ? [
                    {
                      id: 'add-onedrive',
                      label: tKey('addOneDrive'),
                      icon: React.createElement(Cloud, { size: 14 }),
                      disabled: isAddOneDriveDisabled,
                      onAction: onAddOneDrive
                    } as ContextMenuEntry
                  ]
                : []),
              ...(onAddHhcLine
                ? [
                    {
                      id: 'add-hhc-line',
                      label: tKey('addHhcLine'),
                      icon: React.createElement(SyncProviderIcon, {
                        providerType: 'hhc-line',
                        className: 'size-4'
                      }),
                      disabled: isAddHhcLineDisabled,
                      onAction: onAddHhcLine
                    } as ContextMenuEntry
                  ]
                : [])
            ]
          : []

      const extra = config?.extraEmptyAreaActions?.() ?? []
      showMenu([...baseItems, ...sourceItems, ...extra], event)
    }

    return { showItemMenu, showFolderMenu, showMultiSelectMenu, showEmptyAreaMenu }
  }
}
