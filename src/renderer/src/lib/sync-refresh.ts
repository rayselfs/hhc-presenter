import { isSameActiveSyncRoot } from './sync-refresh-lifetime'
import type {
  FileItemRecord,
  FolderRecord,
  SyncOfflinePolicy,
  SyncProviderType
} from '@shared/types/folder'
import { isValidNativeFileId } from '@shared/native-media'
import { mergePersistedSyncRefresh } from '@renderer/stores/file-explorer'
import { cleanupFileResources } from './file-resource-cleanup'
import {
  isFileBlobRecordAvailable,
  openFileExplorerDB,
  type FileBlobRecord
} from './file-explorer-db'
import type { MediaPlatform } from '@renderer/lib/media-capabilities'
import { classifyMediaImport } from '@renderer/lib/media-import-policy'
import { isIgnoredSystemPath } from '@shared/file-ignore-policy'
import type { ReadOnlySyncProvider, RemoteSyncItem } from './sync-provider'
import {
  getSyncEntryByRemoteItem,
  putSyncEntry,
  putSyncTombstone,
  type SyncEntryRecord,
  type SyncEntryStatus
} from './sync-db'

export interface SyncFileTransfer {
  itemId: string
  remoteItemId: string
  mimeType: string
}

export interface SyncRefreshPlan {
  folders: FolderRecord[]
  items: FileItemRecord[]
  syncEntries: Array<Omit<SyncEntryRecord, 'id' | 'createdAt' | 'updatedAt'>>
  fileTransfers: SyncFileTransfer[]
  removedFolderIds: string[]
  removedItemIds: string[]
  removedEntries: SyncEntryRecord[]
  disabledCount: number
}

interface BuildSyncRefreshPlanInput {
  providerConnectionId: string
  providerType: SyncProviderType
  rootFolder: FolderRecord
  rootRemoteFolderId: string
  offlinePolicy: SyncOfflinePolicy
  platform: MediaPlatform
  existingFolders: FolderRecord[]
  existingItems: FileItemRecord[]
  existingEntries: SyncEntryRecord[]
  existingBlobIds?: ReadonlySet<string>
  remoteItems: RemoteSyncItem[]
  forceRetry?: boolean
  now?: number
}

export interface SyncDeltaRefreshPlan extends SyncRefreshPlan {
  needsFullScan: boolean
}

const MAX_SYNC_CHANGE_PAGES = 1_000
const MAX_RESET_HANDOFF_ITEMS = 500

export async function collectSyncChangePages(
  provider: Pick<ReadOnlySyncProvider, 'initialScan' | 'incrementalChanges'>,
  providerConnectionId: string,
  remoteFolderId: string,
  cursor?: string
): Promise<{
  remoteItems: RemoteSyncItem[]
  nextCursor?: string
  usedCursor: boolean
  reset: boolean
}> {
  const seenCursors = new Set(cursor ? [cursor] : [])
  const firstPage = cursor
    ? await provider.incrementalChanges({
        providerConnectionId,
        remoteFolderId,
        cursor
      })
    : await provider.initialScan(providerConnectionId, remoteFolderId)
  const reset = Boolean(firstPage.reset)
  const remoteItems = [...firstPage.items]
  let page = firstPage
  let pageCount = 1
  let phase: 'reset' | 'delta' = reset ? 'reset' : 'delta'

  while (page.hasMore) {
    if (pageCount >= MAX_SYNC_CHANGE_PAGES) {
      throw new Error('Invalid sync change pagination')
    }
    const nextCursor = page.nextCursor
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error('Invalid sync change pagination')
    }
    seenCursors.add(nextCursor)
    page = await provider.incrementalChanges({
      providerConnectionId,
      remoteFolderId,
      cursor: nextCursor
    })
    const pageReset = Boolean(page.reset)
    if (phase === 'delta' && pageReset) {
      throw new Error('Invalid sync change pagination')
    }
    if (phase === 'reset' && !pageReset) phase = 'delta'
    if (reset && phase === 'delta' && page.items.length > MAX_RESET_HANDOFF_ITEMS) {
      throw new Error('Invalid sync change pagination')
    }
    remoteItems.push(...page.items)
    pageCount += 1
  }

  if (reset && phase !== 'delta') throw new Error('Invalid sync change pagination')

  return {
    remoteItems: reset
      ? [...new Map(remoteItems.map((item) => [item.remoteItemId, item])).values()]
      : remoteItems,
    nextCursor: page.nextCursor,
    usedCursor: Boolean(cursor) && !reset,
    reset
  }
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_')
}

