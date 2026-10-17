import type { FileItemRecord, SyncOfflinePolicy } from '@shared/types/folder'
import { enqueueSyncDownload } from './sync-download-queue'
import type { SyncEntryRecord } from './sync-db'
import type { ReadOnlySyncProvider, RemoteSyncItem, SyncDownloadCommitGuard } from './sync-provider'
import type { SyncFileTransfer, SyncRefreshPlan } from './sync-refresh'

export interface DispatchPlannedSyncDownloadsInput {
  provider: ReadOnlySyncProvider
  providerConnectionId: string
  rootRemoteFolderId: string
  offlinePolicy: SyncOfflinePolicy
  plan: Pick<SyncRefreshPlan, 'fileTransfers' | 'items'>
  remoteItems: RemoteSyncItem[]
  existingEntries: SyncEntryRecord[]
  withCommitLock?: (mutation: () => Promise<void>) => Promise<void>
  canCommit?: (transfer: SyncFileTransfer) => boolean | Promise<boolean>
  onFailed?: (error: unknown, transfer: SyncFileTransfer) => void | Promise<void>
  onDownloaded?: (item: FileItemRecord, canCommit: SyncDownloadCommitGuard) => void | Promise<void>
}

export function dispatchPlannedSyncDownloads(input: DispatchPlannedSyncDownloadsInput): void {
  const remoteById = new Map(input.remoteItems.map((item) => [item.remoteItemId, item]))
  const existingByRemoteId = new Map(
    input.existingEntries.map((entry) => [entry.remoteItemId, entry])
  )
  const itemById = new Map(input.plan.items.map((item) => [item.id, item]))

  for (const transfer of input.plan.fileTransfers) {
    const remoteItem = remoteById.get(transfer.remoteItemId)
    if (!remoteItem) continue
    const item = itemById.get(transfer.itemId)
    void enqueueSyncDownload({
      provider: input.provider,
      request: {
        providerConnectionId: input.providerConnectionId,
        rootRemoteFolderId: input.rootRemoteFolderId,
        remoteItemId: transfer.remoteItemId,
        targetBlobId: transfer.itemId,
        offlinePolicy: input.offlinePolicy
      },
      entry: {
        providerConnectionId: input.providerConnectionId,
        remoteItemId: transfer.remoteItemId,
        parentRemoteItemId: remoteItem.parentRemoteItemId,
        kind: 'file',
        name: remoteItem.name,
        itemId: transfer.itemId,
        mimeType: transfer.mimeType,
        size: remoteItem.size,
        etag: remoteItem.etag,
        contentHash: remoteItem.contentHash
      },
      previousEntry: existingByRemoteId.get(transfer.remoteItemId),
      priority: 'background',
      withCommitLock: input.withCommitLock,
      canCommit: input.canCommit ? () => input.canCommit!(transfer) : undefined,
      onFailed: input.onFailed ? (error) => input.onFailed!(error, transfer) : undefined,
      onDownloaded:
        input.onDownloaded && item
          ? (_result, guard) => input.onDownloaded!(item, guard)
          : undefined
    })
  }
}
