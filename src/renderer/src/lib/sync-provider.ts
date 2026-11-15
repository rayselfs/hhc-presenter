import type { HhcSourceControl } from '@shared/hhc-assets'
import type { SyncOfflinePolicy, SyncProviderType } from '@shared/types/folder'
import type { SyncEntryRecord } from './sync-db'

export type SyncRetryClassification =
  | 'retryable'
  | 'auth-required'
  | 'access-revoked'
  | 'offline'
  | 'fatal'

export type SyncRemoteContentSource =
  | { kind: 'ticket'; url: string; expiresAt: number; etag: string }
  | { kind: 'native-lease'; url: string; leaseId: string; etag: string; sourceExpiresAt?: number }
  | { kind: 'browser-lease'; url: string; etag: string; sourceExpiresAt: number }

export type SyncDownloadCommitGuard = () => boolean | Promise<boolean>

export class SyncDownloadCancelledError extends Error {
  constructor() {
    super('Sync download cancelled')
  }
}

export interface SyncProviderConnectionInfo {
  id: string
  providerType: SyncProviderType
  displayName: string
  accountLabel?: string
}

export interface RemoteSyncItem {
  sourceExpiresAt?: number
  remoteItemId: string
  parentRemoteItemId: string | null
  kind: 'folder' | 'file'
  name: string
  mimeType?: string
  size?: number
  etag?: string
  contentHash?: string
  sourceCreatedAt?: number
  deleted?: boolean
}

export function parseSourceCreatedAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

export interface SyncChangePage {
  sourceControl?: HhcSourceControl
  items: RemoteSyncItem[]
  nextCursor?: string
  hasMore: boolean
  reset?: boolean
}

export interface SyncDownloadRequest {
  providerConnectionId: string
  rootRemoteFolderId: string
  remoteItemId: string
  targetBlobId: string
  offlinePolicy: SyncOfflinePolicy
}

export interface SyncDownloadResult {
  blobId: string
  size: number
  mimeType: string
}

export interface ReadOnlySyncProvider {
  readonly providerType: SyncProviderType
  connect(): Promise<SyncProviderConnectionInfo>
  disconnect(providerConnectionId: string): Promise<void>
  initialScan(providerConnectionId: string, remoteFolderId: string): Promise<SyncChangePage>
  incrementalChanges(input: {
    providerConnectionId: string
    remoteFolderId: string
    cursor: string
  }): Promise<SyncChangePage>
  getMetadata(providerConnectionId: string, remoteItemId: string): Promise<RemoteSyncItem>
  getRemoteContentSource?(
    providerConnectionId: string,
    remoteItemId: string
  ): Promise<SyncRemoteContentSource>
  downloadContent(
    request: SyncDownloadRequest,
    signal: AbortSignal,
    canCommit: SyncDownloadCommitGuard
  ): Promise<SyncDownloadResult>
  classifyError(error: unknown): SyncRetryClassification
}

export function assertProviderDoesNotExposeWriteOperations(provider: ReadOnlySyncProvider): void {
  const names = new Set(Object.keys(provider as unknown as Record<string, unknown>))
  for (const forbidden of ['upload', 'rename', 'move', 'delete', 'createFolder']) {
    if (names.has(forbidden)) throw new Error(`Read-only sync provider exposes ${forbidden}`)
  }
}

export function isEntryAvailableOffline(entry: SyncEntryRecord): boolean {
  return entry.status === 'available-offline' && typeof entry.blobId === 'string'
}
