import { lockMediaResources } from './media-resource-locks'
import type { HhcSession } from '@shared/hhc-auth'
import type { HhcAssetCollectionItem, HhcSourceControl } from '@shared/hhc-assets'
import { HhcAssetApiError, type HhcAssetApi } from './hhc-asset-api'
import {
  createHhcLineProviderConnectionId,
  deleteSyncEntries,
  getSyncEntryByRemoteItem,
  putProviderConnection,
  putSyncEntry
} from './sync-db'
import { openFileExplorerDB } from './file-explorer-db'
import { isElectron } from './env'
import { saveWebHhcDownloadedContent } from './sync-download-storage'
import { unlinkSyncConnectionFromApp } from './sync-unlink'
import { dispatchRecoverySourceChanged } from './recovery-source-events'
import {
  SyncDownloadCancelledError,
  parseSourceCreatedAt,
  type ReadOnlySyncProvider,
  type RemoteSyncItem,
  type SyncChangePage,
  type SyncDownloadCommitGuard,
  type SyncDownloadRequest,
  type SyncDownloadResult,
  type SyncRemoteContentSource,
  type SyncRetryClassification,
  type SyncProviderConnectionInfo
} from './sync-provider'
import type { HhcLineAccessRequestAuth } from './hhc-line-access'

type DownloadedContent = Awaited<ReturnType<HhcAssetApi['downloadContent']>>

import { pendingHhcSyncReceipt, retryHhcSyncReceipt } from './hhc-sync-receipts'

type HhcLineProviderOptions = {
  api: HhcAssetApi
  getSession: () => HhcSession | null | Promise<HhcSession | null>
  getAuthGeneration?: () => number
  saveDownloadedContent?: (
    request: SyncDownloadRequest,
    content: DownloadedContent,
    metadata: RemoteSyncItem,
    canCommit: SyncDownloadCommitGuard
  ) => Promise<SyncDownloadResult>
  onSourceControl?: (connectionId: string, control: HhcSourceControl) => Promise<void>
  onAccessError?: (
    scope: {
      providerConnectionId: string
      rootRemoteFolderId: string
      remoteItemId?: string
    },
    error: unknown,
    requestAuth?: HhcLineAccessRequestAuth
  ) => void | Promise<void>
}

function mapItem(item: HhcAssetCollectionItem): RemoteSyncItem {
  const sourceCreatedAt = parseSourceCreatedAt(item.createdAt)
  return {
    ...(item.sourceExpiresAt ? { sourceExpiresAt: Date.parse(item.sourceExpiresAt) } : {}),
    remoteItemId: item.id,
    parentRemoteItemId: item.collectionId,
    kind: 'file',
    name: item.displayName,
    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    ...(item.sizeBytes === undefined ? {} : { size: item.sizeBytes }),
    ...(item.etag ? { etag: item.etag } : {}),
    contentHash: item.sourceRevision,
    ...(sourceCreatedAt === undefined ? {} : { sourceCreatedAt })
  }
}

async function saveNativeDownloadedContent(
  request: SyncDownloadRequest,
  content: Exclude<DownloadedContent, Response>,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard
): Promise<SyncDownloadResult> {
  const release = lockMediaResources([request.targetBlobId])
  try {
    await release.ready
    if (!(await canCommit())) {
      await window.api.nativeFs.delete(content.fileId)
      throw new SyncDownloadCancelledError()
    }
    const db = await openFileExplorerDB()
    let entryId: string | undefined
    try {
      await db.put('file-blobs', {
        ...(metadata.sourceExpiresAt === undefined
          ? {}
          : { sourceExpiresAt: metadata.sourceExpiresAt }),
        id: request.targetBlobId,
        storage: 'native-fs',
        size: content.size,
        refCount: 1
      })
      if (!(await canCommit())) throw new SyncDownloadCancelledError()
      const entry = await putSyncEntry({
        providerConnectionId: request.providerConnectionId,
        remoteItemId: request.remoteItemId,
        parentRemoteItemId: metadata.parentRemoteItemId,
        kind: 'file',
        name: metadata.name,
        itemId: request.targetBlobId,
        blobId: request.targetBlobId,
        mimeType: metadata.mimeType ?? content.mimeType,
        size: content.size,
        etag: metadata.etag,
        contentHash: metadata.contentHash,
        sourceExpiresAt: metadata.sourceExpiresAt,
        status: 'available-offline',
        syncReceipt: pendingHhcSyncReceipt(request, metadata),
        downloadedBytes: content.size,
        downloadTotalBytes: content.size
      })
      entryId = entry.id
      if (!(await canCommit())) throw new SyncDownloadCancelledError()
    } catch (error) {
      const cleanup = await Promise.allSettled([
        entryId ? deleteSyncEntries([entryId], { notifyRecovery: false }) : Promise.resolve(),
        db.delete('file-blobs', request.targetBlobId),
        window.api.nativeFs.delete(content.fileId)
      ])
      if (error instanceof SyncDownloadCancelledError) dispatchRecoverySourceChanged()
      const cleanupFailure = cleanup.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (cleanupFailure) throw cleanupFailure.reason
      throw error
    }
    return {
      blobId: request.targetBlobId,
      size: content.size,
      mimeType: metadata.mimeType ?? content.mimeType
    }
  } finally {
    release()
  }
}