function createFolderId(
  providerType: SyncProviderType,
  connectionId: string,
  remoteItemId: string
): string {
  const prefix = providerType === 'onedrive' ? 'onedrive' : 'local-sync'
  return `${prefix}-folder-${safeIdPart(connectionId)}-${safeIdPart(remoteItemId)}`
}

function createItemId(): string {
  return crypto.randomUUID()
}

function classifyRemoteFile(
  item: RemoteSyncItem,
  platform: MediaPlatform
): { mimeType: string; disabled: boolean; skip: boolean } {
  const decision = classifyMediaImport({ name: item.name, mimeType: item.mimeType }, platform)
  if (decision.action === 'skip') return { mimeType: decision.mimeType, disabled: true, skip: true }
  return {
    mimeType: decision.mimeType,
    disabled: decision.action === 'platform-unsupported',
    skip: false
  }
}

function contentChanged(
  existing: SyncEntryRecord | undefined,
  item: RemoteSyncItem,
  existingBlobIds?: ReadonlySet<string>
): boolean {
  if (!existing || item.kind !== 'file') return true
  if (item.etag && existing.etag && item.etag !== existing.etag) return true
  if (item.contentHash && existing.contentHash && item.contentHash !== existing.contentHash) {
    return true
  }
  if (
    typeof item.size === 'number' &&
    typeof existing.size === 'number' &&
    item.size !== existing.size
  ) {
    return true
  }
  if (
    existing.status === 'queued' ||
    existing.status === 'downloading' ||
    existing.status === 'failed' ||
    existing.status === 'outdated'
  ) {
    return true
  }
  if (!existing.blobId) return true
  return existingBlobIds ? !existingBlobIds.has(existing.blobId) : false
}

function nextStatus(
  disabled: boolean,
  offlinePolicy: SyncOfflinePolicy,
  shouldTransfer: boolean,
  preserveDownloaded: boolean
): SyncEntryStatus {
  if (disabled) return 'remote-only'
  if (preserveDownloaded) return 'available-offline'
  if (offlinePolicy === 'always-offline') return shouldTransfer ? 'queued' : 'available-offline'
  return 'remote-only'
}

function shouldHoldFailure(
  existing: SyncEntryRecord | undefined,
  forceRetry: boolean,
  now: number
): boolean {
  if (!existing || forceRetry) return false
  if (existing.status === 'insufficient-storage') return true
  if (existing.status !== 'failed') return false
  if (existing.errorKind === 'auth-required' || existing.errorKind === 'fatal') return true
  return typeof existing.nextRetryAt === 'number' && existing.nextRetryAt > now
}

function failureFields(existing: SyncEntryRecord | undefined): Partial<SyncEntryRecord> {
  if (!existing) return {}
  return {
    errorKind: existing.errorKind,
    retryCount: existing.retryCount,
    nextRetryAt: existing.nextRetryAt,
    lastError: existing.lastError
  }
}

function isPendingDownload(entry: SyncEntryRecord, forceRetry: boolean): boolean {
  if (entry.kind !== 'file') return false
  if (entry.status === 'queued' || entry.status === 'downloading' || entry.status === 'outdated') {
    return true
  }
  if (entry.status !== 'failed') return false
  if (entry.errorKind === 'auth-required' || entry.errorKind === 'fatal') return forceRetry
  return forceRetry || entry.errorKind === 'retryable' || entry.errorKind === 'offline'
}

function needsOfflinePolicyReconciliation(
  entry: SyncEntryRecord,
  offlinePolicy: SyncOfflinePolicy,
  platform: MediaPlatform
): boolean {
  if (
    offlinePolicy !== 'always-offline' ||
    entry.kind !== 'file' ||
    entry.status !== 'remote-only'
  ) {
    return false
  }
  return (
    classifyMediaImport({ name: entry.name, mimeType: entry.mimeType }, platform).action ===
    'accept'
  )
}

