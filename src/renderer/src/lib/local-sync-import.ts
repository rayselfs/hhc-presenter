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
  getFileSource,
  openFileExplorerDB,
  type FileBlobRecord
} from '@renderer/lib/file-explorer-db'
import { resolveUniqueName } from '@renderer/lib/file-naming'
import {
  resolveMediaCapability,
  type MediaKind,
  type MediaPlatform,
  type MediaSupportMode
} from '@renderer/lib/media-capabilities'
import { classifyMediaImport } from '@renderer/lib/media-import-policy'
import { isIgnoredSystemPath } from '@shared/file-ignore-policy'
import { ensureSourceMediaMetadata } from '@renderer/lib/media-metadata'
import { enqueueVideoPosterJob } from '@renderer/lib/video-poster-jobs'
import { getBlobId } from '@renderer/lib/blob-identity'
import { getDerivedAsset } from '@renderer/lib/media-work-db'
import {
  listSyncEntriesByProviderConnection,
  putProviderConnection,
  putSyncEntry,
  type SyncEntryRecord
} from '@renderer/lib/sync-db'
import { generateThumbnail } from '@renderer/lib/thumbnail-generator'
import { saveThumbnail, saveThumbnailBlob } from '@renderer/lib/thumbnail-db'
import type { SyncDownloadCommitGuard } from '@renderer/lib/sync-provider'
import { applySyncRefreshPlan, buildSyncRefreshPlan, type SyncRefreshPlan } from './sync-refresh'

interface SyncFilePolicy {
  kind: MediaKind | 'unsupported'
  mimeType: string
  support: MediaSupportMode
  disabled: boolean
  skip: boolean
}

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

function createSyncedFolderId(connectionId: string, remoteItemId: string): string {
  return `local-sync-folder-${safeIdPart(connectionId)}-${safeIdPart(remoteItemId)}`
}

function createSyncedItemId(): string {
  return crypto.randomUUID()
}

