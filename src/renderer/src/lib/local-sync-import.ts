import { refreshImportedMediaAssets } from './sync-media-preparation'
import type { LocalSyncConnectionInfo, LocalSyncRemoteItem } from '@shared/ipc-channels'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import {
  FILE_EXPLORER_ROOT_ID,
  useFileExplorerStore,
  mergePersistedSyncCatalog
} from '@renderer/stores/file-explorer'
import { isWeb } from '@renderer/lib/env'
import {
  collectAvailableFileBlobIds,
  openFileExplorerDB,
  type FileBlobRecord
} from '@renderer/lib/file-explorer-db'
import { resolveUniqueName } from '@renderer/lib/file-naming'
import type { MediaPlatform } from '@renderer/lib/media-capabilities'
import {
  listSyncEntriesByProviderConnection,
  putProviderConnection,
  putSyncEntry,
  type SyncEntryRecord
} from '@renderer/lib/sync-db'
import { applySyncRefreshPlan, buildSyncRefreshPlan, type SyncRefreshPlan } from './sync-refresh'

interface LocalSyncImportPlanInput {
  connection: LocalSyncConnectionInfo
  remoteItems: LocalSyncRemoteItem[]
  platform: MediaPlatform
  existingRootFolderNames: string[]
}

interface LocalSyncFileImport {
  itemId: string
  remoteItemId: string
  mimeType: string
}

interface LocalSyncImportPlan {
  rootFolder: FolderRecord
  folders: FolderRecord[]
  items: FileItemRecord[]
  fileImports: LocalSyncFileImport[]
  syncEntries: Array<Omit<SyncEntryRecord, 'id' | 'createdAt' | 'updatedAt'>>
  disabledCount: number
}

export interface LocalSyncImportSummary {
  connection: LocalSyncConnectionInfo
  rootFolderId: string
  folderCount: number
  itemCount: number
  importedFileCount: number
  disabledFileCount: number
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_')
}

function createRootFolderId(connectionId: string): string {
  return `local-sync-folder-${safeIdPart(connectionId)}`
}

export function buildLocalSyncImportPlan(input: LocalSyncImportPlanInput): LocalSyncImportPlan {
  const now = Date.now()
  const rootFolderId = createRootFolderId(input.connection.id)
  const rootFolder: FolderRecord = {
    id: rootFolderId,
    name: resolveUniqueName(input.connection.rootName, input.existingRootFolderNames),
    parentId: FILE_EXPLORER_ROOT_ID,
    sortIndex: input.existingRootFolderNames.length,
    createdAt: now,
    expiresAt: null,
    syncLink: {
      providerConnectionId: input.connection.id,
      remoteFolderId: '.',
      providerType: 'local-fs',
      offlinePolicy: 'always-offline'
    }
  }

  const plan = buildSyncRefreshPlan({
    providerConnectionId: input.connection.id,
    providerType: 'local-fs',
    rootFolder,
    rootRemoteFolderId: '.',
    offlinePolicy: 'always-offline',
    platform: input.platform,
    existingFolders: [],
    existingItems: [],
    existingEntries: [],
    remoteItems: input.remoteItems,
    now
  })
  return {
    rootFolder,
    folders: [rootFolder, ...plan.folders],
    items: plan.items,
    fileImports: plan.fileTransfers,
    syncEntries: [
      {
        providerConnectionId: input.connection.id,
        remoteItemId: '.',
        parentRemoteItemId: null,
        kind: 'folder',
        name: input.connection.rootName,
        folderId: rootFolder.id,
        status: 'available-offline'
      },
      ...plan.syncEntries.map((entry) => {
        if (entry.kind === 'folder') return entry
        const { contentHash: _contentHash, ...localEntry } = entry
        // Native copies complete before this initial plan is persisted.
        return entry.status === 'queued'
          ? { ...localEntry, blobId: entry.itemId, status: 'available-offline' as const }
          : localEntry
      })
    ],
    disabledCount: plan.disabledCount
  }
}

async function saveImportedRecords(
  plan: LocalSyncImportPlan,
  blobs: FileBlobRecord[]
): Promise<void> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(['folder-records', 'folder-items', 'file-blobs'], 'readwrite')
  await Promise.all([
    ...plan.folders.map((folder) => tx.objectStore('folder-records').put(folder)),
    ...plan.items.map((item) => tx.objectStore('folder-items').put(item)),
    ...blobs.map((blob) => tx.objectStore('file-blobs').put(blob)),
    tx.done
  ])
}