export function buildSyncRefreshPlan(input: BuildSyncRefreshPlanInput): SyncRefreshPlan {
  const now = input.now ?? Date.now()
  const forceRetry = input.forceRetry ?? false
  const existingByRemoteId = new Map(
    input.existingEntries.map((entry) => [entry.remoteItemId, entry])
  )
  const remoteIds = new Set<string>([input.rootRemoteFolderId])
  const remoteFolderToLocalId = new Map<string | null, string>([
    [null, input.rootFolder.id],
    [input.rootRemoteFolderId, input.rootFolder.id]
  ])
  const folderSortCounts = new Map<string, number>()
  const itemSortCounts = new Map<string, number>()
  const folders: FolderRecord[] = []
  const items: FileItemRecord[] = []
  const syncEntries: SyncRefreshPlan['syncEntries'] = []
  const fileTransfers: SyncFileTransfer[] = []
  const replacedItemIds: string[] = []
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
    if (remoteItem.deleted || remoteItem.kind !== 'folder') continue
    remoteIds.add(remoteItem.remoteItemId)
    if (remoteItem.remoteItemId === input.rootRemoteFolderId) continue
    const parentId = remoteFolderToLocalId.get(remoteItem.parentRemoteItemId) ?? input.rootFolder.id
    const existing = existingByRemoteId.get(remoteItem.remoteItemId)
    const folderId =
      existing?.folderId ??
      createFolderId(input.providerType, input.providerConnectionId, remoteItem.remoteItemId)
    const sortIndex = folderSortCounts.get(parentId) ?? 0
    folderSortCounts.set(parentId, sortIndex + 1)
    folders.push({
      id: folderId,
      name: remoteItem.name,
      parentId,
      sortIndex,
      createdAt:
        remoteItem.sourceCreatedAt ??
        input.existingFolders.find((folder) => folder.id === folderId)?.createdAt ??
        now,
      expiresAt: null,
      syncLink: {
        providerConnectionId: input.providerConnectionId,
        remoteFolderId: remoteItem.remoteItemId,
        providerType: input.providerType,
        offlinePolicy: input.offlinePolicy
      }
    })
    remoteFolderToLocalId.set(remoteItem.remoteItemId, folderId)
    syncEntries.push({
      providerConnectionId: input.providerConnectionId,
      remoteItemId: remoteItem.remoteItemId,
      parentRemoteItemId: remoteItem.parentRemoteItemId,
      kind: 'folder',
      name: remoteItem.name,
      folderId,
      status: input.offlinePolicy === 'always-offline' ? 'available-offline' : 'remote-only'
    })
  }

  for (const remoteItem of input.remoteItems) {
    if (ignoredRemoteIds.has(remoteItem.remoteItemId)) continue
    if (remoteItem.deleted || remoteItem.kind !== 'file') continue
    const policy = classifyRemoteFile(remoteItem, input.platform)
    if (policy.skip) continue
    remoteIds.add(remoteItem.remoteItemId)
    const parentId = remoteFolderToLocalId.get(remoteItem.parentRemoteItemId) ?? input.rootFolder.id
    const existing = existingByRemoteId.get(remoteItem.remoteItemId)
    const itemId =
      existing?.itemId && isValidNativeFileId(existing.itemId) ? existing.itemId : createItemId()
    if (existing?.itemId && existing.itemId !== itemId) replacedItemIds.push(existing.itemId)
    const sortIndex = itemSortCounts.get(parentId) ?? 0
    itemSortCounts.set(parentId, sortIndex + 1)
    const heldFailure = shouldHoldFailure(existing, forceRetry, now)
    const changed = contentChanged(existing, remoteItem, input.existingBlobIds)
    const shouldTransfer =
      !policy.disabled && input.offlinePolicy === 'always-offline' && !heldFailure && changed
    const preserveDownloaded =
      !changed && existing?.status === 'available-offline' && Boolean(existing.blobId)
    const status = heldFailure
      ? (existing?.status ?? 'failed')
      : nextStatus(policy.disabled, input.offlinePolicy, shouldTransfer, preserveDownloaded)
    const blobId = status === 'available-offline' ? (existing?.blobId ?? itemId) : undefined
    if (policy.disabled) disabledCount++
    items.push({
      id: itemId,
      parentId,
      type: 'file',
      sortIndex,
      createdAt:
        remoteItem.sourceCreatedAt ??
        input.existingItems.find((item) => item.id === itemId)?.createdAt ??
        now,
      expiresAt: null,
      name: remoteItem.name,
      url: policy.disabled ? `unsupported:${itemId}` : `blob:${itemId}`,
      size: remoteItem.size ?? 0,
      mimeType: policy.mimeType
    })
    if (shouldTransfer) {
      fileTransfers.push({
        itemId,
        remoteItemId: remoteItem.remoteItemId,
        mimeType: policy.mimeType
      })
    }
    syncEntries.push({
      providerConnectionId: input.providerConnectionId,
      remoteItemId: remoteItem.remoteItemId,
      parentRemoteItemId: remoteItem.parentRemoteItemId,
      kind: 'file',
      name: remoteItem.name,
      itemId,
      ...(blobId ? { blobId } : {}),
      mimeType: policy.mimeType,
      size: remoteItem.size,
      etag: remoteItem.etag,
      contentHash: remoteItem.contentHash,
      status,
      ...(heldFailure ? failureFields(existing) : {})
    })
  }

  const removedEntries = input.existingEntries.filter(
    (entry) =>
      entry.status !== 'deleted-pending-release' &&
      entry.remoteItemId !== input.rootRemoteFolderId &&
      !remoteIds.has(entry.remoteItemId)
  )

  return {
    folders,
    items,
    syncEntries,
    fileTransfers,
    removedFolderIds: removedEntries
      .filter((entry) => entry.kind === 'folder' && entry.folderId)
      .map((entry) => entry.folderId!),
    removedItemIds: [
      ...replacedItemIds,
      ...removedEntries
        .filter((entry) => entry.kind === 'file' && entry.itemId)
        .map((entry) => entry.itemId!)
    ],
    removedEntries,
    disabledCount
  }
}