export function classifySyncRemoteFile(
  item: Pick<LocalSyncRemoteItem, 'name' | 'mimeType'>,
  platform: MediaPlatform
): SyncFilePolicy {
  const decision = classifyMediaImport({ name: item.name, mimeType: item.mimeType }, platform)
  if (decision.action === 'skip') {
    return {
      kind: 'unsupported',
      mimeType: decision.mimeType,
      support: 'unsupported',
      disabled: true,
      skip: true
    }
  }

  if (decision.action === 'platform-unsupported') {
    return {
      kind: decision.kind,
      mimeType: decision.mimeType,
      support: decision.support,
      disabled: true,
      skip: false
    }
  }

  return {
    kind: decision.kind,
    mimeType: decision.mimeType,
    support: decision.support,
    disabled: false,
    skip: false
  }
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

  const folders: FolderRecord[] = [rootFolder]
  const items: FileItemRecord[] = []
  const fileImports: LocalSyncFileImport[] = []
  const syncEntries: LocalSyncImportPlan['syncEntries'] = [
    {
      providerConnectionId: input.connection.id,
      remoteItemId: '.',
      parentRemoteItemId: null,
      kind: 'folder',
      name: input.connection.rootName,
      folderId: rootFolder.id,
      status: 'available-offline'
    }
  ]
  const remoteFolderToLocalId = new Map<string | null, string>([[null, rootFolderId]])
  const folderSortCounts = new Map<string, number>([
    [FILE_EXPLORER_ROOT_ID, input.existingRootFolderNames.length + 1]
  ])
  const itemSortCounts = new Map<string, number>()
  const ignoredRemoteIds = new Set<string>()
  let disabledCount = 0

  for (const remoteItem of input.remoteItems) {
    if (
      isIgnoredSystemPath(remoteItem.name) ||
      (remoteItem.parentRemoteItemId && ignoredRemoteIds.has(remoteItem.parentRemoteItemId))
    ) {
      ignoredRemoteIds.add(remoteItem.remoteItemId)
      continue
    }
    if (remoteItem.kind !== 'folder') continue
    const parentId = remoteFolderToLocalId.get(remoteItem.parentRemoteItemId) ?? rootFolderId
    const localFolderId = createSyncedFolderId(input.connection.id, remoteItem.remoteItemId)
    const sortIndex = folderSortCounts.get(parentId) ?? 0
    folderSortCounts.set(parentId, sortIndex + 1)
    const folder: FolderRecord = {
      id: localFolderId,
      name: remoteItem.name,
      parentId,
      sortIndex,
      createdAt: remoteItem.sourceCreatedAt ?? now,
      expiresAt: null,
      syncLink: {
        providerConnectionId: input.connection.id,
        remoteFolderId: remoteItem.remoteItemId,
        providerType: 'local-fs',
        offlinePolicy: 'always-offline'
      }
    }
    folders.push(folder)
    remoteFolderToLocalId.set(remoteItem.remoteItemId, localFolderId)
    syncEntries.push({
      providerConnectionId: input.connection.id,
      remoteItemId: remoteItem.remoteItemId,
      parentRemoteItemId: remoteItem.parentRemoteItemId,
      kind: 'folder',
      name: remoteItem.name,
      folderId: localFolderId,
      status: 'available-offline'
    })
  }

  for (const remoteItem of input.remoteItems) {
    if (ignoredRemoteIds.has(remoteItem.remoteItemId)) continue
    if (remoteItem.kind !== 'file') continue
    const parentId = remoteFolderToLocalId.get(remoteItem.parentRemoteItemId) ?? rootFolderId
    const policy = classifySyncRemoteFile(remoteItem, input.platform)
    if (policy.skip) continue
    const itemId = createSyncedItemId()
    const sortIndex = itemSortCounts.get(parentId) ?? 0
    itemSortCounts.set(parentId, sortIndex + 1)
    const item: FileItemRecord = {
      id: itemId,
      parentId,
      type: 'file',
      sortIndex,
      createdAt: remoteItem.sourceCreatedAt ?? now,
      expiresAt: null,
      name: remoteItem.name,
      url: policy.disabled ? `unsupported:${itemId}` : `blob:${itemId}`,
      size: remoteItem.size ?? 0,
      mimeType: policy.mimeType
    }
    items.push(item)
    if (policy.disabled) {
      disabledCount++
      syncEntries.push({
        providerConnectionId: input.connection.id,
        remoteItemId: remoteItem.remoteItemId,
        parentRemoteItemId: remoteItem.parentRemoteItemId,
        kind: 'file',
        name: remoteItem.name,
        itemId,
        mimeType: policy.mimeType,
        size: remoteItem.size,
        etag: remoteItem.etag,
        status: 'remote-only'
      })
      continue
    }
    fileImports.push({ itemId, remoteItemId: remoteItem.remoteItemId, mimeType: policy.mimeType })
    syncEntries.push({
      providerConnectionId: input.connection.id,
      remoteItemId: remoteItem.remoteItemId,
      parentRemoteItemId: remoteItem.parentRemoteItemId,
      kind: 'file',
      name: remoteItem.name,
      itemId,
      blobId: itemId,
      mimeType: policy.mimeType,
      size: remoteItem.size,
      etag: remoteItem.etag,
      status: 'available-offline'
    })
  }

  return { rootFolder, folders, items, fileImports, syncEntries, disabledCount }
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

let activeImportedMediaPreparations = 0
const pendingImportedMediaPreparations: Array<() => void> = []

async function acquireImportedMediaPreparationSlot(): Promise<void> {
  if (activeImportedMediaPreparations < 3) {
    activeImportedMediaPreparations += 1
    return
  }
  await new Promise<void>((resolve) => pendingImportedMediaPreparations.push(resolve))
}

function releaseImportedMediaPreparationSlot(): void {
  const next = pendingImportedMediaPreparations.shift()
  if (next) next()
  else activeImportedMediaPreparations -= 1
}

export async function refreshImportedMediaAssets(
  items: FileItemRecord[],
  guard?: SyncDownloadCommitGuard
): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      await acquireImportedMediaPreparationSlot()
      try {
        if (!item.url.startsWith('blob:')) return
        const blobId = getBlobId(item)
        const capability = resolveMediaCapability({ mimeType: item.mimeType, fileName: item.name })
        if (!capability) return
        await ensureSourceMediaMetadata(blobId, item.mimeType, guard).catch((error) => {
          console.warn('[sync] Failed to store synced media metadata', {
            itemId: item.id,
            error
          })
        })
        const existingCover = await getDerivedAsset(blobId, 'cover-thumbnail')
        if (existingCover?.status === 'ready') return
        if (capability.kind === 'video' && !isWeb()) {
          await enqueueVideoPosterJob({ sourceBlobId: blobId, itemId: item.id, canCommit: guard })
          return
        }
        if (capability.thumbnail === 'none') return

        const db = await openFileExplorerDB()
        const source = await getFileSource(db, blobId, item.mimeType)
        if (!source) return
        try {
          const response = await fetch(source.url)
          if (!response.ok) return
          const file = new File([await response.blob()], item.name, { type: item.mimeType })
          const thumbnail = await generateThumbnail(file, item.mimeType)
          if (!thumbnail) return
          if ((await guard?.()) === false) return
          if (typeof thumbnail === 'string') await saveThumbnail(blobId, thumbnail)
          else await saveThumbnailBlob(blobId, thumbnail)
          if ((await guard?.()) === false) return
          const dataUrl = typeof thumbnail === 'string' ? thumbnail : URL.createObjectURL(thumbnail)
          window.dispatchEvent(
            new CustomEvent('hhc:thumbnail-ready', {
              detail: { itemId: item.id, dataUrl }
            })
          )
        } finally {
          source.revoke()
        }
      } catch (error) {
        console.warn('[sync] Failed to refresh synced media asset', {
          itemId: item.id,
          error
        })
      } finally {
        releaseImportedMediaPreparationSlot()
      }
    })
  )
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