async function saveDownloadedContent(
  request: SyncDownloadRequest,
  content: DownloadedContent,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard
): Promise<SyncDownloadResult> {
  if (content instanceof Response) {
    return saveWebHhcDownloadedContent(request, content, metadata, canCommit)
  }
  return saveNativeDownloadedContent(request, content, metadata, canCommit)
}

export class HhcLineReadonlyProvider implements ReadOnlySyncProvider {
  readonly providerType = 'hhc-line' as const
  private readonly collectionsByItem = new Map<string, string>()
  private readonly save: NonNullable<HhcLineProviderOptions['saveDownloadedContent']>

  constructor(private readonly options: HhcLineProviderOptions) {
    this.save = options.saveDownloadedContent ?? saveDownloadedContent
  }

  async connect(): Promise<SyncProviderConnectionInfo> {
    const session = await this.options.getSession()
    if (!session) throw new Error('HHC account authentication required')
    const connection = await putProviderConnection({
      id: createHhcLineProviderConnectionId(session.userId),
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountLabel: session.displayName,
      accountUserId: session.userId
    })
    return {
      id: connection.id,
      providerType: connection.providerType,
      displayName: connection.displayName,
      accountLabel: connection.accountLabel
    }
  }

  async disconnect(providerConnectionId: string): Promise<void> {
    await unlinkSyncConnectionFromApp(providerConnectionId)
  }

  initialScan(_providerConnectionId: string, remoteFolderId: string): Promise<SyncChangePage> {
    return this.changes(_providerConnectionId, remoteFolderId)
  }

  incrementalChanges(input: {
    providerConnectionId: string
    remoteFolderId: string
    cursor: string
  }): Promise<SyncChangePage> {
    return this.changes(input.providerConnectionId, input.remoteFolderId, input.cursor)
  }

  async getMetadata(providerConnectionId: string, remoteItemId: string): Promise<RemoteSyncItem> {
    const collectionId = await this.collectionForItem(providerConnectionId, remoteItemId)
    return this.withAccessBoundary(
      { providerConnectionId, rootRemoteFolderId: collectionId, remoteItemId },
      async () => mapItem(await this.options.api.getCollectionItem(collectionId, remoteItemId))
    )
  }

  async getRemoteContentSource(
    providerConnectionId: string,
    remoteItemId: string
  ): Promise<SyncRemoteContentSource> {
    const collectionId = await this.collectionForItem(providerConnectionId, remoteItemId)
    return this.withAccessBoundary(
      { providerConnectionId, rootRemoteFolderId: collectionId, remoteItemId },
      () => this.options.api.getRemoteContentSource(collectionId, remoteItemId)
    )
  }

  async downloadContent(
    request: SyncDownloadRequest,
    signal: AbortSignal,
    canCommit: SyncDownloadCommitGuard
  ): Promise<SyncDownloadResult> {
    const rootRemoteFolderId = request.rootRemoteFolderId
    const metadata = mapItem(
      await this.options.api.getCollectionItem(rootRemoteFolderId, request.remoteItemId)
    )
    const content = await this.options.api.downloadContent(
      {
        collectionId: rootRemoteFolderId,
        itemId: request.remoteItemId,
        rootRemoteFolderId,
        ...(isElectron() ? { targetFileId: request.targetBlobId } : {})
      },
      signal
    )
    const guardedCommit = async (): Promise<boolean> =>
      (metadata.sourceExpiresAt === undefined || metadata.sourceExpiresAt > Date.now()) &&
      (await canCommit())
    const result = await this.save(request, content, metadata, guardedCommit)
    if (request.offlinePolicy === 'always-offline') {
      void this.retryReceipt(request.providerConnectionId, request.remoteItemId, canCommit)
    }
    return result
  }

