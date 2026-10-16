import { invalidateSyncRefresh, withSyncConnectionMutation } from './sync-refresh-lifetime'
import type { FolderRecord } from '@shared/types/folder'
import { isElectron } from './env'
import {
  cleanupFileResources,
  listFileResourceCleanupItemIds,
  type CleanupResult
} from './file-resource-cleanup'
import { openFileExplorerDB } from './file-explorer-db'
import { removeCleanedEntriesFromStore } from '@renderer/stores/file-explorer'
import { cancelSyncDownloadsAndWait } from './sync-download-queue'
import { cancelVideoPosterJobsAndWait, fenceVideoPosterScope } from './video-poster-jobs'
import {
  deleteProviderConnection,
  deleteSyncCursor,
  deleteSyncCursorsByProviderConnection,
  deleteSyncEntries,
  deleteSyncEntriesByProviderConnection,
  deleteSyncEntryPreferences,
  deleteSyncEntryPreferencesByProviderConnection,
  deleteSyncTombstones,
  listHhcLineProviderConnectionsByAccountUser,
  listSyncEntriesByProviderConnection,
  listSyncTombstones,
  putSyncTombstone,
  SYNC_CONNECTION_UNLINK_MARKER,
  type SyncEntryRecord,
  type SyncTombstoneRecord
} from './sync-db'

export interface UnlinkSyncConnectionResult extends CleanupResult {
  tombstoneCount: number
}

export interface ConvertSyncedFolderResult {
  folderIds: string[]
  itemIds: string[]
  removedSyncEntryCount: number
}

export interface SyncResourceRecoveryResult extends CleanupResult {
  tombstoneCount: number
}

function collectEntrySubtree(
  entries: SyncEntryRecord[],
  rootRemoteItemId: string
): SyncEntryRecord[] {
  const result = new Set<string>([rootRemoteItemId])
  let changed = true
  while (changed) {
    changed = false
    for (const entry of entries) {
      if (entry.parentRemoteItemId && result.has(entry.parentRemoteItemId)) {
        changed ||= !result.has(entry.remoteItemId)
        result.add(entry.remoteItemId)
      }
    }
  }
  return entries.filter((entry) => result.has(entry.remoteItemId))
}

async function listTombstonesForScope(
  providerConnectionId: string,
  remoteItemIds?: Set<string>
): Promise<SyncTombstoneRecord[]> {
  const tombstones = await listSyncTombstones()
  return tombstones.filter(
    (tombstone) =>
      tombstone.providerConnectionId === providerConnectionId &&
      (!remoteItemIds || remoteItemIds.has(tombstone.remoteItemId))
  )
}

async function cleanupSyncFileResources(
  input: {
    folderIds: string[]
    itemIds: string[]
  },
  extraCancellationItemIds: string[] = []
): Promise<CleanupResult> {
  const itemIds = [
    ...new Set([...(await listFileResourceCleanupItemIds(input)), ...extraCancellationItemIds])
  ]
  await cancelVideoPosterJobsAndWait(itemIds)
  return cleanupFileResources(input)
}

export async function unlinkSyncConnectionFromApp(
  providerConnectionId: string
): Promise<UnlinkSyncConnectionResult> {
  invalidateSyncRefresh(providerConnectionId)
  await cancelSyncDownloadsAndWait({ providerConnectionId })
  if (!providerConnectionId.startsWith('onedrive:'))
    return runSyncConnectionUnlink(providerConnectionId)
  return withSyncConnectionMutation(providerConnectionId, () =>
    runSyncConnectionUnlink(providerConnectionId)
  )
}

