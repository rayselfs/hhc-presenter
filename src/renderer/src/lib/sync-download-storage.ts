import { pendingHhcSyncReceipt } from './hhc-sync-receipts'
import { toast } from '@heroui/react/toast'
import i18n from '@renderer/i18n'
import { SyncDownloadCancelledError } from './sync-provider'
import type {
  RemoteSyncItem,
  SyncDownloadCommitGuard,
  SyncDownloadRequest,
  SyncDownloadResult
} from './sync-provider'
import { openFileExplorerDB } from './file-explorer-db'
import { isElectron } from './env'
import { MAX_FILE_SIZE_WEB } from './media-limits'
import { deleteSyncEntries, putSyncEntry, updateSyncDownloadProgress } from './sync-db'
import { dispatchRecoverySourceChanged } from './recovery-source-events'

const STORAGE_USAGE_LIMIT_RATIO = 0.8
const STORAGE_LIMIT_ERROR = 'OneDrive sync storage has reached 80% usage'
const HHC_MAX_FILE_SIZE_WEB = 256 * 1024 * 1024
const alwaysCanCommit: SyncDownloadCommitGuard = () => true

class SyncStorageLimitError extends Error {
  constructor() {
    super(STORAGE_LIMIT_ERROR)
  }
}

async function ensureCanCommit(canCommit: SyncDownloadCommitGuard): Promise<void> {
  if (!(await canCommit())) throw new SyncDownloadCancelledError()
}

async function ensureWebCapacity(
  size: number,
  maxFileSize = MAX_FILE_SIZE_WEB,
  sizeError = 'OneDrive file exceeds the Web 2GB limit'
): Promise<void> {
  if (size > maxFileSize) {
    throw new Error(sizeError)
  }
  if (!navigator.storage?.estimate) return
  const { quota, usage } = await navigator.storage.estimate()
  if (quota === undefined) return
  const currentUsage = usage ?? 0
  const usageLimit = quota * STORAGE_USAGE_LIMIT_RATIO
  const exceedsCurrentLimit = currentUsage >= usageLimit
  const exceedsProjectedLimit = currentUsage + size > usageLimit
  if (quota > 0 && (exceedsCurrentLimit || exceedsProjectedLimit)) {
    throw new SyncStorageLimitError()
  }
}

export function isSyncStorageLimitError(error: unknown): boolean {
  return (
    error instanceof SyncStorageLimitError ||
    (error instanceof Error && error.message === STORAGE_LIMIT_ERROR)
  )
}

async function markInsufficientStorage(
  request: SyncDownloadRequest,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard
): Promise<void> {
  if (!(await canCommit())) return
  const entry = await putSyncEntry({
    providerConnectionId: request.providerConnectionId,
    remoteItemId: request.remoteItemId,
    parentRemoteItemId: metadata.parentRemoteItemId,
    kind: metadata.kind,
    name: metadata.name,
    itemId: request.targetBlobId,
    mimeType: metadata.mimeType,
    size: metadata.size,
    etag: metadata.etag,
    contentHash: metadata.contentHash,
    status: 'insufficient-storage'
  })
  if (!(await canCommit())) {
    await deleteSyncEntries([entry.id])
    return
  }
  toast.danger(i18n.t('toast.syncStorageLimitReached'))
}

async function readResponseBlobWithProgress(
  request: SyncDownloadRequest,
  response: Response,
  metadata: RemoteSyncItem,
  totalBytes: number,
  canCommit: SyncDownloadCommitGuard,
  maxFileSize: number,
  sizeError: string
): Promise<Blob> {
  if (!response.body) return response.blob()
  const reader = response.body.getReader()
  const chunks: BlobPart[] = []
  let downloadedBytes = 0
  await updateSyncDownloadProgress(
    { providerConnectionId: request.providerConnectionId, remoteItemId: request.remoteItemId },
    0,
    totalBytes || metadata.size,
    canCommit
  )
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    downloadedBytes += value.byteLength
    try {
      await ensureWebCapacity(downloadedBytes, maxFileSize, sizeError)
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    }
    chunks.push(value.slice())
    await updateSyncDownloadProgress(
      { providerConnectionId: request.providerConnectionId, remoteItemId: request.remoteItemId },
      downloadedBytes,
      totalBytes || metadata.size,
      canCommit
    )
  }
  return new Blob(chunks, {
    type: metadata.mimeType ?? response.headers.get('Content-Type') ?? undefined
  })
}

export async function saveWebOneDriveDownloadedContent(
  request: SyncDownloadRequest,
  response: Response,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard = alwaysCanCommit
): Promise<SyncDownloadResult> {
  return saveWebDownloadedContent(request, response, metadata, canCommit)
}

export async function saveWebHhcDownloadedContent(
  request: SyncDownloadRequest,
  response: Response,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard = alwaysCanCommit
): Promise<SyncDownloadResult> {
  return saveWebDownloadedContent(request, response, metadata, canCommit, HHC_MAX_FILE_SIZE_WEB)
}

export async function saveWebSharedDownloadedContent(
  request: SyncDownloadRequest,
  response: Response,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard = alwaysCanCommit
): Promise<SyncDownloadResult> {
  return saveWebDownloadedContent(
    request,
    response,
    metadata,
    canCommit,
    HHC_MAX_FILE_SIZE_WEB,
    false
  )
}

