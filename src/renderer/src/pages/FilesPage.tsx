import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useNavigate } from 'react-router-dom'
import { toast } from '@heroui/react/toast'
import { FileExplorerShell, useFileContextMenu } from '@renderer/components/Control/FileExplorer'
import FileBrowser from '@renderer/components/Control/FileExplorer/FileBrowser'
import FileExplorerFAB from '@renderer/components/Control/FileExplorer/FileExplorerFAB'
import CloudFolderPickerDialog, {
  type CloudFolderPickerProvider
} from '@renderer/components/Control/FileExplorer/CloudFolderPickerDialog'
import type { ContextMenuEntry } from '@renderer/contexts/ContextMenuContext'
import { FolderModal } from '@renderer/components/Control/Folder/FolderModal'
import {
  createExplorerFolder,
  copyExplorerFolder,
  deleteFolderFromStore,
  removeFileItemFromStore,
  useFileExplorerStore,
  FILE_EXPLORER_ROOT_ID
} from '@renderer/stores/file-explorer'
import { useSoundboardStore } from '@renderer/stores/soundboard'
import { getUploadMediaPlatform, uploadFiles, uploadFolderFiles } from '@renderer/lib/upload-utils'
import { LogOut, Presentation, RefreshCw, Share2, Unlink } from 'lucide-react'
import { createEditablePresentation } from '@renderer/lib/editable-presentation'
import { connectLocalSyncFolder, refreshLocalSyncConnection } from '@renderer/lib/local-sync-import'
import { getCloudProviderAdapter, type CloudRemoteFolder } from '@renderer/lib/cloud-provider'
import { unlinkSyncRootFolderFromApp } from '@renderer/lib/sync-unlink'
import { refreshSyncFolderOnNavigation } from '@renderer/lib/sync-folder-refresh'
import { openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { isElectron } from '@renderer/lib/env'
import {
  computeExpiresAt,
  inferDuration,
  isFileItem,
  type AnyItemRecord,
  type FolderDuration,
  type FolderRecord
} from '@shared/types/folder'
import type { ClipboardState } from '@renderer/components/Control/FileExplorer'
import { useConfirm } from '@renderer/contexts/ConfirmDialogContext'
import { getMediaFileAcceptAttribute } from '@renderer/lib/media-capabilities'
import { getPresentationWorkspacePath } from '@renderer/lib/presentation-media'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import {
  hasNameConflict,
  resolveUniqueFileName,
  resolveUniqueName,
  validateDisplayName
} from '@renderer/lib/file-naming'
import { isFolderReadOnlyBySyncLink, isPersonalRootFolder } from '@renderer/lib/sync-readonly'
import { SyncProviderIcon } from '@renderer/components/icons/SyncProviderIcon'
import { FolderPersistenceStatus } from '@renderer/components/Common/FolderPersistenceStatus'
import { buildPresentationItemActions } from '@renderer/lib/presentation-item-actions'
import { useHhcAuth } from '@renderer/contexts/HhcAuthContext'
import { PersonalCloudStatus } from '@renderer/components/Control/FileExplorer/PersonalCloudStatus'
import { PersonalCloudUsage } from '@renderer/components/Control/FileExplorer/PersonalCloudUsage'
import { ShareFolderDialog } from '@renderer/components/Control/FileExplorer/ShareFolderDialog'

import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import {
  leavePersonalShare,
  personalShareContainerId,
  reconcilePersonalShares
} from '@renderer/lib/personal-share-sync'

type FilesMode = 'local' | 'personal' | 'shared'

const ONE_DRIVE_PROVIDER = getCloudProviderAdapter('onedrive')
const ONE_DRIVE_FOLDER_PICKER_PROVIDER: CloudFolderPickerProvider = {
  providerType: 'onedrive',
  displayName: 'OneDrive',
  icon: React.createElement(SyncProviderIcon, {
    providerType: 'onedrive',
    className: 'size-5'
  }),
  listFolders: ONE_DRIVE_PROVIDER.listFolders,
  importFolder: ONE_DRIVE_PROVIDER.importFolder
}

function isInsideAnyFolder(
  folderId: string,
  targetFolderIds: Set<string>,
  foldersById: Record<string, FolderRecord>
): boolean {
  let currentId: string | null = folderId
  while (currentId) {
    if (targetFolderIds.has(currentId)) return true
    currentId = foldersById[currentId]?.parentId ?? null
  }
  return false
}

async function collectDeletedFileIds(targetIds: Set<string>): Promise<Set<string>> {
  const state = useFileExplorerStore.getState()
  const targetFolderIds = new Set<string>()
  const targetFileIds = new Set<string>()

  for (const id of targetIds) {
    if (state.folders[id]) {
      targetFolderIds.add(id)
    } else if (state.items[id] && isFileItem(state.items[id])) {
      targetFileIds.add(id)
    }
  }

  if (targetFolderIds.size === 0) return targetFileIds

  const db = await openFileExplorerDB()
  const items = await db.getAll('folder-items')
  for (const item of items) {
    if (item.deletedAt || !isFileItem(item)) continue
    if (isInsideAnyFolder(item.parentId, targetFolderIds, state.folders)) {
      targetFileIds.add(item.id)
    }
  }

  return targetFileIds
}

async function countDeletedSoundboardPadUsages(targetIds: Set<string>): Promise<number> {
  const fileIds = await collectDeletedFileIds(targetIds)
  return Array.from(fileIds).reduce(
    (count, fileId) => count + useSoundboardStore.getState().findPadsUsingAsset(fileId).length,
    0
  )
}

export default function FilesPage({
  mode = 'local'
}: {
  mode?: FilesMode
}): React.JSX.Element | null {
  const auth = useHhcAuth()
  const ownerId = usePersonalSyncStore((state) => state.activeOwnerId)
  const folders = useFileExplorerStore((state) => state.folders)
  const currentId = useFileExplorerStore((state) => state.currentFolderId)
  const navigateToFolder = useFileExplorerStore((state) => state.navigateToFolder)
  const root = Object.values(folders).find(
    (folder) => folder.personalOwnerId === ownerId && isPersonalRootFolder(folder)
  )
  const sharedRoot = ownerId ? folders[personalShareContainerId(ownerId)] : undefined
  const inScope =
    mode === 'personal'
      ? Boolean(ownerId && root && folders[currentId]?.personalOwnerId === ownerId)
      : mode === 'shared'
        ? Boolean(ownerId && sharedRoot && folders[currentId]?.sharedRecipientId === ownerId)
        : !folders[currentId]?.personalOwnerId && !folders[currentId]?.sharedRecipientId

  useEffect(() => {
    if (mode !== 'shared' || !ownerId) return
    void reconcilePersonalShares({
      getSession: () => auth.session,
      getAccessToken: auth.getAccessToken,
      refreshAccessToken: auth.refreshAccessToken,
      getAuthGeneration: auth.getAuthGeneration,
      endSession: auth.endSession
    }).catch(() => undefined)
  }, [auth, mode, ownerId])

  useLayoutEffect(() => {
    const target = mode === 'personal' ? root : mode === 'shared' ? sharedRoot : undefined
    if (!inScope && (mode === 'local' || target))
      void navigateToFolder(target?.id ?? FILE_EXPLORER_ROOT_ID)
  }, [inScope, mode, navigateToFolder, root, sharedRoot])
  if (!inScope) return mode === 'personal' && ownerId ? <PersonalCloudStatus /> : null
  return <FilesWorkspace key={mode === 'local' ? mode : `${mode}:${ownerId}`} mode={mode} />
}

function FilesWorkspace({ mode }: { mode: FilesMode }): React.JSX.Element {
  const cloud = mode === 'personal'
  const shared = mode === 'shared'
  const { t } = useTranslation()
  const { session, getAccessToken, getAuthGeneration, refreshAccessToken, endSession } =
    useHhcAuth()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const currentFolderId = useFileExplorerStore((state) => state.currentFolderId)
  const foldersById = useFileExplorerStore((state) => state.folders)
  const getChildFolders = useFileExplorerStore((state) => state.getChildFolders)
  const addFolder = createExplorerFolder
  const moveItem = useFileExplorerStore((state) => state.moveItem)
  const copyItem = useFileExplorerStore((state) => state.copyItem)
  const moveFolder = useFileExplorerStore((state) => state.moveFolder)
  const updateFolder = useFileExplorerStore((state) => state.updateFolder)
  const persistenceStatus = useFileExplorerStore((state) => state.persistenceStatus)
  const persistenceError = useFileExplorerStore((state) => state.persistenceError)
  const isFolderStoreInitialized = useFileExplorerStore((state) => state.isInitialized)
  const retryInitialization = useFileExplorerStore((state) => state.retryInitialization)
  const retryPersistence = useFileExplorerStore((state) => state.retryPersistence)
  const { showItemMenu, showFolderMenu, showMultiSelectMenu, showEmptyAreaMenu } =
    useFileContextMenu()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null)
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false)
  const [createFolderName, setCreateFolderName] = useState('')
  const [createFolderDuration, setCreateFolderDuration] = useState<FolderDuration>('1day')
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [sharingFolder, setSharingFolder] = useState<FolderRecord | null>(null)
  const [renameItemRequestId, setRenameItemRequestId] = useState<string | null>(null)
  const [editModalName, setEditModalName] = useState('')
  const [editModalDuration, setEditModalDuration] = useState<FolderDuration>('1day')
  const [editingIsFavorited, setEditingIsFavorited] = useState(false)
  const [hasOneDriveConnection, setHasOneDriveConnection] = useState(false)
  const [isOneDrivePickerOpen, setIsOneDrivePickerOpen] = useState(false)
  const [isOneDriveImporting, setIsOneDriveImporting] = useState(false)
  const [isHhcLinePickerOpen, setIsHhcLinePickerOpen] = useState(false)
  const [isHhcLineImporting, setIsHhcLineImporting] = useState(false)
  const [claimsResolvedUserId, setClaimsResolvedUserId] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session

  const hhcAuth = useMemo(
    () => ({
      getSession: () => sessionRef.current,
      getAuthGeneration,
      getAccessToken,
      refreshAccessToken,
      endSession
    }),
    [endSession, getAccessToken, getAuthGeneration, refreshAccessToken]
  )
  const hhcLineProvider = useMemo(() => getCloudProviderAdapter('hhc-line', hhcAuth), [hhcAuth])
  const hhcLinePickerProvider = useMemo<CloudFolderPickerProvider>(
    () => ({
      providerType: 'hhc-line',
      displayName: t('fileExplorer.syncSources.hhcLineName'),
      icon: React.createElement(SyncProviderIcon, {
        providerType: 'hhc-line',
        className: 'size-5'
      }),
      supportsFolderNavigation: false,
      listFolders: hhcLineProvider.listFolders,
      importFolder: hhcLineProvider.importFolder
    }),
    [hhcLineProvider, t]
  )

  useEffect(() => {
    const userId = session?.userId
    setClaimsResolvedUserId(null)
    if (!userId || mode !== 'local') return
    let active = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const folders = await hhcLineProvider.listFolders()
        if (active && sessionRef.current?.userId === userId)
          setClaimsResolvedUserId(folders.length > 0 ? userId : null)
      } catch {
        if (active) setClaimsResolvedUserId(null)
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    const onRefresh = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onRefresh)
    window.addEventListener('online', onRefresh)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', onRefresh)
      window.removeEventListener('online', onRefresh)
    }
  }, [mode, hhcLineProvider, session?.userId, isHhcLineImporting])

  const itemCount = useFileExplorerStore(
    useCallback(
      (state) =>
        (state._itemsByParent[currentFolderId]?.filter((item) => !item.deletedAt).length ?? 0) +
        (state._childFoldersByParent[currentFolderId]?.filter(
          (folder) => !folder.deletedAt && !isPersonalRootFolder(folder)
        ).length ?? 0),
      [currentFolderId]
    )
  )
  const selectedCount = selectedIds.size
  const fileAccept = getMediaFileAcceptAttribute(getUploadMediaPlatform())
  const canAddSyncSourceHere = currentFolderId === FILE_EXPLORER_ROOT_ID
  const canAddLocalSyncFolder = isElectron() && canAddSyncSourceHere
  const canAddOneDriveFolder = canAddSyncSourceHere
  const canAddHhcLineFolder =
    canAddSyncSourceHere && Boolean(session && claimsResolvedUserId === session.userId)

  useEffect(() => {
    if (!canAddHhcLineFolder) setIsHhcLinePickerOpen(false)
  }, [canAddHhcLineFolder])
  const handleOpenHhcLinePicker = useCallback((): void => {
    if (!canAddHhcLineFolder) return
    setIsHhcLinePickerOpen(true)
  }, [canAddHhcLineFolder])
  const isCurrentFolderReadOnly = useMemo(
    () => shared || isFolderReadOnlyBySyncLink(currentFolderId, foldersById),
    [currentFolderId, foldersById, shared]
  )

  const areIdsReadOnly = useCallback((ids: Set<string>): boolean => {
    const state = useFileExplorerStore.getState()
    for (const id of ids) {
      const folder = state.folders[id]
      if (folder && isPersonalRootFolder(folder)) return true
      if (folder && isFolderReadOnlyBySyncLink(folder.id, state.folders)) return true
      const item = state.items[id]
      if (item && isFolderReadOnlyBySyncLink(item.parentId, state.folders)) return true
    }
    return false
  }, [])

  const getPresentationItemActions = useCallback(
    (item: AnyItemRecord): ContextMenuEntry[] => {
      return buildPresentationItemActions({
        item,
        openLabel: t('fileExplorer.contextMenu.openPresentation'),
        convertLabel: t('fileExplorer.contextMenu.convertPresentation'),
        openIcon: React.createElement(Presentation, { size: 14 }),
        navigate
      })
    },
    [navigate, t]
  )

  useEffect(() => {
    const el = folderInputRef.current
    if (el) {
      el.setAttribute('webkitdirectory', '')
      el.setAttribute('directory', '')
    }
  }, [])

  const refreshOneDriveConnection = useCallback(async (): Promise<void> => {
    if (!canAddOneDriveFolder) {
      setHasOneDriveConnection(false)
      return
    }
    setHasOneDriveConnection(Boolean(await ONE_DRIVE_PROVIDER.getConnectedAccount()))
  }, [canAddOneDriveFolder])

  useEffect(() => {
    void refreshOneDriveConnection()
    const handleConnectionChanged = (): void => {
      void refreshOneDriveConnection()
    }
    window.addEventListener('onedrive-connection-changed', handleConnectionChanged)
    return () => {
      window.removeEventListener('onedrive-connection-changed', handleConnectionChanged)
    }
  }, [refreshOneDriveConnection])

  const handleUploadFiles = useCallback((): void => {
    if (isCurrentFolderReadOnly) return
    fileInputRef.current?.click()
  }, [isCurrentFolderReadOnly])

  const handleUploadFolder = useCallback((): void => {
    if (isCurrentFolderReadOnly) return
    folderInputRef.current?.click()
  }, [isCurrentFolderReadOnly])

  const handleCreatePresentation = useCallback(async (): Promise<void> => {
    if (isCurrentFolderReadOnly) return
    try {
      const existingNames = useFileExplorerStore
        .getState()
        .getItems(currentFolderId)
        .filter(isFileItem)
        .map((item) => item.name)
      const name = resolveUniqueFileName(
        t('presentationWorkspace.untitledName', 'Untitled Presentation'),
        existingNames
      )
      const item = await createEditablePresentation(name, currentFolderId)
      usePresentationWorkspaceStore.getState().openDocument(item)
      navigate(getPresentationWorkspacePath(item.id))
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : String(error))
    }
  }, [currentFolderId, isCurrentFolderReadOnly, navigate, t])

  const handleAddLocalSyncFolder = useCallback(async (): Promise<void> => {
    try {
      const summary = await connectLocalSyncFolder()
      if (!summary) return
      toast.success(
        t('fileExplorer.syncSources.localSyncConnected', {
          name: summary.connection.displayName,
          count: summary.itemCount
        })
      )
    } catch (error) {
      console.warn('[local-sync] Failed to connect folder', error)
      toast.danger(t('fileExplorer.syncSources.localSyncConnectFailed'))
    }
  }, [t])

  const handleAddOneDrive = useCallback(async (): Promise<void> => {
    if (!hasOneDriveConnection) {
      toast.warning(t('fileExplorer.syncSources.oneDriveLoginRequired'))
      return
    }
    setIsOneDrivePickerOpen(true)
  }, [hasOneDriveConnection, t])

  const handleImportOneDriveFolder = useCallback(
    async (folder: CloudRemoteFolder): Promise<void> => {
      setIsOneDrivePickerOpen(false)
      setIsOneDriveImporting(true)
      try {
        const result = await ONE_DRIVE_PROVIDER.importFolder(folder)
        toast.success(
          t('fileExplorer.syncSources.oneDriveFolderImported', {
            name: result.displayName,
            count: result.itemCount
          })
        )
      } catch (error) {
        console.warn('[onedrive] Failed to import folder', error)
        toast.danger(t('fileExplorer.syncSources.oneDriveImportFailed'))
      } finally {
        setIsOneDriveImporting(false)
      }
    },
    [t]
  )

  const handleImportHhcLineFolder = useCallback(
    async (folder: CloudRemoteFolder): Promise<void> => {
      setIsHhcLinePickerOpen(false)
      setIsHhcLineImporting(true)
      try {
        const result = await hhcLineProvider.importFolder(folder)
        toast.success(
          t('fileExplorer.syncSources.hhcLineFolderImported', {
            name: result.displayName,
            count: result.itemCount
          })
        )
      } catch (error) {
        console.warn('[hhc-line] Failed to import collection', error)
        toast.danger(t('fileExplorer.syncSources.hhcLineImportFailed'))
      } finally {
        setIsHhcLineImporting(false)
      }
    },
    [hhcLineProvider, t]
  )

  const findSyncRootFolder = useCallback((folderId: string): FolderRecord | null => {
    const state = useFileExplorerStore.getState()
    let current = state.folders[folderId] ?? null
    let root: FolderRecord | null = current?.syncLink ? current : null
    while (current?.parentId) {
      const parent = state.folders[current.parentId]
      if (
        !parent?.syncLink ||
        !root?.syncLink ||
        parent.syncLink.providerConnectionId !== root.syncLink.providerConnectionId
      ) {
        break
      }
      root = parent
      current = parent
    }
    return root
  }, [])

  useEffect(() => {
    const root = findSyncRootFolder(currentFolderId)
    if (!root?.syncLink) return
    void refreshSyncFolderOnNavigation(root.id, hhcAuth)
  }, [currentFolderId, findSyncRootFolder, hhcAuth])

  const isSyncRootFolder = useCallback((folder: FolderRecord): boolean => {
    return folder.parentId === FILE_EXPLORER_ROOT_ID && Boolean(folder.syncLink)
  }, [])

  const findSingleSelectedSyncRoot = useCallback(
    (targetIds: Set<string>): FolderRecord | null => {
      if (targetIds.size !== 1) return null
      const folder = useFileExplorerStore.getState().folders[[...targetIds][0]]
      return folder && isSyncRootFolder(folder) ? folder : null
    },
    [isSyncRootFolder]
  )

  const handleUnlinkSyncRoot = useCallback(
    async (root: FolderRecord): Promise<void> => {
      const confirmed = await confirm({
        title: t('fileExplorer.syncSources.unlinkTitle', { name: root.name }),
        description: t('fileExplorer.syncSources.unlinkDescription'),
        confirmLabel: t('fileExplorer.syncSources.unlink'),
        status: 'danger'
      })
      if (!confirmed) return

      try {
        await unlinkSyncRootFolderFromApp(root)
        setSelectedIds(new Set())
        toast.success(t('fileExplorer.syncSources.unlinked'))
      } catch (error) {
        console.warn('[sync] Failed to unlink sync source', error)
        toast.danger(t('fileExplorer.syncSources.unlinkFailed'))
      }
    },
    [confirm, t]
  )

  const handleRefreshSyncFolder = useCallback(
    async (folderId: string): Promise<void> => {
      const root = findSyncRootFolder(folderId)
      const syncLink = root?.syncLink
      if (!root || !syncLink) return
      try {
        if (syncLink.providerType === 'local-fs') {
          await refreshLocalSyncConnection(syncLink.providerConnectionId)
        } else if (syncLink.providerType === 'onedrive') {
          await ONE_DRIVE_PROVIDER.refreshFolder(root.id, { forceRetry: true })
        } else if (syncLink.providerType === 'hhc-line') {
          await hhcLineProvider.refreshFolder(root.id, { forceRetry: true })
        }
        toast.success(t('fileExplorer.syncSources.refreshComplete'))
      } catch (error) {
        console.warn('[sync] Failed to refresh sync source', error)
        toast.danger(t('fileExplorer.syncSources.refreshFailed'))
      }
    },
    [findSyncRootFolder, hhcLineProvider, t]
  )

  const getRefreshSyncActions = useCallback(
    (
      folderId: string,
      labelKey: 'refreshSyncFolder' | 'resyncFile' = 'refreshSyncFolder'
    ): ContextMenuEntry[] => {
      const root = findSyncRootFolder(folderId)
      if (!root?.syncLink) return []
      if (root.syncLink.providerType === 'local-fs' && !isElectron()) return []
      const label =
        labelKey === 'resyncFile'
          ? t('fileExplorer.contextMenu.resyncFile')
          : t('fileExplorer.contextMenu.refreshSyncFolder')
      return [
        'separator',
        {
          id: 'refresh-sync-source',
          label,
          icon: React.createElement(RefreshCw, { size: 14 }),
          onAction: () => void handleRefreshSyncFolder(root.id)
        }
      ]
    },
    [findSyncRootFolder, handleRefreshSyncFolder, t]
  )

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = Array.from(e.target.files ?? [])
      if (files.length === 0) return
      if (isCurrentFolderReadOnly) return
      await uploadFiles(files, currentFolderId)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [currentFolderId, isCurrentFolderReadOnly]
  )

  const handleFolderChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const allFiles = Array.from(e.target.files ?? [])
      if (allFiles.length === 0) return
      if (isCurrentFolderReadOnly) return
      await uploadFolderFiles(allFiles, currentFolderId, addFolder)
      if (folderInputRef.current) folderInputRef.current.value = ''
    },
    [currentFolderId, addFolder, isCurrentFolderReadOnly]
  )

  const handleSelectionChange = useCallback((nextSelectedIds: Set<string>): void => {
    setSelectedIds(nextSelectedIds)
  }, [])

  const handleCopy = useCallback((targetIds: Set<string>): void => {
    if (targetIds.size === 0) return
    setClipboard({ itemIds: new Set(targetIds), mode: 'copy' })
  }, [])

  const handleCut = useCallback(
    (targetIds: Set<string>): void => {
      if (targetIds.size === 0) return
      if (areIdsReadOnly(targetIds)) return
      setClipboard({ itemIds: new Set(targetIds), mode: 'cut' })
    },
    [areIdsReadOnly]
  )

  const handleEscape = useCallback((): void => {
    if (clipboard?.mode === 'cut') {
      setClipboard(null)
    }
  }, [clipboard])

  const handleDelete = useCallback(
    async (targetIds: Set<string>): Promise<void> => {
      if (targetIds.size === 0) return
      const syncRoot = findSingleSelectedSyncRoot(targetIds)
      if (syncRoot) {
        await handleUnlinkSyncRoot(syncRoot)
        return
      }
      if (areIdsReadOnly(targetIds)) return
      const soundboardUsageCount = await countDeletedSoundboardPadUsages(targetIds)
      const confirmed = await confirm({
        title: t('folder.deleteSelectedTitle', {
          count: targetIds.size,
          defaultValue: `Delete ${targetIds.size} item(s)?`
        }),
        description:
          soundboardUsageCount > 0
            ? t('folder.deleteSoundboardAssetDescription', {
                count: soundboardUsageCount,
                defaultValue:
                  'This removes audio assigned to {{count}} soundboard pad(s). This action cannot be undone.'
              })
            : t('folder.deleteItemDescription', 'This action cannot be undone.'),
        status: 'danger'
      })
      if (!confirmed) return
      for (const id of targetIds) {
        const state = useFileExplorerStore.getState()
        if (state.folders[id]) {
          deleteFolderFromStore(id)
        } else {
          removeFileItemFromStore(id)
        }
      }
      setSelectedIds(new Set())
    },
    [confirm, t, areIdsReadOnly, findSingleSelectedSyncRoot, handleUnlinkSyncRoot]
  )

  const handlePaste = useCallback(async (): Promise<void> => {
    if (!clipboard) return
    if (isCurrentFolderReadOnly) return

    async function copyFolderRecursive(
      sourceId: string,
      targetParentId: string,
      folderName: string,
      expiresAt: number | null | undefined
    ): Promise<void> {
      const current = useFileExplorerStore.getState()
      if (
        current.folders[sourceId]?.personalOwnerId ||
        current.folders[targetParentId]?.personalOwnerId
      ) {
        await copyExplorerFolder(sourceId, targetParentId)
        return
      }
      const newFolderId = await addFolder(folderName, targetParentId, expiresAt)
      await useFileExplorerStore.getState().ensureItemsLoaded(sourceId)
      const s = useFileExplorerStore.getState()
      for (const item of s.getItems(sourceId)) {
        const newId = await copyItem(item.id, newFolderId)
        if (!newId) continue
      }
      for (const sub of s.getChildFolders(sourceId)) {
        await copyFolderRecursive(sub.id, newFolderId, sub.name, sub.expiresAt)
      }
    }

    const state = useFileExplorerStore.getState()
    const usedFolderNames = new Set(state.getChildFolders(currentFolderId).map((f) => f.name))
    const usedItemNames = new Set(
      state
        .getItems(currentFolderId)
        .filter(isFileItem)
        .map((i) => i.name)
    )

    for (const id of clipboard.itemIds) {
      if (state.folders[id]) {
        if (clipboard.mode === 'copy') {
          const uniqueName = resolveUniqueName(state.folders[id].name, [...usedFolderNames])
          usedFolderNames.add(uniqueName)
          await copyFolderRecursive(id, currentFolderId, uniqueName, state.folders[id].expiresAt)
        } else {
          moveFolder(id, currentFolderId)
        }
      } else if (state.items[id]) {
        const item = state.items[id]
        if (!isFileItem(item)) continue
        if (clipboard.mode === 'copy') {
          const uniqueName = resolveUniqueFileName(item.name, [...usedItemNames])
          usedItemNames.add(uniqueName)
          const newId = await copyItem(id, currentFolderId)
          if (!newId) continue
          if (uniqueName !== item.name) {
            useFileExplorerStore.getState().updateItem?.(newId, { name: uniqueName })
          }
        } else {
          moveItem(id, currentFolderId)
        }
      }
    }

    if (clipboard.mode === 'cut') setClipboard(null)
    setSelectedIds(new Set())
  }, [
    clipboard,
    currentFolderId,
    addFolder,
    copyItem,
    moveFolder,
    moveItem,
    isCurrentFolderReadOnly
  ])

  const openEditModal = useCallback((id: string): void => {
    const state = useFileExplorerStore.getState()
    const target = state.folders[id]
    if (!target) return
    if (isPersonalRootFolder(target)) return
    if (isFolderReadOnlyBySyncLink(target.id, state.folders)) return
    setEditingId(id)
    setEditModalName(target.name)
    setEditModalDuration(inferDuration(target.expiresAt, target.createdAt ?? Date.now()))
    setEditingIsFavorited(target.isFavorited ?? false)
    setIsEditModalOpen(true)
  }, [])

  const handleEditSubmit = useCallback((): void => {
    if (!editingId) return
    const name = editModalName.trim()
    if (!validateDisplayName(name)) {
      toast.danger(t('fileExplorer.invalidName', 'Invalid name'))
      return
    }
    const state = useFileExplorerStore.getState()
    const folder = state.folders[editingId]
    if (folder) {
      if (isFolderReadOnlyBySyncLink(folder.id, state.folders)) return
      const siblingNames = state
        .getChildFolders(folder.parentId ?? FILE_EXPLORER_ROOT_ID)
        .map((entry) => entry.name)
      if (hasNameConflict(name, siblingNames, { excludeName: folder.name })) {
        toast.danger(
          t('fileExplorer.folderAlreadyExists', 'A folder with this name already exists')
        )
        return
      }
      updateFolder(editingId, { name, expiresAt: computeExpiresAt(editModalDuration) })
    }
    setIsEditModalOpen(false)
    setEditingId(null)
  }, [editingId, editModalName, editModalDuration, updateFolder, t])

  const handleItemContextMenu = useCallback(
    (itemId: string, event: React.MouseEvent): void => {
      const state = useFileExplorerStore.getState()
      const item = state.items[itemId]
      if (!item) return

      const isAlreadySelected = selectedIds.has(itemId)
      if (selectedIds.size > 1 && isAlreadySelected) {
        const isReadOnly = areIdsReadOnly(selectedIds)
        showMultiSelectMenu({
          selectedIds,
          event,
          onCopy: handleCopy,
          onCut: handleCut,
          onDelete: handleDelete,
          isReadOnly,
          canCopy: !shared
        })
        return
      }

      const isReadOnly = isFolderReadOnlyBySyncLink(item.parentId, state.folders)
      showItemMenu({
        item,
        isAlreadySelected,
        event,
        setSelected: setSelectedIds,
        onCopy: handleCopy,
        onCut: handleCut,
        onDelete: handleDelete,
        onEdit: (targetItem) => setRenameItemRequestId(targetItem.id),
        isReadOnly,
        canCopy: !shared,
        extraActions: [
          ...getPresentationItemActions(item),
          ...(isReadOnly ? getRefreshSyncActions(item.parentId, 'resyncFile') : [])
        ]
      })
    },
    [
      selectedIds,
      showMultiSelectMenu,
      showItemMenu,
      handleCopy,
      handleCut,
      handleDelete,
      getRefreshSyncActions,
      getPresentationItemActions,
      areIdsReadOnly,
      shared
    ]
  )

  const handleFolderContextMenu = useCallback(
    (folderId: string, event: React.MouseEvent): void => {
      const folder = useFileExplorerStore.getState().folders[folderId]
      if (!folder) return

      const isAlreadySelected = selectedIds.has(folderId)
      if (selectedIds.size > 1 && isAlreadySelected) {
        const isReadOnly = areIdsReadOnly(selectedIds)
        showMultiSelectMenu({
          selectedIds,
          event,
          onCopy: handleCopy,
          onCut: handleCut,
          onDelete: handleDelete,
          isReadOnly,
          canCopy: !shared
        })
        return
      }

      const isReadOnly =
        isPersonalRootFolder(folder) ||
        isFolderReadOnlyBySyncLink(folder.id, useFileExplorerStore.getState().folders)
      showFolderMenu({
        folder,
        isAlreadySelected,
        event,
        setSelected: setSelectedIds,
        clipboard,
        onCopy: handleCopy,
        onCut: handleCut,
        onPaste: handlePaste,
        onDelete: handleDelete,
        onEdit: (targetFolder) => openEditModal(targetFolder.id),
        isReadOnly,
        canCopy: !shared,
        extraActions: [
          ...(cloud &&
          folder.personalOwnerId === session?.userId &&
          !isPersonalRootFolder(folder) &&
          !folder.syncLink
            ? [
                {
                  id: 'share-folder',
                  label: t('personalShare.share'),
                  icon: React.createElement(Share2, { size: 14 }),
                  onAction: () => setSharingFolder(folder)
                }
              ]
            : []),
          ...getRefreshSyncActions(folder.id),
          ...(!shared && isSyncRootFolder(folder)
            ? [
                'separator' as const,
                {
                  id: 'unlink-sync-source',
                  label: t('fileExplorer.syncSources.unlink'),
                  icon: React.createElement(Unlink, { size: 14 }),
                  variant: 'danger' as const,
                  onAction: () => void handleUnlinkSyncRoot(folder)
                }
              ]
            : []),
          ...(shared && session && folder.parentId === personalShareContainerId(session.userId)
            ? [
                'separator' as const,
                {
                  id: 'leave-share',
                  label: t('personalShare.leave'),
                  icon: React.createElement(LogOut, { size: 14 }),
                  variant: 'danger' as const,
                  onAction: () =>
                    void confirm({
                      title: t('personalShare.leave'),
                      description: t('personalShare.leaveConfirm'),
                      confirmLabel: t('personalShare.leave')
                    }).then((accepted) =>
                      accepted
                        ? leavePersonalShare(
                            {
                              getSession: () => session,
                              getAccessToken,
                              refreshAccessToken,
                              getAuthGeneration,
                              endSession
                            },
                            folder
                          )
                        : undefined
                    )
                }
              ]
            : [])
        ]
      })
    },
    [
      selectedIds,
      clipboard,
      showMultiSelectMenu,
      showFolderMenu,
      handleCopy,
      handleCut,
      handlePaste,
      handleDelete,
      openEditModal,
      getRefreshSyncActions,
      handleUnlinkSyncRoot,
      isSyncRootFolder,
      areIdsReadOnly,
      t,
      shared,
      session,
      confirm,
      getAccessToken,
      refreshAccessToken,
      getAuthGeneration,
      endSession,
      cloud
    ]
  )

  const openCreateFolderModal = useCallback((): void => {
    if (isCurrentFolderReadOnly) return
    const existingNames = getChildFolders(currentFolderId).map((f) => f.name)
    const base = t('folder.untitledFolder')
    setCreateFolderName(resolveUniqueName(base, existingNames))
    setCreateFolderDuration('1day')
    setIsCreateFolderModalOpen(true)
  }, [getChildFolders, currentFolderId, t, isCurrentFolderReadOnly])

  const handleCreateFolderSubmit = useCallback(async (): Promise<void> => {
    const name = createFolderName.trim()
    if (isCurrentFolderReadOnly) return
    if (!validateDisplayName(name)) {
      toast.danger(t('fileExplorer.invalidName', 'Invalid name'))
      return
    }
    const siblingNames = getChildFolders(currentFolderId).map((folder) => folder.name)
    if (hasNameConflict(name, siblingNames)) {
      toast.danger(t('fileExplorer.folderAlreadyExists', 'A folder with this name already exists'))
      return
    }
    try {
      await addFolder(name, currentFolderId, computeExpiresAt(createFolderDuration))
      setIsCreateFolderModalOpen(false)
    } catch (error) {
      toast.danger(
        error instanceof Error ? error.message : t('fileExplorer.invalidName', 'Invalid name')
      )
    }
  }, [
    createFolderName,
    createFolderDuration,
    addFolder,
    currentFolderId,
    getChildFolders,
    t,
    isCurrentFolderReadOnly
  ])

  const handleEmptyAreaContextMenu = useCallback(
    (event: React.MouseEvent): void => {
      showEmptyAreaMenu({
        event,
        clipboard,
        onPaste: handlePaste,
        onNewFolder: openCreateFolderModal,
        onUploadFiles: handleUploadFiles,
        onUploadFolder: handleUploadFolder,
        onCreatePresentation: handleCreatePresentation,
        onAddLocalSyncFolder: canAddLocalSyncFolder
          ? () => void handleAddLocalSyncFolder()
          : undefined,
        onAddOneDrive: canAddOneDriveFolder ? () => void handleAddOneDrive() : undefined,
        onAddHhcLine: canAddSyncSourceHere ? handleOpenHhcLinePicker : undefined,
        isAddOneDriveDisabled: !hasOneDriveConnection,
        isAddHhcLineDisabled: !canAddHhcLineFolder,
        isReadOnly: isCurrentFolderReadOnly
      })
    },
    [
      clipboard,
      showEmptyAreaMenu,
      handlePaste,
      openCreateFolderModal,
      handleUploadFiles,
      handleUploadFolder,
      handleCreatePresentation,
      canAddLocalSyncFolder,
      canAddOneDriveFolder,
      canAddHhcLineFolder,
      canAddSyncSourceHere,
      handleOpenHhcLinePicker,
      handleAddLocalSyncFolder,
      handleAddOneDrive,
      hasOneDriveConnection,
      isCurrentFolderReadOnly
    ]
  )

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={fileAccept}
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        accept={fileAccept}
        className="hidden"
        onChange={(e) => void handleFolderChange(e)}
      />
      <FileExplorerShell
        itemCount={itemCount}
        selectedCount={selectedCount}
        endContent={cloud ? <PersonalCloudUsage /> : undefined}
      >
        {cloud && <PersonalCloudStatus />}
        <FolderPersistenceStatus
          className="mx-3 mt-3"
          status={persistenceStatus}
          error={persistenceError}
          isInitialized={isFolderStoreInitialized}
          onRetryInitialization={retryInitialization}
          onRetryPersistence={retryPersistence}
        />
        <FileBrowser
          onItemContextMenu={handleItemContextMenu}
          onFolderContextMenu={handleFolderContextMenu}
          onEmptyAreaContextMenu={handleEmptyAreaContextMenu}
          onSelectionChange={handleSelectionChange}
          onCopy={handleCopy}
          onCut={handleCut}
          onDelete={handleDelete}
          onPaste={() => void handlePaste()}
          clipboard={clipboard}
          onEscape={handleEscape}
          renameItemRequestId={renameItemRequestId}
          onRenameItemRequestHandled={() => setRenameItemRequestId(null)}
          isCurrentFolderReadOnly={isCurrentFolderReadOnly}
        />
      </FileExplorerShell>
      <FileExplorerFAB
        onUploadFiles={handleUploadFiles}
        onUploadFolder={handleUploadFolder}
        onCreatePresentation={handleCreatePresentation}
        onAddLocalSyncFolder={
          canAddLocalSyncFolder ? () => void handleAddLocalSyncFolder() : undefined
        }
        onAddOneDrive={canAddOneDriveFolder ? () => void handleAddOneDrive() : undefined}
        onAddHhcLine={canAddSyncSourceHere ? handleOpenHhcLinePicker : undefined}
        isAddOneDriveDisabled={!hasOneDriveConnection}
        isAddHhcLineDisabled={!canAddHhcLineFolder}
        isReadOnly={isCurrentFolderReadOnly}
      />
      <CloudFolderPickerDialog
        provider={ONE_DRIVE_FOLDER_PICKER_PROVIDER}
        isOpen={isOneDrivePickerOpen}
        isImporting={isOneDriveImporting}
        onClose={() => setIsOneDrivePickerOpen(false)}
        onImport={(folder) => void handleImportOneDriveFolder(folder)}
      />
      <CloudFolderPickerDialog
        provider={hhcLinePickerProvider}
        isOpen={isHhcLinePickerOpen}
        isImporting={isHhcLineImporting}
        onClose={() => setIsHhcLinePickerOpen(false)}
        onImport={(folder) => void handleImportHhcLineFolder(folder)}
      />
      <FolderModal
        isOpen={isCreateFolderModalOpen}
        onClose={() => setIsCreateFolderModalOpen(false)}
        onSubmit={handleCreateFolderSubmit}
        editingFolder={null}
        folderName={createFolderName}
        onFolderNameChange={setCreateFolderName}
        folderDuration={createFolderDuration}
        onFolderDurationChange={setCreateFolderDuration}
        hideDuration={Boolean(foldersById[currentFolderId]?.personalOwnerId)}
      />
      <ShareFolderDialog
        folder={sharingFolder}
        auth={{
          getSession: () => session,
          getAccessToken,
          refreshAccessToken,
          getAuthGeneration,
          endSession
        }}
        onClose={() => setSharingFolder(null)}
      />
      <FolderModal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false)
          setEditingId(null)
        }}
        onSubmit={handleEditSubmit}
        editingFolder={editingId ? ({ id: editingId, name: editModalName } as FolderRecord) : null}
        folderName={editModalName}
        onFolderNameChange={setEditModalName}
        folderDuration={editModalDuration}
        onFolderDurationChange={setEditModalDuration}
        isRetentionLocked={editingIsFavorited}
        hideDuration={Boolean(editingId && foldersById[editingId]?.personalOwnerId)}
      />
      <Outlet />
    </>
  )
}
