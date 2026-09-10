import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { SyncOfflinePolicy, SyncProviderType } from '@shared/types/folder'
import type { SyncDownloadCommitGuard, SyncRetryClassification } from './sync-provider'
import { dispatchRecoverySourceChanged } from './recovery-source-events'

export type SyncEntryKind = 'folder' | 'file'
export type SyncEntryStatus =
  | 'remote-only'
  | 'queued'
  | 'downloading'
  | 'available-offline'
  | 'outdated'
  | 'failed'
  | 'insufficient-storage'
  | 'deleted-pending-release'

export const SYNC_ENTRY_CHANGED_EVENT = 'hhc:sync-entry-changed'
const alwaysCanCommit: SyncDownloadCommitGuard = () => true

function isRecoverySyncEntry(entry: SyncEntryRecord | undefined): boolean {
  return entry?.status === 'failed' || entry?.status === 'insufficient-storage'
}

function affectsRecoverySource(entry: SyncEntryRecord | undefined): boolean {
  return isRecoverySyncEntry(entry) || Boolean(entry?.blobId)
}

export interface ProviderConnectionRecord {
  id: string
  providerType: SyncProviderType
  displayName: string
  accountLabel?: string
  accountUserId?: string
  createdAt: number
  updatedAt: number
}

export interface SyncCursorRecord {
  id: string
  providerConnectionId: string
  remoteFolderId: string
  cursor: string
  updatedAt: number
}

export interface SyncEntryRecord {
  id: string
  providerConnectionId: string
  remoteItemId: string
  parentRemoteItemId: string | null
  kind: SyncEntryKind
  name: string
  itemId?: string
  folderId?: string
  blobId?: string
  mimeType?: string
  size?: number
  etag?: string
  contentHash?: string
  status: SyncEntryStatus
  errorKind?: SyncRetryClassification
  retryCount?: number
  nextRetryAt?: number
  lastError?: string
  syncReceipt?: {
    contentVersion: string
    appVersion: string
    state: 'pending' | 'acknowledged' | 'rejected'
    attempts: number
    nextRetryAt: number
  }
  downloadedBytes?: number
  downloadTotalBytes?: number
  createdAt: number
  updatedAt: number
}

export interface SyncEntryPreferenceRecord {
  id: string
  providerConnectionId: string
  remoteItemId: string
  offlinePolicyOverride?: SyncOfflinePolicy
  updatedAt: number
}

export interface SyncTombstoneRecord {
  id: string
  providerConnectionId: string
  remoteItemId: string
  itemId?: string
  folderId?: string
  blobId?: string
  reason: 'remote-delete' | 'unlink' | 'cache-eviction'
  unlinkScope?: 'root' | 'connection'
  createdAt: number
}

export interface PendingShareLeaveRecord {
  id: string
  recipientId: string
  grantId: string
  createdAt: number
}

export const SYNC_CONNECTION_UNLINK_MARKER = '\0connection-unlink'

interface SyncDBSchema extends DBSchema {
  'pending-share-leaves': {
    key: string
    value: PendingShareLeaveRecord
    indexes: { 'by-recipient': string }
  }
  'provider-connections': {
    key: string
    value: ProviderConnectionRecord
    indexes: {
      'by-provider-type': SyncProviderType
      'by-account-user': string
    }
  }
  'sync-cursors': {
    key: string
    value: SyncCursorRecord
    indexes: {
      'by-provider-connection': string
    }
  }
  'sync-entries': {
    key: string
    value: SyncEntryRecord
    indexes: {
      'by-provider-connection': string
      'by-remote-item': string
      'by-status': SyncEntryStatus
      'by-local-item': string
      'by-local-folder': string
    }
  }
  'sync-entry-preferences': {
    key: string
    value: SyncEntryPreferenceRecord
    indexes: {
      'by-provider-connection': string
      'by-remote-item': string
    }
  }
  'sync-tombstones': {
    key: string
    value: SyncTombstoneRecord
    indexes: {
      'by-provider-connection': string
      'by-remote-item': string
      'by-blob': string
    }
  }
}

const DB_NAME = 'hhc-sync'
export const SYNC_DB_VERSION = 3

let dbPromise: Promise<IDBPDatabase<SyncDBSchema>> | null = null

function createRemoteKey(providerConnectionId: string, remoteItemId: string): string {
  return `${providerConnectionId}:${remoteItemId}`
}