export function buildSyncDeltaRefreshPlan(input: BuildSyncRefreshPlanInput): SyncDeltaRefreshPlan {
  const now = input.now ?? Date.now()
  const forceRetry = input.forceRetry ?? false
  const existingByRemoteId = new Map(
    input.existingEntries.map((entry) => [entry.remoteItemId, entry])
  )
  const remoteFolderToLocalId = new Map<string | null, string>([
    [null, input.rootFolder.id],
    [input.rootRemoteFolderId, input.rootFolder.id]
  ])
  for (const entry of input.existingEntries) {
    if (entry.kind === 'folder' && entry.folderId) {
      remoteFolderToLocalId.set(entry.remoteItemId, entry.folderId)
    }
  }

  const folderSortCounts = new Map<string, number>()
  const itemSortCounts = new Map<string, number>()
  for (const folder of input.existingFolders) {
    if (!folder.parentId) continue
    folderSortCounts.set(
      folder.parentId,
      Math.max(folderSortCounts.get(folder.parentId) ?? 0, folder.sortIndex + 1)
    )
  }
  for (const item of input.existingItems) {
    itemSortCounts.set(
      item.parentId,
      Math.max(itemSortCounts.get(item.parentId) ?? 0, item.sortIndex + 1)
    )
  }

  const folders: FolderRecord[] = []
  const items: FileItemRecord[] = []
  const syncEntries: SyncRefreshPlan['syncEntries'] = []
  const fileTransfers: SyncFileTransfer[] = []
  const replacedItemIds: string[] = []
  const removedEntryMap = new Map<string, SyncEntryRecord>()
  const ignoredRemoteIds = new Set<string>()
  let disabledCount = 0
  let needsFullScan = input.existingEntries.some(
    (entry) =>
      isPendingDownload(entry, forceRetry) ||
      needsOfflinePolicyReconciliation(entry, input.offlinePolicy, input.platform)
  )

  function addDeletedEntry(remoteItemId: string): void {
    const deletedRemoteIds = new Set([remoteItemId])
    let changed = true
    while (changed) {
      changed = false
      for (const entry of input.existingEntries) {
        if (
          entry.parentRemoteItemId &&
          deletedRemoteIds.has(entry.parentRemoteItemId) &&
          !deletedRemoteIds.has(entry.remoteItemId)
        ) {
          deletedRemoteIds.add(entry.remoteItemId)
          changed = true
        }
      }
    }
    for (const entry of input.existingEntries) {
      if (
        entry.remoteItemId !== input.rootRemoteFolderId &&
        entry.status !== 'deleted-pending-release' &&
        deletedRemoteIds.has(entry.remoteItemId)
      ) {
        removedEntryMap.set(entry.remoteItemId, entry)
      }
    }
  }

  for (const remoteItem of input.remoteItems) {
    if (
      isIgnoredSystemPath(remoteItem.name) ||
      (remoteItem.parentRemoteItemId && ignoredRemoteIds.has(remoteItem.parentRemoteItemId))
    ) {
      ignoredRemoteIds.add(remoteItem.remoteItemId)
      continue
    }
    if (remoteItem.deleted) {
      addDeletedEntry(remoteItem.remoteItemId)
      continue
    }
    if (remoteItem.kind !== 'folder' || remoteItem.remoteItemId === input.rootRemoteFolderId) {
      continue
    }
    const parentId = remoteFolderToLocalId.get(remoteItem.parentRemoteItemId)
    if (!parentId) {
      needsFullScan = true
      continue
    }
    const existing = existingByRemoteId.get(remoteItem.remoteItemId)
    const folderId =
      existing?.folderId ??
      createFolderId(input.providerType, input.providerConnectionId, remoteItem.remoteItemId)
    const existingFolder = input.existingFolders.find((folder) => folder.id === folderId)
    const sortIndex = existingFolder?.sortIndex ?? folderSortCounts.get(parentId) ?? 0
    folderSortCounts.set(parentId, Math.max(folderSortCounts.get(parentId) ?? 0, sortIndex + 1))
    folders.push({
      id: folderId,
      name: remoteItem.name,
      parentId,
      sortIndex,
      createdAt: remoteItem.sourceCreatedAt ?? existingFolder?.createdAt ?? now,
      expiresAt: null,
      syncLink: {
        providerConnectionId: input.providerConnectionId,
        remoteFolderId: remoteItem.remoteItemId,
        providerType: input.providerType,
        offlinePolicy: input.offlinePolicy
      }
    })
    remoteFolderToLocalId.set(remoteItem.remoteItemId, folderId)
    syncEntries.push({
      providerConnectionId: input.providerConnectionId,
      remoteItemId: remoteItem.remoteItemId,
      parentRemoteItemId: remoteItem.parentRemoteItemId,
      kind: 'folder',
      name: remoteItem.name,
      folderId,
      status: input.offlinePolicy === 'always-offline' ? 'available-offline' : 'remote-only'
    })
  }

  for (const remoteItem of input.remoteItems) {
    if (ignoredRemoteIds.has(remoteItem.remoteItemId) || remoteItem.deleted) continue
    if (remoteItem.kind !== 'file') continue
    const policy = classifyRemoteFile(remoteItem, input.platform)
    const existing = existingByRemoteId.get(remoteItem.remoteItemId)
    if (policy.skip) {
      if (existing) addDeletedEntry(remoteItem.remoteItemId)
      continue
    }
    const parentId = remoteFolderToLocalId.get(remoteItem.parentRemoteItemId)
    if (!parentId) {
      needsFullScan = true
      continue
    }
    const itemId =
      existing?.itemId && isValidNativeFileId(existing.itemId) ? existing.itemId : createItemId()
    if (existing?.itemId && existing.itemId !== itemId) replacedItemIds.push(existing.itemId)
    const existingItem = input.existingItems.find((item) => item.id === itemId)
    const sortIndex = existingItem?.sortIndex ?? itemSortCounts.get(parentId) ?? 0
    itemSortCounts.set(parentId, Math.max(itemSortCounts.get(parentId) ?? 0, sortIndex + 1))
    const heldFailure = shouldHoldFailure(existing, forceRetry, now)
    const changed = contentChanged(existing, remoteItem, input.existingBlobIds)
    const shouldTransfer =
      !policy.disabled && input.offlinePolicy === 'always-offline' && !heldFailure && changed
    const preserveDownloaded =
      !changed && existing?.status === 'available-offline' && Boolean(existing.blobId)
    const status = heldFailure
      ? (existing?.status ?? 'failed')
      : nextStatus(policy.disabled, input.offlinePolicy, shouldTransfer, preserveDownloaded)
    const blobId = status === 'available-offline' ? (existing?.blobId ?? itemId) : undefined
    if (policy.disabled) disabledCount++
    items.push({
      id: itemId,
      parentId,
      type: 'file',
      sortIndex,
      createdAt: remoteItem.sourceCreatedAt ?? existingItem?.createdAt ?? now,
      expiresAt: null,
      name: remoteItem.name,
      url: policy.disabled ? `unsupported:${itemId}` : `blob:${itemId}`,
      size: remoteItem.size ?? 0,
      mimeType: policy.mimeType
    })
    if (shouldTransfer) {
      fileTransfers.push({
        itemId,
        remoteItemId: remoteItem.remoteItemId,
        mimeType: policy.mimeType
      })
    }
    syncEntries.push({
      providerConnectionId: input.providerConnectionId,
      remoteItemId: remoteItem.remoteItemId,
      parentRemoteItemId: remoteItem.parentRemoteItemId,
      kind: 'file',
      name: remoteItem.name,
      itemId,
      ...(blobId ? { blobId } : {}),
      mimeType: policy.mimeType,
      size: remoteItem.size,
      etag: remoteItem.etag,
      contentHash: remoteItem.contentHash,
      status,
      ...(heldFailure ? failureFields(existing) : {})
    })
  }

  const removedEntries = [...removedEntryMap.values()]

  return {
    folders,
    items,
    syncEntries,
    fileTransfers,
    removedFolderIds: removedEntries
      .filter((entry) => entry.kind === 'folder' && entry.folderId)
      .map((entry) => entry.folderId!),
    removedItemIds: [
      ...replacedItemIds,
      ...removedEntries
        .filter((entry) => entry.kind === 'file' && entry.itemId)
        .map((entry) => entry.itemId!)
    ],
    removedEntries,
    disabledCount,
    needsFullScan
  }
}

