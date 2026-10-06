import type { FileItemRecord } from '@shared/types/folder'
import { getBlobId } from './blob-identity'
import { listFileBlobRecords, openFileExplorerDB } from './file-explorer-db'
import { listDerivedAssets } from './media-work-db'
import { createResourceCleanupRecord, retryResourceCleanup } from './resource-cleanup-journal'
import { dispatchRecoverySourceChanged } from './recovery-source-events'
import { listSyncEntries } from './sync-db'

export type MediaStorageIntegrityIssueKind =
  | 'file-item-missing-blob'
  | 'file-blob-unreferenced'
  | 'file-blob-ref-count-mismatch'
  | 'derived-asset-missing-source'
  | 'sync-entry-missing-blob'

export interface MediaStorageIntegrityIssue {
  kind: MediaStorageIntegrityIssueKind
  severity: 'warning' | 'error'
  resourceId: string
  relatedId?: string
  actualRefCount?: number
  expectedRefCount?: number
  message: string
}

export interface MediaStorageIntegrityReport {
  checkedAt: number
  issueCount: number
  issues: MediaStorageIntegrityIssue[]
}

export interface MediaStorageIntegrityRepairResult {
  correctedRefCounts: string[]
  cleanupJournalIds: string[]
}

function isFileItem(value: unknown): value is FileItemRecord {
  return typeof value === 'object' && value !== null && (value as FileItemRecord).type === 'file'
}

function incrementReference(counts: Map<string, number>, blobId: string): void {
  counts.set(blobId, (counts.get(blobId) ?? 0) + 1)
}

export async function scanMediaStorageIntegrity(
  now = Date.now()
): Promise<MediaStorageIntegrityReport> {
  const [fileBlobs, derivedAssets, syncEntries, db] = await Promise.all([
    listFileBlobRecords(),
    listDerivedAssets(),
    listSyncEntries(),
    openFileExplorerDB()
  ])
  const folderItems = await db.getAll('folder-items')
  const blobIds = new Set(fileBlobs.map((record) => record.id))
  const expectedRefCounts = new Map<string, number>()
  const issues: MediaStorageIntegrityIssue[] = []

  for (const item of folderItems) {
    if (!isFileItem(item)) continue
    const blobId = getBlobId(item)
    incrementReference(expectedRefCounts, blobId)
    if (!blobIds.has(blobId)) {
      issues.push({
        kind: 'file-item-missing-blob',
        severity: 'error',
        resourceId: item.id,
        relatedId: blobId,
        message: 'File item references a missing source Blob record'
      })
    }
  }

  for (const operation of await db.getAll('personal-sync-outbox')) {
    if (operation.snapshotBlobId) incrementReference(expectedRefCounts, operation.snapshotBlobId)
  }

  for (const entry of syncEntries) {
    if (!entry.blobId) continue
    if (!blobIds.has(entry.blobId)) {
      issues.push({
        kind: 'sync-entry-missing-blob',
        severity: 'error',
        resourceId: entry.id,
        relatedId: entry.blobId,
        message: 'Sync entry references a missing cached Blob record'
      })
    }
  }

  for (const asset of derivedAssets) {
    if (!blobIds.has(asset.sourceBlobId)) {
      issues.push({
        kind: 'derived-asset-missing-source',
        severity: asset.status === 'ready' ? 'error' : 'warning',
        resourceId: asset.id,
        relatedId: asset.sourceBlobId,
        message: 'Derived asset references a missing source Blob record'
      })
    }
  }

  for (const record of fileBlobs) {
    const actualRefCount = record.refCount ?? 0
    const expectedRefCount = expectedRefCounts.get(record.id) ?? 0
    if (expectedRefCount === 0) {
      issues.push({
        kind: 'file-blob-unreferenced',
        severity: 'warning',
        resourceId: record.id,
        message: 'Blob record is not referenced by any file item'
      })
    }
    if (actualRefCount !== expectedRefCount) {
      issues.push({
        kind: 'file-blob-ref-count-mismatch',
        severity: 'warning',
        resourceId: record.id,
        actualRefCount,
        expectedRefCount,
        message: 'Blob reference count does not match authoritative references'
      })
    }
  }

  return {
    checkedAt: now,
    issueCount: issues.length,
    issues
  }
}

export async function repairMediaStorageIntegrity(): Promise<MediaStorageIntegrityRepairResult> {
  const [syncEntries, db] = await Promise.all([listSyncEntries(), openFileExplorerDB()])
  const tx = db.transaction(
    ['file-blobs', 'folder-items', 'personal-sync-outbox', 'resource-cleanup-journal'],
    'readwrite'
  )
  const [fileBlobs, folderItems, outbox, pendingCleanups] = await Promise.all([
    tx.objectStore('file-blobs').getAll(),
    tx.objectStore('folder-items').getAll(),
    tx.objectStore('personal-sync-outbox').getAll(),
    tx.objectStore('resource-cleanup-journal').getAll()
  ])
  const expectedRefCounts = new Map<string, number>()
  const syncBlobIds = new Set(syncEntries.flatMap((entry) => (entry.blobId ? [entry.blobId] : [])))
  for (const item of folderItems) {
    if (isFileItem(item)) incrementReference(expectedRefCounts, getBlobId(item))
  }
  for (const operation of outbox) {
    if (operation.snapshotBlobId) incrementReference(expectedRefCounts, operation.snapshotBlobId)
  }
  const correctedRefCounts: string[] = []
  const cleanupRecords = []
  const blobStore = tx.objectStore('file-blobs')
  const journalStore = tx.objectStore('resource-cleanup-journal')

  for (const record of fileBlobs) {
    const expectedRefCount = expectedRefCounts.get(record.id) ?? 0
    const actualRefCount = record.refCount ?? 0
    if (expectedRefCount > 0) {
      if (actualRefCount !== expectedRefCount) {
        await blobStore.put({ ...record, refCount: expectedRefCount })
        correctedRefCounts.push(record.id)
      }
      continue
    }
    if (
      syncBlobIds.has(record.id) ||
      pendingCleanups.some((pending) => pending.blobId === record.id)
    )
      continue

    const cleanupRecord = createResourceCleanupRecord({
      blobId: record.id,
      storage: record.storage,
      deleteNativeFile: record.storage === 'native-fs',
      deleteDerivedAssets: true,
      deletePdfPageThumbs: true,
      itemThumbnailIds: [],
      deleteBlobRecord: true
    })
    await blobStore.put({ ...record, refCount: 0 })
    await journalStore.put(cleanupRecord)
    cleanupRecords.push(cleanupRecord)
  }
  await tx.done

  await Promise.all(cleanupRecords.map((record) => retryResourceCleanup(record.id)))

  if (correctedRefCounts.length > 0 && cleanupRecords.length === 0) {
    dispatchRecoverySourceChanged()
  }

  return {
    correctedRefCounts,
    cleanupJournalIds: cleanupRecords.map((record) => record.id)
  }
}