function getSyncDB(): Promise<IDBPDatabase<SyncDBSchema>> {
  dbPromise ??= openDB<SyncDBSchema>(DB_NAME, SYNC_DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains('provider-connections')) {
        const store = db.createObjectStore('provider-connections', { keyPath: 'id' })
        store.createIndex('by-provider-type', 'providerType')
      }
      const providerConnectionStore = transaction.objectStore('provider-connections')
      if (!providerConnectionStore.indexNames.contains('by-account-user')) {
        providerConnectionStore.createIndex('by-account-user', 'accountUserId')
      }
      if (!db.objectStoreNames.contains('sync-cursors')) {
        const store = db.createObjectStore('sync-cursors', { keyPath: 'id' })
        store.createIndex('by-provider-connection', 'providerConnectionId')
      }
      if (!db.objectStoreNames.contains('sync-entries')) {
        const store = db.createObjectStore('sync-entries', { keyPath: 'id' })
        store.createIndex('by-provider-connection', 'providerConnectionId')
        store.createIndex('by-remote-item', 'remoteLookupKey', { unique: true })
        store.createIndex('by-status', 'status')
        store.createIndex('by-local-item', 'itemId')
        store.createIndex('by-local-folder', 'folderId')
      }
      if (!db.objectStoreNames.contains('sync-entry-preferences')) {
        const store = db.createObjectStore('sync-entry-preferences', { keyPath: 'id' })
        store.createIndex('by-provider-connection', 'providerConnectionId')
        store.createIndex('by-remote-item', 'remoteLookupKey', { unique: true })
      }
      if (!db.objectStoreNames.contains('sync-tombstones')) {
        const store = db.createObjectStore('sync-tombstones', { keyPath: 'id' })
        store.createIndex('by-provider-connection', 'providerConnectionId')
        store.createIndex('by-remote-item', 'remoteLookupKey')
        store.createIndex('by-blob', 'blobId')
      }
      if (!db.objectStoreNames.contains('pending-share-leaves')) {
        const store = db.createObjectStore('pending-share-leaves', { keyPath: 'id' })
        store.createIndex('by-recipient', 'recipientId')
      }
    }
  })
  return dbPromise
}

export async function openSyncDB(): Promise<IDBPDatabase<SyncDBSchema>> {
  return getSyncDB()
}

export async function putPendingShareLeave(recipientId: string, grantId: string): Promise<void> {
  await (
    await getSyncDB()
  ).put('pending-share-leaves', {
    id: `${recipientId}:${grantId}`,
    recipientId,
    grantId,
    createdAt: Date.now()
  })
}

export async function listPendingShareLeaves(
  recipientId: string
): Promise<PendingShareLeaveRecord[]> {
  return (await getSyncDB()).getAllFromIndex('pending-share-leaves', 'by-recipient', recipientId)
}

export async function deletePendingShareLeave(recipientId: string, grantId: string): Promise<void> {
  await (await getSyncDB()).delete('pending-share-leaves', `${recipientId}:${grantId}`)
}

export function createHhcLineProviderConnectionId(accountUserId: string): string {
  if (!accountUserId) throw new Error('HHC LINE provider connections require an account user ID')
  return `hhc-line:${accountUserId}`
}

export async function putProviderConnection(
  record: Omit<ProviderConnectionRecord, 'createdAt' | 'updatedAt'> & {
    createdAt?: number
    updatedAt?: number
  }
): Promise<ProviderConnectionRecord> {
  if (record.providerType === 'hhc-line' || record.providerType === 'hhc-share') {
    if (!record.accountUserId) {
      throw new Error('HHC LINE provider connections require an account user ID')
    }
    const expected =
      record.providerType === 'hhc-line'
        ? createHhcLineProviderConnectionId(record.accountUserId)
        : `hhc-share:${record.accountUserId}`
    if (record.id !== expected) {
      throw new Error(
        `${record.providerType === 'hhc-line' ? 'HHC LINE' : 'HHC share'} provider connection ID does not match its account user ID`
      )
    }
  }
  const db = await getSyncDB()
  const existing = await db.get('provider-connections', record.id)
  const now = Date.now()
  const value: ProviderConnectionRecord = {
    ...record,
    createdAt: existing?.createdAt ?? record.createdAt ?? now,
    updatedAt: record.updatedAt ?? now
  }
  await db.put('provider-connections', value)
  return value
}

export async function getProviderConnection(
  id: string
): Promise<ProviderConnectionRecord | undefined> {
  return (await getSyncDB()).get('provider-connections', id)
}

export async function listProviderConnections(): Promise<ProviderConnectionRecord[]> {
  return (await getSyncDB()).getAll('provider-connections')
}

export async function listProviderConnectionsByType(
  providerType: SyncProviderType
): Promise<ProviderConnectionRecord[]> {
  return (await getSyncDB()).getAllFromIndex(
    'provider-connections',
    'by-provider-type',
    providerType
  )
}

export async function listHhcLineProviderConnectionsByAccountUser(
  accountUserId: string
): Promise<ProviderConnectionRecord[]> {
  const connections = await (
    await getSyncDB()
  ).getAllFromIndex('provider-connections', 'by-account-user', accountUserId)
  return connections.filter((connection) => connection.providerType === 'hhc-line')
}

