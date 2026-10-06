import { publishCatalogDeletion } from './file-catalog-events'
import type { AnyItemRecord, FileItemRecord, FolderRecord } from '@shared/types/folder'
import { getBlobId } from './blob-identity'
import { openFileExplorerDB, type ResourceCleanupJournalRecord } from './file-explorer-db'
import { createResourceCleanupRecord, retryResourceCleanup } from './resource-cleanup-journal'
import { mediaJobQueue } from './media-job-queue'
import type { MediaJobRecord, MediaJobType } from './media-work-db'
import type { PersonalOutboxRecord, PersonalSyncNode } from './personal-sync-db'

export interface CleanupResult {
  folderIds: string[]
  itemIds: string[]
}

export interface CleanupRequest {
  folderIds?: string[]
  itemIds?: string[]
}

function isFileItem(item: AnyItemRecord): item is FileItemRecord {
  return item.type === 'file'
}

function collectDescendantFolderIds(rootIds: string[], folders: FolderRecord[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const folder of folders) {
    if (folder.parentId === null) continue
    const list = children.get(folder.parentId) ?? []
    list.push(folder.id)
    children.set(folder.parentId, list)
  }

  const result = new Set(rootIds)
  const queue = [...rootIds]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const childId of children.get(id) ?? []) {
      if (result.has(childId)) continue
      result.add(childId)
      queue.push(childId)
    }
  }
  return result
}

function protectedPersonalIds(
  folders: FolderRecord[],
  items: AnyItemRecord[],
  nodes: PersonalSyncNode[],
  outbox: PersonalOutboxRecord[]
): Set<string> {
  const protectedIds = new Set<string>()
  const mappings = new Map(nodes.map((node) => [node.id, node]))
  const records = new Map([...folders, ...items].map((record) => [record.id, record]))
  const cutoff = Date.now() - 30 * 86_400_000
  for (const record of records.values()) {
    const node = mappings.get(record.id)
    if (!record.personalOwnerId && !node) continue
    if (
      !record.deletedAt ||
      record.deletedAt >= cutoff ||
      !node ||
      node.localRevision !== node.syncedLocalRevision
    ) {
      protectedIds.add(record.id)
    }
  }
  for (const operation of outbox) {
    protectedIds.add(operation.nodeId)
    for (const member of operation.subtree ?? []) protectedIds.add(member.nodeId)
  }
  for (const id of [...protectedIds]) {
    let parent = records.get(id)?.parentId
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      protectedIds.add(parent)
      parent = records.get(parent)?.parentId
    }
  }
  return protectedIds
}

export async function listFileResourceCleanupItemIds(request: CleanupRequest): Promise<string[]> {
  const db = await openFileExplorerDB()
  const [folders, items, nodes, outbox] = await Promise.all([
    db.getAll('folder-records'),
    db.getAll('folder-items'),
    db.getAll('personal-sync-nodes'),
    db.getAll('personal-sync-outbox')
  ])
  const protectedIds = protectedPersonalIds(folders, items, nodes, outbox)
  const folderIds = collectDescendantFolderIds(request.folderIds ?? [], folders)
  const requestedItemIds = new Set(request.itemIds ?? [])
  for (const item of items) {
    if (folderIds.has(item.parentId)) requestedItemIds.add(item.id)
  }
  return [...requestedItemIds].filter((id) => !protectedIds.has(id))
}

function makeCleanupRecord(
  blobId: string,
  storage: 'indexed-db' | 'native-fs' | undefined,
  itemThumbnailIds: string[],
  deleteSourceResources: boolean
): ResourceCleanupJournalRecord {
  return createResourceCleanupRecord({
    blobId,
    storage,
    deleteNativeFile: deleteSourceResources && storage === 'native-fs',
    deleteDerivedAssets: deleteSourceResources,
    deletePdfPageThumbs: deleteSourceResources,
    itemThumbnailIds,
    deleteBlobRecord: deleteSourceResources
  })
}

let cleanupTail: Promise<void> = Promise.resolve()

export function cleanupFileResources(request: CleanupRequest): Promise<CleanupResult> {
  const cleanup = cleanupTail.then(() => cleanupFileResourcesSerial(request))
  cleanupTail = cleanup.then(
    () => undefined,
    () => undefined
  )
  return cleanup
}

async function cleanupFileResourcesSerial(request: CleanupRequest): Promise<CleanupResult> {
  const targetItemIds = new Set(await listFileResourceCleanupItemIds(request))
  const lookupDb = await openFileExplorerDB()
  const removedReferencesByBlob = new Map<string, number>()
  for (const itemId of targetItemIds) {
    const item = await lookupDb.get('folder-items', itemId)
    if (!item) continue
    if (!isFileItem(item)) continue
    const blobId = getBlobId(item)
    removedReferencesByBlob.set(blobId, (removedReferencesByBlob.get(blobId) ?? 0) + 1)
  }
  const deletedBlobIds = new Set<string>()
  for (const [blobId, removedReferences] of removedReferencesByBlob) {
    const blob = await lookupDb.get('file-blobs', blobId)
    if (!blob || (blob.refCount ?? 1) <= removedReferences) deletedBlobIds.add(blobId)
  }
  const derivedJobTypes = new Set<MediaJobType>(['cover-thumbnail', 'pdf-pages', 'video-poster'])
  const matchesDeletedSource = (job: MediaJobRecord): boolean =>
    derivedJobTypes.has(job.type) &&
    job.sourceBlobId !== undefined &&
    deletedBlobIds.has(job.sourceBlobId)

  return mediaJobQueue.withCancellationFence(matchesDeletedSource, () =>
    cleanupFileResourcesAfterJobFence(request)
  )
}

