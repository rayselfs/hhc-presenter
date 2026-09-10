import type { HhcSession } from '@shared/hhc-auth'
import type { SharedFolderRoot, SharedFolderSnapshot } from '@shared/personal-cloud'
import { openFileExplorerDB, type FileBlobRecord } from './file-explorer-db'
import {
  deleteSyncEntries,
  getSyncEntryByRemoteItem,
  putProviderConnection,
  putSyncEntry
} from './sync-db'
import { saveWebSharedDownloadedContent } from './sync-download-storage'
import { unlinkSyncConnectionFromApp } from './sync-unlink'
import {
  SyncDownloadCancelledError,
  type ReadOnlySyncProvider,
  type RemoteSyncItem,
  type SyncChangePage,
  type SyncDownloadCommitGuard,
  type SyncDownloadRequest,
  type SyncDownloadResult,
  type SyncProviderConnectionInfo,
  type SyncRetryClassification
} from './sync-provider'

type SharedContent = Response | (FileBlobRecord & { mimeType: string; size: number })
type PersonalShareApi = {
  listSharedFolders(signal?: AbortSignal): Promise<SharedFolderRoot[]>
  getSharedFolderSnapshot(
    grantId: string,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<SharedFolderSnapshot>
  downloadSharedContent(
    grantId: string,
    itemId: string,
    signal: AbortSignal,
    targetBlobId?: string
  ): Promise<SharedContent>
}

type Options = {
  api: PersonalShareApi
  getSession: () => HhcSession | null | Promise<HhcSession | null>
  saveDownloadedContent?: (
    request: SyncDownloadRequest,
    content: SharedContent,
    metadata: RemoteSyncItem,
    canCommit: SyncDownloadCommitGuard
  ) => Promise<SyncDownloadResult>
}

export function personalShareConnectionId(recipientId: string): string {
  return `hhc-share:${recipientId}`
}

export function personalShareRemoteId(grantId: string, itemId: string): string {
  return `${grantId}:${itemId}`
}

function parseRemoteId(value: string): { grantId: string; itemId: string } {
  const separator = value.indexOf(':')
  if (separator < 1 || separator === value.length - 1) throw new Error('Invalid shared item')
  return { grantId: value.slice(0, separator), itemId: value.slice(separator + 1) }
}

function mapNode(grantId: string, node: SharedFolderSnapshot['items'][number]): RemoteSyncItem {
  return {
    remoteItemId: personalShareRemoteId(grantId, node.id),
    parentRemoteItemId: node.parentId ? personalShareRemoteId(grantId, node.parentId) : null,
    kind: node.kind,
    name: node.name,
    ...(node.mimeType ? { mimeType: node.mimeType } : {}),
    ...(node.sizeBytes === undefined ? {} : { size: node.sizeBytes }),
    ...(node.etag ? { etag: node.etag } : {}),
    contentHash: `${node.revision}:${node.etag ?? ''}`
  }
}

async function saveNative(
  request: SyncDownloadRequest,
  content: Exclude<SharedContent, Response>,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard
): Promise<SyncDownloadResult> {
  if (!(await canCommit())) {
    if (content.storage === 'native-fs') await window.api.nativeFs.delete(content.id)
    throw new SyncDownloadCancelledError()
  }
  const db = await openFileExplorerDB()
  let entryId: string | undefined
  try {
    await db.put('file-blobs', content)
    if (!(await canCommit())) throw new SyncDownloadCancelledError()
    entryId = (
      await putSyncEntry({
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
        status: 'available-offline',
        downloadedBytes: content.size,
        downloadTotalBytes: content.size
      })
    ).id
    if (!(await canCommit())) throw new SyncDownloadCancelledError()
  } catch (error) {
    if (entryId) await deleteSyncEntries([entryId], { notifyRecovery: false })
    await db.delete('file-blobs', request.targetBlobId)
    if (content.storage === 'native-fs') await window.api.nativeFs.delete(content.id)
    throw error
  }
  return { blobId: request.targetBlobId, size: content.size, mimeType: content.mimeType }
}

async function saveDownloaded(
  request: SyncDownloadRequest,
  content: SharedContent,
  metadata: RemoteSyncItem,
  canCommit: SyncDownloadCommitGuard
): Promise<SyncDownloadResult> {
  return content instanceof Response
    ? saveWebSharedDownloadedContent(request, content, metadata, canCommit)
    : saveNative(request, content, metadata, canCommit)
}

export class PersonalShareProvider implements ReadOnlySyncProvider {
  readonly providerType = 'hhc-share' as const
  private readonly metadata = new Map<string, RemoteSyncItem>()
  private readonly save: NonNullable<Options['saveDownloadedContent']>

  constructor(private readonly options: Options) {
    this.save = options.saveDownloadedContent ?? saveDownloaded
  }

  async connect(): Promise<SyncProviderConnectionInfo> {
    const session = await this.options.getSession()
    if (!session)
      throw Object.assign(new Error('HHC account authentication required'), {
        classification: 'auth-required'
      })
    const connection = await putProviderConnection({
      id: personalShareConnectionId(session.userId),
      providerType: 'hhc-share',
      displayName: '與我分享',
      accountLabel: session.displayName,
      accountUserId: session.userId
    })
    return connection
  }

  async disconnect(providerConnectionId: string): Promise<void> {
    await unlinkSyncConnectionFromApp(providerConnectionId)
  }

  initialScan(providerConnectionId: string, remoteFolderId: string): Promise<SyncChangePage> {
    return this.changes(providerConnectionId, remoteFolderId)
  }

  incrementalChanges(input: {
    providerConnectionId: string
    remoteFolderId: string
    cursor: string
  }): Promise<SyncChangePage> {
    return this.changes(input.providerConnectionId, input.remoteFolderId, input.cursor)
  }

  async getMetadata(providerConnectionId: string, remoteItemId: string): Promise<RemoteSyncItem> {
    await this.assertRecipient(providerConnectionId)
    const cached = this.metadata.get(remoteItemId)
    if (cached) return cached
    const entry = await getSyncEntryByRemoteItem(providerConnectionId, remoteItemId)
    if (entry) {
      return {
        remoteItemId,
        parentRemoteItemId: entry.parentRemoteItemId,
        kind: entry.kind,
        name: entry.name,
        mimeType: entry.mimeType,
        size: entry.size,
        etag: entry.etag,
        contentHash: entry.contentHash
      }
    }
    throw new Error('Shared item metadata is unavailable')
  }

  async downloadContent(
    request: SyncDownloadRequest,
    signal: AbortSignal,
    canCommit: SyncDownloadCommitGuard
  ): Promise<SyncDownloadResult> {
    await this.assertRecipient(request.providerConnectionId)
    const { grantId, itemId } = parseRemoteId(request.remoteItemId)
    const metadata = await this.getMetadata(request.providerConnectionId, request.remoteItemId)
    return this.save(
      request,
      await this.options.api.downloadSharedContent(grantId, itemId, signal, request.targetBlobId),
      metadata,
      canCommit
    )
  }

  classifyError(error: unknown): SyncRetryClassification {
    if (error instanceof TypeError) return 'offline'
    if (error && typeof error === 'object') {
      if ('classification' in error && typeof error.classification === 'string') {
        if (
          error.classification === 'retryable' ||
          error.classification === 'auth-required' ||
          error.classification === 'access-revoked' ||
          error.classification === 'offline' ||
          error.classification === 'fatal'
        ) {
          return error.classification
        }
      }
      if ('status' in error) {
        if (error.status === 0) return 'offline'
        if (error.status === 401) return 'auth-required'
        if (error.status === 403 || error.status === 404 || error.status === 410)
          return 'access-revoked'
        if (error.status === 429 || (typeof error.status === 'number' && error.status >= 500))
          return 'retryable'
      }
    }
    return 'fatal'
  }

  private async changes(
    providerConnectionId: string,
    remoteFolderId: string,
    cursor?: string
  ): Promise<SyncChangePage> {
    await this.assertRecipient(providerConnectionId)
    const { grantId } = parseRemoteId(remoteFolderId)
    if (cursor?.startsWith('steady:')) {
      const root = (await this.options.api.listSharedFolders()).find(
        (folder) => folder.grantId === grantId
      )
      if (!root) {
        throw Object.assign(new Error('Shared folder access revoked'), {
          classification: 'access-revoked',
          status: 404
        })
      }
      if (cursor === `steady:${root.collectionRevision}`) {
        return { items: [], nextCursor: cursor, hasMore: false, reset: false }
      }
    }
    const page = await this.options.api.getSharedFolderSnapshot(
      grantId,
      cursor?.startsWith('page:') ? cursor.slice(5) : undefined
    )
    const items = page.items.map((node) => mapNode(grantId, node))
    for (const item of items) this.metadata.set(item.remoteItemId, item)
    return page.hasMore
      ? { items, nextCursor: `page:${page.nextCursor}`, hasMore: true, reset: true }
      : { items, nextCursor: `steady:${page.collectionRevision}`, hasMore: true, reset: true }
  }

  private async assertRecipient(providerConnectionId: string): Promise<HhcSession> {
    const session = await this.options.getSession()
    if (!session || providerConnectionId !== personalShareConnectionId(session.userId)) {
      throw Object.assign(new Error('HHC account changed'), { classification: 'auth-required' })
    }
    return session
  }
}