export async function deleteProviderConnection(id: string): Promise<void> {
  const db = await getSyncDB()
  const existing = await db.get('provider-connections', id)
  await db.delete('provider-connections', id)
  if (existing) dispatchRecoverySourceChanged()
}

export async function putSyncCursor(
  record: Omit<SyncCursorRecord, 'id'> & { id?: string }
): Promise<SyncCursorRecord> {
  const value = {
    ...record,
    id: record.id ?? createRemoteKey(record.providerConnectionId, record.remoteFolderId)
  }
  await (await getSyncDB()).put('sync-cursors', value)
  return value
}

export async function getSyncCursor(
  providerConnectionId: string,
  remoteFolderId: string
): Promise<SyncCursorRecord | undefined> {
  return (await getSyncDB()).get(
    'sync-cursors',
    createRemoteKey(providerConnectionId, remoteFolderId)
  )
}

export async function putSyncEntry(
  record: Omit<SyncEntryRecord, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: string
    createdAt?: number
    updatedAt?: number
  }
): Promise<SyncEntryRecord> {
  const db = await getSyncDB()
  const tx = db.transaction('sync-entries', 'readwrite')
  const remoteLookupKey = createRemoteKey(record.providerConnectionId, record.remoteItemId)
  const existing = await tx.store.index('by-remote-item').get(remoteLookupKey)
  const now = Date.now()
  const value = {
    ...record,
    syncReceipt:
      existing?.blobId === record.blobId &&
      existing?.syncReceipt?.contentVersion === (record.etag ?? record.contentHash)
        ? (existing?.syncReceipt ?? record.syncReceipt)
        : record.syncReceipt?.contentVersion === (record.etag ?? record.contentHash)
          ? record.syncReceipt
          : undefined,
    id: existing?.id ?? record.id ?? crypto.randomUUID(),
    remoteLookupKey,
    createdAt: existing?.createdAt ?? record.createdAt ?? now,
    updatedAt: record.updatedAt ?? now
  } as SyncEntryRecord & { remoteLookupKey: string }
  await tx.store.put(value)
  await tx.done
  dispatchSyncEntryChanged(value)
  const recoveryStatusChanged =
    (isRecoverySyncEntry(existing) || isRecoverySyncEntry(value)) &&
    (existing?.status !== value.status || existing?.errorKind !== value.errorKind)
  if (recoveryStatusChanged || existing?.blobId !== value.blobId) {
    dispatchRecoverySourceChanged()
  }
  return value
}

function dispatchSyncEntryChanged(entry: SyncEntryRecord): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(SYNC_ENTRY_CHANGED_EVENT, {
      detail: {
        providerConnectionId: entry.providerConnectionId,
        remoteItemId: entry.remoteItemId,
        itemId: entry.itemId,
        folderId: entry.folderId,
        status: entry.status,
        downloadedBytes: entry.downloadedBytes,
        downloadTotalBytes: entry.downloadTotalBytes
      }
    })
  )
}

export async function updateSyncDownloadProgress(
  entryKey: { providerConnectionId: string; remoteItemId: string },
  downloadedBytes: number,
  downloadTotalBytes?: number,
  canCommit: SyncDownloadCommitGuard = alwaysCanCommit
): Promise<void> {
  if (!(await canCommit())) return
  const entry = await getSyncEntryByRemoteItem(entryKey.providerConnectionId, entryKey.remoteItemId)
  if (!entry || !(await canCommit())) return
  const updatedEntry = await putSyncEntry({
    ...entry,
    downloadedBytes,
    downloadTotalBytes
  })
  if (!(await canCommit())) await deleteSyncEntries([updatedEntry.id])
}

export async function getSyncEntryByRemoteItem(
  providerConnectionId: string,
  remoteItemId: string
): Promise<SyncEntryRecord | undefined> {
  return (await getSyncDB()).getFromIndex(
    'sync-entries',
    'by-remote-item',
    createRemoteKey(providerConnectionId, remoteItemId)
  )
}

export async function getSyncEntryByLocalItem(
  itemId: string
): Promise<SyncEntryRecord | undefined> {
  return (await getSyncDB()).getFromIndex('sync-entries', 'by-local-item', itemId)
}

export async function listSyncEntriesByLocalItem(itemId: string): Promise<SyncEntryRecord[]> {
  return (await getSyncDB()).getAllFromIndex('sync-entries', 'by-local-item', itemId)
}

export async function listSyncEntries(): Promise<SyncEntryRecord[]> {
  return (await getSyncDB()).getAll('sync-entries')
}

export async function listSyncEntriesByProviderConnection(
  providerConnectionId: string
): Promise<SyncEntryRecord[]> {
  return (await getSyncDB()).getAllFromIndex(
    'sync-entries',
    'by-provider-connection',
    providerConnectionId
  )
}