async function runSyncConnectionUnlink(
  providerConnectionId: string
): Promise<UnlinkSyncConnectionResult> {
  const releaseFence = fenceVideoPosterScope(providerConnectionId)
  try {
    const entries = await listSyncEntriesByProviderConnection(providerConnectionId)
    const linkedRoots = (await (await openFileExplorerDB()).getAll('folder-records')).filter(
      (folder) => folder.syncLink?.providerConnectionId === providerConnectionId
    )
    const folderIds = linkedRoots.map((folder) => folder.id)

    await Promise.all(
      [
        ...entries.map((entry) => ({
          providerConnectionId,
          remoteItemId: entry.remoteItemId,
          itemId: entry.itemId,
          blobId: entry.blobId,
          reason: 'unlink' as const
        })),
        ...linkedRoots.map((folder) => ({
          providerConnectionId,
          remoteItemId: folder.syncLink!.remoteFolderId,
          folderId: folder.id,
          unlinkScope: 'root' as const,
          reason: 'unlink' as const
        }))
      ].map((record) => putSyncTombstone(record))
    )
    await putSyncTombstone({
      providerConnectionId,
      remoteItemId: SYNC_CONNECTION_UNLINK_MARKER,
      unlinkScope: 'connection',
      reason: 'unlink'
    })

    const tombstones = await listTombstonesForScope(providerConnectionId)
    const cleanupResult = await cleanupSyncFileResources({
      folderIds: [
        ...folderIds,
        ...tombstones.flatMap((record) =>
          record.reason !== 'unlink' && record.folderId ? [record.folderId] : []
        )
      ],
      itemIds: tombstones.flatMap((record) =>
        record.reason !== 'unlink' && record.itemId ? [record.itemId] : []
      )
    })
    removeCleanedEntriesFromStore(cleanupResult)

    await deleteSyncEntryPreferencesByProviderConnection(providerConnectionId)
    await deleteSyncCursorsByProviderConnection(providerConnectionId)
    await deleteSyncEntriesByProviderConnection(providerConnectionId)
    await deleteProviderConnection(providerConnectionId)
    await deleteSyncTombstones(tombstones.map((record) => record.id))

    return {
      ...cleanupResult,
      tombstoneCount: entries.length
    }
  } finally {
    releaseFence()
  }
}

export async function unlinkSyncRootFolderFromApp(
  rootFolder: FolderRecord
): Promise<UnlinkSyncConnectionResult> {
  const syncLink = rootFolder.syncLink
  if (!syncLink) throw new Error('Folder is not a sync root')

  if (syncLink.providerType === 'local-fs') {
    const result = await unlinkSyncConnectionFromApp(syncLink.providerConnectionId)
    if (isElectron() && window.api?.localSync) {
      await window.api.localSync.disconnectFolder(syncLink.providerConnectionId)
    }
    return result
  }

  invalidateSyncRefresh(syncLink.providerConnectionId, rootFolder.id)
  await cancelSyncDownloadsAndWait({
    providerConnectionId: syncLink.providerConnectionId,
    rootRemoteFolderId: syncLink.remoteFolderId
  })
  if (syncLink.providerType !== 'onedrive') return runSyncRootUnlink(rootFolder)
  return withSyncConnectionMutation(syncLink.providerConnectionId, () =>
    runSyncRootUnlink(rootFolder)
  )
}

async function runSyncRootUnlink(rootFolder: FolderRecord): Promise<UnlinkSyncConnectionResult> {
  const syncLink = rootFolder.syncLink!
  const releaseFence = fenceVideoPosterScope(syncLink.providerConnectionId, syncLink.remoteFolderId)
  try {
    const entries = await listSyncEntriesByProviderConnection(syncLink.providerConnectionId)
    const targetEntries = collectEntrySubtree(entries, syncLink.remoteFolderId)

    await Promise.all(
      targetEntries.map((entry) =>
        putSyncTombstone({
          providerConnectionId: entry.providerConnectionId,
          remoteItemId: entry.remoteItemId,
          itemId: entry.itemId,
          blobId: entry.blobId,
          reason: 'unlink'
        })
      )
    )

    await putSyncTombstone({
      providerConnectionId: syncLink.providerConnectionId,
      remoteItemId: syncLink.remoteFolderId,
      folderId: rootFolder.id,
      unlinkScope: 'root',
      reason: 'unlink'
    })

    const tombstones = await listTombstonesForScope(
      syncLink.providerConnectionId,
      new Set([syncLink.remoteFolderId, ...targetEntries.map((entry) => entry.remoteItemId)])
    )
    const cleanupResult = await cleanupSyncFileResources({
      folderIds: [rootFolder.id],
      itemIds: []
    })
    removeCleanedEntriesFromStore(cleanupResult)
    await deleteSyncEntryPreferences(
      syncLink.providerConnectionId,
      targetEntries.map((entry) => entry.remoteItemId)
    )
    await deleteSyncCursor(syncLink.providerConnectionId, syncLink.remoteFolderId)
    await deleteSyncEntries(targetEntries.map((entry) => entry.id))
    await deleteSyncTombstones(tombstones.map((record) => record.id))

    return {
      ...cleanupResult,
      tombstoneCount: targetEntries.length
    }
  } finally {
    releaseFence()
  }
}