async function cleanupFileResourcesAfterJobFence(request: CleanupRequest): Promise<CleanupResult> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(
    [
      'folder-records',
      'folder-items',
      'file-blobs',
      'resource-cleanup-journal',
      'personal-sync-nodes',
      'personal-sync-outbox',
      'catalog-deletions'
    ],
    'readwrite'
  )
  const folderStore = tx.objectStore('folder-records')
  const itemStore = tx.objectStore('folder-items')
  const blobStore = tx.objectStore('file-blobs')
  const journalStore = tx.objectStore('resource-cleanup-journal')
  const nodeStore = tx.objectStore('personal-sync-nodes')
  const [folders, items, nodes, outbox] = await Promise.all([
    folderStore.getAll(),
    itemStore.getAll(),
    nodeStore.getAll(),
    tx.objectStore('personal-sync-outbox').getAll()
  ])
  const protectedIds = protectedPersonalIds(folders, items, nodes, outbox)

  const folderIds = collectDescendantFolderIds(request.folderIds ?? [], folders)
  const requestedItemIds = new Set(request.itemIds ?? [])
  const targetItems = items.filter(
    (item) =>
      !protectedIds.has(item.id) && (requestedItemIds.has(item.id) || folderIds.has(item.parentId))
  )
  for (const id of protectedIds) folderIds.delete(id)

  const blobReferenceRemovals = new Map<string, number>()
  const thumbnailIdsByBlob = new Map<string, string[]>()
  const nonFileThumbnailIds: string[] = []
  for (const item of targetItems) {
    if (!isFileItem(item)) {
      nonFileThumbnailIds.push(item.id)
      continue
    }
    const blobId = getBlobId(item)
    blobReferenceRemovals.set(blobId, (blobReferenceRemovals.get(blobId) ?? 0) + 1)
    thumbnailIdsByBlob.set(blobId, [...(thumbnailIdsByBlob.get(blobId) ?? []), item.id])
  }

  const cleanupRecords: ResourceCleanupJournalRecord[] = []
  for (const blobId of blobReferenceRemovals.keys()) {
    const record = await blobStore.get(blobId)
    const itemThumbnailIds = thumbnailIdsByBlob.get(blobId) ?? []
    if (!record) {
      cleanupRecords.push(makeCleanupRecord(blobId, undefined, itemThumbnailIds, true))
      continue
    }
    const remainingReferences = items.filter(
      (item) =>
        item.type === 'file' &&
        getBlobId(item) === blobId &&
        !targetItems.some((target) => target.id === item.id)
    ).length
    if (remainingReferences <= 0) {
      await blobStore.put({ ...record, refCount: 0 })
      cleanupRecords.push(makeCleanupRecord(blobId, record.storage, itemThumbnailIds, true))
    } else {
      await blobStore.put({ ...record, refCount: remainingReferences })
      cleanupRecords.push(makeCleanupRecord(blobId, record.storage, itemThumbnailIds, false))
    }
  }

  cleanupRecords.push(
    ...nonFileThumbnailIds.map((itemId) => makeCleanupRecord(itemId, undefined, [itemId], false))
  )

  await Promise.all([
    ...[...targetItems.map((item) => item.id), ...folderIds].map((id) =>
      tx.objectStore('catalog-deletions').put({ id, deletedAt: Date.now() })
    ),
    ...targetItems.map((item) => itemStore.delete(item.id)),
    ...targetItems.map((item) => nodeStore.delete(item.id)),
    ...[...folderIds].map((folderId) => folderStore.delete(folderId)),
    ...[...folderIds].map((folderId) => nodeStore.delete(folderId)),
    ...cleanupRecords.map((record) => journalStore.put(record))
  ])
  await tx.done
  publishCatalogDeletion({ folderIds: [...folderIds], itemIds: targetItems.map((item) => item.id) })

  // Catalog deletion is committed. Failed physical cleanup remains in the durable journal.
  await Promise.allSettled(cleanupRecords.map((record) => retryResourceCleanup(record.id)))

  return {
    folderIds: [...folderIds],
    itemIds: targetItems.map((item) => item.id)
  }
}

export async function purgeExpiredFileTrash(
  retentionMs: number,
  now = Date.now()
): Promise<CleanupResult> {
  const db = await openFileExplorerDB()
  const cutoff = now - retentionMs
  const [folders, items] = await Promise.all([
    db.getAll('folder-records'),
    db.getAll('folder-items')
  ])
  return cleanupFileResources({
    folderIds: folders
      .filter((folder) => folder.deletedAt != null && folder.deletedAt < cutoff)
      .map((folder) => folder.id),
    itemIds: items
      .filter((item) => item.deletedAt != null && item.deletedAt < cutoff)
      .map((item) => item.id)
  })
}