export async function applySyncRefreshPlan(
  plan: SyncRefreshPlan,
  blobs: FileBlobRecord[] = [],
  expectedRoot?: FolderRecord
): Promise<void> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(['folder-records', 'folder-items', 'file-blobs'], 'readwrite')
  if (expectedRoot) {
    const current = await tx.objectStore('folder-records').get(expectedRoot.id)
    if (!isSameActiveSyncRoot(current, expectedRoot)) {
      await tx.done
      throw new Error('Sync refresh root was revoked')
    }
  }
  await Promise.all([
    ...plan.folders.map((folder) => tx.objectStore('folder-records').put(folder)),
    ...plan.items.map((item) => tx.objectStore('folder-items').put(item)),
    ...blobs.map((blob) => tx.objectStore('file-blobs').put(blob)),
    tx.done
  ])
  for (const entry of plan.syncEntries) {
    if (await isStalePendingEntry(db, entry)) continue
    await putSyncEntry(entry)
  }
  await Promise.all(
    plan.removedEntries.map(async (entry) => {
      await putSyncTombstone({
        providerConnectionId: entry.providerConnectionId,
        remoteItemId: entry.remoteItemId,
        itemId: entry.itemId,
        folderId: entry.folderId,
        blobId: entry.blobId,
        reason: 'remote-delete'
      })
      await putSyncEntry({
        providerConnectionId: entry.providerConnectionId,
        remoteItemId: entry.remoteItemId,
        parentRemoteItemId: entry.parentRemoteItemId,
        kind: entry.kind,
        name: entry.name,
        itemId: entry.itemId,
        folderId: entry.folderId,
        blobId: entry.blobId,
        mimeType: entry.mimeType,
        size: entry.size,
        etag: entry.etag,
        contentHash: entry.contentHash,
        status: 'deleted-pending-release'
      })
    })
  )
  await cleanupFileResources({
    folderIds: plan.removedFolderIds,
    itemIds: plan.removedItemIds
  })
  mergePersistedSyncRefresh(plan)
}