export async function unlinkHhcLineAccountFromApp(accountUserId: string): Promise<void> {
  const connections = await listHhcLineProviderConnectionsByAccountUser(accountUserId)
  for (const connection of connections) {
    await unlinkSyncConnectionFromApp(connection.id)
  }
}

export async function convertSyncConnectionToNormalFolder(
  providerConnectionId: string
): Promise<ConvertSyncedFolderResult> {
  const entries = await listSyncEntriesByProviderConnection(providerConnectionId)
  const unavailable = entries.filter(
    (entry) => entry.kind === 'file' && (entry.status !== 'available-offline' || !entry.blobId)
  )
  if (unavailable.length > 0) {
    throw new Error('Cannot keep synced files before every file is available offline')
  }

  const folderIds = entries.flatMap((entry) => (entry.folderId ? [entry.folderId] : []))
  const itemIds = entries.flatMap((entry) => (entry.itemId ? [entry.itemId] : []))
  const db = await openFileExplorerDB()
  const tx = db.transaction('folder-records', 'readwrite')
  await Promise.all(
    folderIds.map(async (folderId) => {
      const folder = await tx.store.get(folderId)
      if (!folder?.syncLink || folder.syncLink.providerConnectionId !== providerConnectionId) {
        return
      }
      const { syncLink: _syncLink, ...normalFolder } = folder
      await tx.store.put(normalFolder)
    })
  )
  await tx.done

  await Promise.all([
    deleteSyncEntriesByProviderConnection(providerConnectionId),
    deleteSyncEntryPreferencesByProviderConnection(providerConnectionId),
    deleteSyncCursorsByProviderConnection(providerConnectionId),
    deleteProviderConnection(providerConnectionId)
  ])

  return {
    folderIds,
    itemIds,
    removedSyncEntryCount: entries.length
  }
}

export async function recoverPendingSyncResourceCleanups(): Promise<SyncResourceRecoveryResult> {
  const tombstones = await listSyncTombstones()
  if (tombstones.length === 0) {
    return {
      folderIds: [],
      itemIds: [],
      tombstoneCount: 0
    }
  }

  const db = await openFileExplorerDB()
  const folders = new Map((await db.getAll('folder-records')).map((folder) => [folder.id, folder]))
  const folderIds = tombstones.flatMap((tombstone) => {
    if (!tombstone.folderId) return []
    if (tombstone.reason !== 'unlink') return [tombstone.folderId]
    if (tombstone.unlinkScope !== 'root') return []
    const folder = folders.get(tombstone.folderId)
    return folder?.syncLink?.providerConnectionId === tombstone.providerConnectionId &&
      folder.syncLink.remoteFolderId === tombstone.remoteItemId
      ? [tombstone.folderId]
      : []
  })
  const itemIds = tombstones.flatMap((tombstone) =>
    tombstone.reason !== 'unlink' && tombstone.itemId ? [tombstone.itemId] : []
  )
  const cancellationItemIds = tombstones.flatMap((tombstone) =>
    tombstone.itemId ? [tombstone.itemId] : []
  )
  const releaseFences = [
    ...new Set(tombstones.map((tombstone) => tombstone.providerConnectionId))
  ].map((providerConnectionId) => fenceVideoPosterScope(providerConnectionId))
  try {
    const cleanupResult =
      folderIds.length > 0 || itemIds.length > 0
        ? await cleanupSyncFileResources({ folderIds, itemIds }, cancellationItemIds)
        : { folderIds: [], itemIds: [] }
    removeCleanedEntriesFromStore(cleanupResult)

    await deleteSyncTombstones(tombstones.map((tombstone) => tombstone.id))

    return {
      ...cleanupResult,
      tombstoneCount: tombstones.length
    }
  } finally {
    releaseFences.forEach((release) => release())
  }
}