export async function deleteSyncEntriesByProviderConnection(
  providerConnectionId: string
): Promise<void> {
  const db = await getSyncDB()
  const entries = await listSyncEntriesByProviderConnection(providerConnectionId)
  const tx = db.transaction('sync-entries', 'readwrite')
  await Promise.all(entries.map((entry) => tx.store.delete(entry.id)))
  await tx.done
  if (entries.some(affectsRecoverySource)) dispatchRecoverySourceChanged()
}

export async function deleteSyncEntries(
  ids: string[],
  options: { notifyRecovery?: boolean } = {}
): Promise<void> {
  if (ids.length === 0) return
  const db = await getSyncDB()
  const tx = db.transaction('sync-entries', 'readwrite')
  const entries = await Promise.all(ids.map((id) => tx.store.get(id)))
  await Promise.all(ids.map((id) => tx.store.delete(id)))
  await tx.done
  if (options.notifyRecovery !== false && entries.some(affectsRecoverySource)) {
    dispatchRecoverySourceChanged()
  }
}

export async function putSyncEntryPreference(
  record: Omit<SyncEntryPreferenceRecord, 'id' | 'updatedAt'> & {
    updatedAt?: number
  }
): Promise<SyncEntryPreferenceRecord> {
  const db = await getSyncDB()
  const remoteLookupKey = createRemoteKey(record.providerConnectionId, record.remoteItemId)
  const value = {
    ...record,
    id: remoteLookupKey,
    remoteLookupKey,
    updatedAt: record.updatedAt ?? Date.now()
  } as SyncEntryPreferenceRecord & { remoteLookupKey: string }
  await db.put('sync-entry-preferences', value)
  return value
}

export async function getSyncEntryPreference(
  providerConnectionId: string,
  remoteItemId: string
): Promise<SyncEntryPreferenceRecord | undefined> {
  return (await getSyncDB()).getFromIndex(
    'sync-entry-preferences',
    'by-remote-item',
    createRemoteKey(providerConnectionId, remoteItemId)
  )
}

export async function deleteSyncEntryPreferencesByProviderConnection(
  providerConnectionId: string
): Promise<void> {
  const db = await getSyncDB()
  const preferences = await db.getAllFromIndex(
    'sync-entry-preferences',
    'by-provider-connection',
    providerConnectionId
  )
  const tx = db.transaction('sync-entry-preferences', 'readwrite')
  await Promise.all(preferences.map((preference) => tx.store.delete(preference.id)))
  await tx.done
}

export async function deleteSyncEntryPreferences(
  providerConnectionId: string,
  remoteItemIds: string[]
): Promise<void> {
  if (remoteItemIds.length === 0) return
  const db = await getSyncDB()
  const tx = db.transaction('sync-entry-preferences', 'readwrite')
  await Promise.all(
    remoteItemIds.map((remoteItemId) =>
      tx.store.delete(createRemoteKey(providerConnectionId, remoteItemId))
    )
  )
  await tx.done
}

export async function putSyncTombstone(
  record: Omit<SyncTombstoneRecord, 'id' | 'createdAt'> & {
    id?: string
    createdAt?: number
  }
): Promise<SyncTombstoneRecord> {
  const value = {
    ...record,
    id: record.id ?? crypto.randomUUID(),
    remoteLookupKey: createRemoteKey(record.providerConnectionId, record.remoteItemId),
    createdAt: record.createdAt ?? Date.now()
  } as SyncTombstoneRecord & { remoteLookupKey: string }
  await (await getSyncDB()).put('sync-tombstones', value)
  return value
}

export async function listSyncTombstones(): Promise<SyncTombstoneRecord[]> {
  return (await getSyncDB()).getAll('sync-tombstones')
}

export async function deleteSyncTombstones(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await getSyncDB()
  const tx = db.transaction('sync-tombstones', 'readwrite')
  await Promise.all(ids.map((id) => tx.store.delete(id)))
  await tx.done
}

export async function deleteSyncCursorsByProviderConnection(
  providerConnectionId: string
): Promise<void> {
  const db = await getSyncDB()
  const cursors = await db.getAllFromIndex(
    'sync-cursors',
    'by-provider-connection',
    providerConnectionId
  )
  const tx = db.transaction('sync-cursors', 'readwrite')
  await Promise.all(cursors.map((cursor) => tx.store.delete(cursor.id)))
  await tx.done
}

export async function deleteSyncCursor(
  providerConnectionId: string,
  remoteFolderId: string
): Promise<void> {
  await (
    await getSyncDB()
  ).delete('sync-cursors', createRemoteKey(providerConnectionId, remoteFolderId))
}

export async function resetSyncDB(): Promise<void> {
  const db = await dbPromise
  db?.close()
  dbPromise = null
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Sync database deletion blocked'))
  })
}

export const resetSyncDBForTests = resetSyncDB