  retryReceipt(
    connectionId: string,
    itemId: string,
    canCommit: SyncDownloadCommitGuard
  ): Promise<void> {
    return retryHhcSyncReceipt(this.options.api, connectionId, itemId, canCommit)
  }

  classifyError(error: unknown): SyncRetryClassification {
    if (error instanceof TypeError) return 'offline'
    if (error && typeof error === 'object' && 'classification' in error) {
      const classification = error.classification
      if (
        classification === 'retryable' ||
        classification === 'auth-required' ||
        classification === 'access-revoked' ||
        classification === 'fatal'
      ) {
        return classification
      }
    }
    return 'fatal'
  }

  private async changes(
    providerConnectionId: string,
    remoteFolderId: string,
    cursor?: string
  ): Promise<SyncChangePage> {
    let control: HhcSourceControl | null = null
    const page = await this.withAccessBoundary(
      { providerConnectionId, rootRemoteFolderId: remoteFolderId },
      async () => {
        control = await this.control(providerConnectionId, remoteFolderId)
        const result = cursor
          ? await this.options.api.getCollectionChanges(remoteFolderId, cursor)
          : await this.options.api.getCollectionChanges(remoteFolderId)
        if (control || result.collection.sourcePolicyVersion === 1) {
          const after = await this.control(providerConnectionId, remoteFolderId)
          if (
            !control ||
            !after ||
            JSON.stringify(control) !== JSON.stringify(after) ||
            result.collection.sourcePolicyVersion !== 1 ||
            result.collection.aclRevision !== after.aclRevision ||
            result.collection.bindingGeneration !== after.bindingGeneration
          ) {
            throw new HhcAssetApiError('retryable', 503, 'dependency-unavailable')
          }
        }
        return result
      }
    )
    for (const item of page.items) this.collectionsByItem.set(item.id, item.collectionId)
    return {
      items: [
        ...page.items.map(mapItem),
        ...page.tombstones.map((item) => ({
          remoteItemId: item.id,
          parentRemoteItemId: remoteFolderId,
          kind: 'file' as const,
          name: item.id,
          deleted: true
        }))
      ],
      nextCursor: page.cursor,
      hasMore: page.hasMore,
      reset: page.reset,
      ...(control ? { sourceControl: control } : {})
    }
  }

  private async control(
    connectionId: string,
    collectionId: string
  ): Promise<HhcSourceControl | null> {
    let control: HhcSourceControl
    try {
      control = await this.options.api.getCollectionControl(collectionId)
    } catch (error) {
      if (error instanceof HhcAssetApiError && error.status === 404 && !error.outcome) return null
      throw error
    }
    if (control.collectionId !== collectionId)
      throw new HhcAssetApiError('retryable', 503, 'dependency-unavailable')
    await this.options.onSourceControl?.(connectionId, control)
    if (control.state === 'paused')
      throw new HhcAssetApiError('retryable', 423, 'collection-paused')
    if (control.state !== 'active')
      throw new HhcAssetApiError('access-revoked', 410, 'collection-revoked')
    return control
  }

  private async withAccessBoundary<T>(
    scope: {
      providerConnectionId: string
      rootRemoteFolderId: string
      remoteItemId?: string
    },
    request: () => Promise<T>
  ): Promise<T> {
    const authGeneration = this.options.getAuthGeneration?.() ?? 0
    const session = await this.options.getSession()
    const requestAuth = session ? { accountUserId: session.userId, authGeneration } : undefined
    try {
      return await request()
    } catch (error) {
      await Promise.resolve(this.options.onAccessError?.(scope, error, requestAuth)).catch(
        () => undefined
      )
      throw error
    }
  }

  private async collectionForItem(
    providerConnectionId: string,
    remoteItemId: string
  ): Promise<string> {
    const cached = this.collectionsByItem.get(remoteItemId)
    if (cached) return cached
    const entry = await getSyncEntryByRemoteItem(providerConnectionId, remoteItemId)
    if (!entry?.parentRemoteItemId) throw new Error('HHC collection item is unavailable')
    return entry.parentRemoteItemId
  }
}