type PlannedSyncEntry = SyncRefreshPlan['syncEntries'][number]

function isPendingStatus(status: SyncEntryStatus): boolean {
  return status === 'queued' || status === 'downloading' || status === 'outdated'
}

function hasSameContentIdentity(current: SyncEntryRecord, planned: PlannedSyncEntry): boolean {
  if (current.etag && planned.etag && current.etag !== planned.etag) return false
  if (current.contentHash && planned.contentHash && current.contentHash !== planned.contentHash) {
    return false
  }
  if (
    typeof current.size === 'number' &&
    typeof planned.size === 'number' &&
    current.size !== planned.size
  ) {
    return false
  }
  return true
}

async function isStalePendingEntry(
  db: Awaited<ReturnType<typeof openFileExplorerDB>>,
  planned: PlannedSyncEntry
): Promise<boolean> {
  if (planned.kind !== 'file' || !isPendingStatus(planned.status)) return false
  const current = await getSyncEntryByRemoteItem(planned.providerConnectionId, planned.remoteItemId)
  if (
    current?.kind !== 'file' ||
    current.status !== 'available-offline' ||
    !current.blobId ||
    current.itemId !== planned.itemId ||
    !hasSameContentIdentity(current, planned)
  ) {
    return false
  }
  return isFileBlobRecordAvailable(await db.get('file-blobs', current.blobId))
}
