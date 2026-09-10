import React from 'react'
import { toast } from '@heroui/react/toast'
import { Play, Star, StarOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { createFolderContextMenu } from '@renderer/lib/createFolderContextMenu'
import type { UseFolderContextMenu } from '@renderer/lib/createFolderContextMenu'
import type { ContextMenuEntry } from '@renderer/contexts/ContextMenuContext'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { isPresentable } from '@renderer/lib/presentability'
import { getExplorerProjectionPlaylist } from '@renderer/lib/file-explorer-projection'
import { presentMediaItem, startMediaProjection } from '@renderer/lib/projection-actions'
import {
  isFileItem,
  type FileItemRecord,
  type FolderItem,
  type FolderRecord
} from '@shared/types/folder'

export type {
  ClipboardState,
  UseFolderContextMenu,
  ShowItemMenuOptions,
  ShowFolderMenuOptions,
  ShowMultiSelectMenuOptions,
  ShowEmptyAreaMenuOptions
} from '@renderer/lib/createFolderContextMenu'

const useBaseFileContextMenu = createFolderContextMenu({ i18nPrefix: 'fileExplorer.contextMenu' })

function project(
  items: Parameters<typeof getExplorerProjectionPlaylist>[0],
  requestedItem: FileItemRecord | undefined,
  t: (key: string) => string,
  navigate: (path: string) => void,
  ensureProjectionOpen: ReturnType<typeof useProjection>['ensureProjectionOpen']
): void {
  const playlist = getExplorerProjectionPlaylist(items, requestedItem)
  if (playlist.length === 0) return
  const startIndex = requestedItem
    ? playlist.findIndex((entry) => entry.id === requestedItem.id)
    : 0
  if (startIndex < 0) return

  if (requestedItem) {
    void presentMediaItem({
      item: requestedItem,
      playlist,
      start: (files, index, _, options) =>
        startMediaProjection(
          files,
          index,
          {
            ensureProjectionOpen,
            onNoProjectableFiles: () => toast.warning(t('fileExplorer.noProjectableFiles'))
          },
          options
        ),
      navigate
    }).catch(() => undefined)
    return
  }

  void startMediaProjection(playlist, startIndex, {
    ensureProjectionOpen,
    onNoProjectableFiles: () => toast.warning(t('fileExplorer.noProjectableFiles'))
  })
    .then((report) => {
      if (report.summary.ready > 0) navigate('/media')
    })
    .catch(() => undefined)
}

function getItemProjectActions(
  item: FolderItem,
  t: (key: string) => string,
  navigate: (path: string) => void,
  ensureProjectionOpen: ReturnType<typeof useProjection>['ensureProjectionOpen']
): ContextMenuEntry[] {
  if (!isFileItem(item) || !isPresentable(item.mimeType)) return []

  return [
    'separator',
    {
      id: 'project',
      label: t('fileExplorer.contextMenu.project'),
      icon: React.createElement(Play, { size: 14 }),
      onAction: () => {
        const { currentFolderId, getItems } = useFileExplorerStore.getState()
        const items = getItems(currentFolderId)
        project(items, item, t, navigate, ensureProjectionOpen)
      }
    }
  ]
}

function getFolderProjectActions(
  folder: FolderRecord,
  t: (key: string) => string,
  navigate: (path: string) => void,
  ensureProjectionOpen: ReturnType<typeof useProjection>['ensureProjectionOpen']
): ContextMenuEntry[] {
  const { toggleFavorite, getItems } = useFileExplorerStore.getState()
  const items = getItems(folder.id)
  const playlist = getExplorerProjectionPlaylist(items)
  const isFavorited = folder.isFavorited ?? false
  const actions: ContextMenuEntry[] = []

  if (playlist.length > 0) {
    actions.push('separator', {
      id: 'project',
      label: t('fileExplorer.contextMenu.project'),
      icon: React.createElement(Play, { size: 14 }),
      onAction: () => project(items, undefined, t, navigate, ensureProjectionOpen)
    })
  }

  if (!folder.sharedRecipientId) {
    actions.push(...(actions.length === 0 ? ['separator' as const] : []), {
      id: isFavorited ? 'remove-favorite' : 'add-favorite',
      label: t(
        isFavorited
          ? 'fileExplorer.contextMenu.removeFavorite'
          : 'fileExplorer.contextMenu.addFavorite'
      ),
      icon: React.createElement(isFavorited ? StarOff : Star, { size: 14 }),
      onAction: () => toggleFavorite(folder.id)
    })
  }

  return actions
}

export function useFileContextMenu(): UseFolderContextMenu {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { ensureProjectionOpen } = useProjection()
  const menu = useBaseFileContextMenu()
  const translate = (key: string): string => t(key as never) as string

  return {
    ...menu,
    showItemMenu: (options: Parameters<typeof menu.showItemMenu>[0]) => {
      const actions = getItemProjectActions(options.item, translate, navigate, ensureProjectionOpen)
      if (options.canCopy === false && actions[0] === 'separator') actions.shift()
      menu.showItemMenu({
        ...options,
        extraActions: [...actions, ...(options.extraActions ?? [])]
      })
    },
    showFolderMenu: (options: Parameters<typeof menu.showFolderMenu>[0]) => {
      const actions = getFolderProjectActions(
        options.folder,
        translate,
        navigate,
        ensureProjectionOpen
      )
      if (options.canCopy === false && actions[0] === 'separator') actions.shift()
      menu.showFolderMenu({
        ...options,
        extraActions: [...actions, ...(options.extraActions ?? [])]
      })
    }
  }
}