async function saveWebDownloadedContent(
  request: SyncDownloadRequest,
  response: Response,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard,
  maxFileSize = MAX_FILE_SIZE_WEB,
  recordHhcReceipt = maxFileSize === HHC_MAX_FILE_SIZE_WEB
): Promise<SyncDownloadResult> {
  if (isElectron()) {
    throw new Error('Electron OneDrive downloads must use native streaming storage')
  }

  const contentLength = Number(response.headers.get('Content-Length') ?? metadata.size ?? 0)
  const size = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0
  try {
    const sizeError =
      maxFileSize === HHC_MAX_FILE_SIZE_WEB
        ? 'HHC file exceeds the Web 256MiB limit'
        : 'OneDrive file exceeds the Web 2GB limit'
    await ensureWebCapacity(size, maxFileSize, sizeError)

    const blob = await readResponseBlobWithProgress(
      request,
      response,
      metadata,
      size,
      canCommit,
      maxFileSize,
      sizeError
    )
    await ensureWebCapacity(blob.size, maxFileSize, sizeError)

    const db = await openFileExplorerDB()
    let syncEntryId: string | undefined
    try {
      await ensureCanCommit(canCommit)
      await db.put('file-blobs', {
        id: request.targetBlobId,
        blob,
        storage: 'indexed-db',
        size: blob.size,
        refCount: 1
      })
      await ensureCanCommit(canCommit)
      const syncEntry = await putSyncEntry({
        providerConnectionId: request.providerConnectionId,
        remoteItemId: request.remoteItemId,
        parentRemoteItemId: metadata.parentRemoteItemId,
        kind: metadata.kind,
        name: metadata.name,
        itemId: request.targetBlobId,
        blobId: request.targetBlobId,
        mimeType: metadata.mimeType,
        size: blob.size,
        etag: metadata.etag,
        contentHash: metadata.contentHash,
        status: 'available-offline',
        syncReceipt: recordHhcReceipt ? pendingHhcSyncReceipt(request, metadata) : undefined,
        downloadedBytes: blob.size,
        downloadTotalBytes: blob.size
      })
      syncEntryId = syncEntry.id
      await ensureCanCommit(canCommit)
    } catch (error) {
      if (error instanceof SyncDownloadCancelledError) {
        const cleanup = await Promise.allSettled([
          syncEntryId
            ? deleteSyncEntries([syncEntryId], { notifyRecovery: false })
            : Promise.resolve(),
          db.delete('file-blobs', request.targetBlobId)
        ])
        dispatchRecoverySourceChanged()
        const cleanupFailure = cleanup.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )
        if (cleanupFailure) throw cleanupFailure.reason
      }
      throw error
    }

    return {
      blobId: request.targetBlobId,
      size: blob.size,
      mimeType: metadata.mimeType ?? blob.type
    }
  } catch (error) {
    if (isSyncStorageLimitError(error)) await markInsufficientStorage(request, metadata, canCommit)
    throw error
  }
}

export async function saveElectronOneDriveDownloadedContent(
  request: SyncDownloadRequest,
  clientId: string,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard = alwaysCanCommit
): Promise<SyncDownloadResult> {
  if (!isElectron()) {
    throw new Error('Native OneDrive downloads are only available in Electron')
  }

  let downloaded: Awaited<ReturnType<typeof window.api.oneDrive.downloadFile>>
  try {
    const token = await window.api.oneDrive.getAccessToken({
      connectionId: request.providerConnectionId,
      clientId
    })
    const unsubscribe = window.api.oneDrive.onDownloadProgress((progress) => {
      if (progress.targetFileId !== request.targetBlobId) return
      void updateSyncDownloadProgress(
        {
          providerConnectionId: request.providerConnectionId,
          remoteItemId: request.remoteItemId
        },
        progress.downloadedBytes,
        progress.downloadTotalBytes,
        canCommit
      )
    })
    try {
      downloaded = await window.api.oneDrive.downloadFile({
        remoteItemId: request.remoteItemId,
        targetFileId: request.targetBlobId,
        accessToken: token.accessToken,
        expectedSize: metadata.size,
        mimeType: metadata.mimeType
      })
    } finally {
      unsubscribe()
    }
  } catch (error) {
    if (isSyncStorageLimitError(error)) await markInsufficientStorage(request, metadata, canCommit)
    throw error
  }
  const db = await openFileExplorerDB()
  let syncEntryId: string | undefined
  try {
    await ensureCanCommit(canCommit)
    await db.put('file-blobs', {
      id: request.targetBlobId,
      storage: 'native-fs',
      size: downloaded.size,
      refCount: 1
    })
    await ensureCanCommit(canCommit)
    const syncEntry = await putSyncEntry({
      providerConnectionId: request.providerConnectionId,
      remoteItemId: request.remoteItemId,
      parentRemoteItemId: metadata.parentRemoteItemId,
      kind: metadata.kind,
      name: metadata.name,
      itemId: request.targetBlobId,
      blobId: request.targetBlobId,
      mimeType: metadata.mimeType ?? downloaded.mimeType,
      size: downloaded.size,
      etag: metadata.etag,
      contentHash: metadata.contentHash,
      status: 'available-offline',
      downloadedBytes: downloaded.size,
      downloadTotalBytes: downloaded.size
    })
    syncEntryId = syncEntry.id
    await ensureCanCommit(canCommit)
  } catch (error) {
    const cleanup = await Promise.allSettled([
      error instanceof SyncDownloadCancelledError && syncEntryId
        ? deleteSyncEntries([syncEntryId], { notifyRecovery: false })
        : Promise.resolve(),
      db.delete('file-blobs', request.targetBlobId),
      window.api.nativeFs.delete(request.targetBlobId)
    ])
    if (error instanceof SyncDownloadCancelledError) {
      dispatchRecoverySourceChanged()
    }
    const cleanupFailure = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (cleanupFailure) throw cleanupFailure.reason
    throw error
  }

  return {
    blobId: request.targetBlobId,
    size: downloaded.size,
    mimeType: metadata.mimeType ?? downloaded.mimeType ?? ''
  }
}