export async function importLocalSyncConnection(
  connection: LocalSyncConnectionInfo,
  remoteItems: LocalSyncRemoteItem[],
  platform: MediaPlatform
): Promise<LocalSyncImportSummary> {
  const store = useFileExplorerStore.getState()
  await store.initialize()
  const existingRootFolderNames = store
    .getChildFolders(FILE_EXPLORER_ROOT_ID)
    .map((folder) => folder.name)
  const plan = buildLocalSyncImportPlan({
    connection,
    remoteItems,
    platform,
    existingRootFolderNames
  })
  const blobs: FileBlobRecord[] = []
  const copiedIds: string[] = []
  const failedImportIds = new Set<string>()

  for (const fileImport of plan.fileImports) {
    try {
      const result = await window.api.localSync.importFile({
        connectionId: connection.id,
        remoteItemId: fileImport.remoteItemId,
        targetFileId: fileImport.itemId
      })
      copiedIds.push(fileImport.itemId)
      blobs.push({
        id: fileImport.itemId,
        storage: 'native-fs',
        size: result.size,
        refCount: 1
      })
    } catch (error) {
      failedImportIds.add(fileImport.itemId)
      console.warn('[local-sync] Failed to import synced file', {
        connectionId: connection.id,
        remoteItemId: fileImport.remoteItemId,
        error
      })
    }
  }

  const savedPlan: LocalSyncImportPlan = {
    ...plan,
    items: plan.items.filter((item) => !failedImportIds.has(item.id)),
    fileImports: plan.fileImports.filter((item) => !failedImportIds.has(item.itemId)),
    syncEntries: plan.syncEntries.filter(
      (entry) => !entry.itemId || !failedImportIds.has(entry.itemId)
    )
  }

  try {
    await saveImportedRecords(savedPlan, blobs)
  } catch (error) {
    await Promise.all(copiedIds.map((id) => window.api.nativeFs.delete(id).catch(() => undefined)))
    throw error
  }

  await putProviderConnection({
    id: connection.id,
    providerType: 'local-fs',
    displayName: connection.displayName
  })
  await Promise.all(savedPlan.syncEntries.map((entry) => putSyncEntry(entry)))
  mergePersistedSyncCatalog(savedPlan.folders, savedPlan.items)
  void refreshImportedMediaAssets(savedPlan.items)

  return {
    connection,
    rootFolderId: savedPlan.rootFolder.id,
    folderCount: savedPlan.folders.length,
    itemCount: savedPlan.items.length,
    importedFileCount: savedPlan.fileImports.length,
    disabledFileCount: savedPlan.disabledCount
  }
}

export async function connectLocalSyncFolder(): Promise<LocalSyncImportSummary | null> {
  if (isWeb()) throw new Error('Local sync folders are only available in Electron')
  const connection = await window.api.localSync.selectFolder()
  if (!connection) return null
  const remoteItems = await window.api.localSync.scanFolder(connection.id)
  const summary = await importLocalSyncConnection(connection, remoteItems, 'electron')
  await window.api.localSync.startWatch(connection.id).catch(() => undefined)
  return summary
}

export interface LocalSyncRefreshSummary {
  connection: LocalSyncConnectionInfo
  updatedItemCount: number
  removedItemCount: number
  removedFolderCount: number
  failedFileCount: number
  disabledFileCount: number
}

function markTransferStatus(
  plan: SyncRefreshPlan,
  remoteItemId: string,
  status: 'available-offline' | 'failed'
): void {
  const entry = plan.syncEntries.find((candidate) => candidate.remoteItemId === remoteItemId)
  if (!entry || entry.kind !== 'file') return
  entry.status = status
  if (status === 'available-offline' && entry.itemId) {
    entry.blobId = entry.itemId
  } else {
    delete entry.blobId
  }
}

export async function refreshLocalSyncConnection(
  connectionId: string
): Promise<LocalSyncRefreshSummary> {
  if (isWeb()) throw new Error('Local sync folders are only available in Electron')
  const connection = (await window.api.localSync.listFolders()).find(
    (item) => item.id === connectionId
  )
  if (!connection) throw new Error('Local sync connection not found')

  const store = useFileExplorerStore.getState()
  await store.initialize()
  const db = await openFileExplorerDB()
  const [folders, allItems, existingEntries, remoteItems, fileBlobs] = await Promise.all([
    db.getAll('folder-records'),
    db.getAll('folder-items'),
    listSyncEntriesByProviderConnection(connection.id),
    window.api.localSync.scanFolder(connection.id),
    db.getAll('file-blobs')
  ])
  const rootFolder = folders.find(
    (folder) =>
      folder.syncLink?.providerConnectionId === connection.id &&
      folder.syncLink.remoteFolderId === '.'
  )
  if (!rootFolder) throw new Error('Local sync root folder not found')

  const plan = buildSyncRefreshPlan({
    providerConnectionId: connection.id,
    providerType: 'local-fs',
    rootFolder,
    rootRemoteFolderId: '.',
    offlinePolicy: 'always-offline',
    platform: 'electron',
    existingFolders: folders,
    existingItems: allItems.filter((item): item is FileItemRecord => item.type === 'file'),
    existingEntries,
    existingBlobIds: await collectAvailableFileBlobIds(fileBlobs),
    remoteItems: remoteItems.map((item) => ({
      remoteItemId: item.remoteItemId,
      parentRemoteItemId: item.parentRemoteItemId,
      kind: item.kind,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      etag: item.etag,
      sourceCreatedAt: item.sourceCreatedAt
    }))
  })

  const blobs: FileBlobRecord[] = []
  let failedFileCount = 0
  for (const fileTransfer of plan.fileTransfers) {
    try {
      const result = await window.api.localSync.importFile({
        connectionId: connection.id,
        remoteItemId: fileTransfer.remoteItemId,
        targetFileId: fileTransfer.itemId
      })
      blobs.push({
        id: fileTransfer.itemId,
        storage: 'native-fs',
        size: result.size,
        refCount: 1
      })
      markTransferStatus(plan, fileTransfer.remoteItemId, 'available-offline')
    } catch (error) {
      failedFileCount++
      markTransferStatus(plan, fileTransfer.remoteItemId, 'failed')
      console.warn('[local-sync] Failed to refresh synced file', {
        connectionId: connection.id,
        remoteItemId: fileTransfer.remoteItemId,
        error
      })
    }
  }

  await applySyncRefreshPlan(plan, blobs)
  void refreshImportedMediaAssets(
    plan.items.filter((item) => blobs.some((blob) => blob.id === item.id))
  )

  return {
    connection,
    updatedItemCount: plan.items.length,
    removedItemCount: plan.removedItemIds.length,
    removedFolderCount: plan.removedFolderIds.length,
    failedFileCount,
    disabledFileCount: plan.disabledCount
  }
}
