import { publishCatalogDeletion } from './file-catalog-events'
import type { AnyItemRecord, FileItemRecord, FolderRecord } from '@shared/types/folder'
import { openFileExplorerDB } from './file-explorer-db'
import { getBlobId } from './blob-identity'
import { isFolderReadOnlyBySyncLink } from './sync-readonly'

export function assertLocalDestination(parentId: string, folders: FolderRecord[]): void {
  const byId = Object.fromEntries(folders.map((folder) => [folder.id, folder]))
  const seen = new Set<string>()
  let id: string | null = parentId
  while (id && id !== 'file-root') {
    const folder: FolderRecord | undefined = byId[id]
    if (!folder || folder.deletedAt || folder.personalOwnerId || seen.has(id))
      throw new Error('File destination is unavailable')
    seen.add(id)
    id = folder.parentId
  }
  if (id !== 'file-root' || isFolderReadOnlyBySyncLink(parentId, byId))
    throw new Error('File destination is unavailable')
}

// Deleted UUIDs remain tombstoned so a failed write in another tab cannot revive them.
export async function saveCatalogRecords(
  kind: 'folder-items' | 'folder-records',
  records: Array<AnyItemRecord | FolderRecord>
): Promise<void> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(['folder-items', 'folder-records', 'catalog-deletions'], 'readwrite')
  const rejectedIds: string[] = []
  for (const record of records) {
    if (await tx.objectStore('catalog-deletions').get(record.id)) {
      rejectedIds.push(record.id)
      continue
    }
    let parent = record.parentId
    const seen = new Set<string>()
    let deleted = false
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      if (await tx.objectStore('catalog-deletions').get(parent)) {
        deleted = true
        break
      }
      parent = (await tx.objectStore('folder-records').get(parent))?.parentId ?? null
    }
    if (deleted) {
      rejectedIds.push(record.id)
      continue
    }
    if (kind === 'folder-items') await tx.objectStore('folder-items').put(record as AnyItemRecord)
    else await tx.objectStore('folder-records').put(record as FolderRecord)
  }
  await tx.done
  if (rejectedIds.length)
    publishCatalogDeletion({
      folderIds: kind === 'folder-records' ? rejectedIds : [],
      itemIds: kind === 'folder-items' ? rejectedIds : []
    })
}

export async function commitLocalFileItem(
  item: FileItemRecord,
  options: { copyFromId?: string; stagingCleanupId?: string } = {}
): Promise<void> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(
    [
      'folder-records',
      'folder-items',
      'file-blobs',
      'catalog-deletions',
      'resource-cleanup-journal'
    ],
    'readwrite'
  )
  try {
    assertLocalDestination(item.parentId, await tx.objectStore('folder-records').getAll())
    if (await tx.objectStore('catalog-deletions').get(item.id))
      throw new Error('File has been deleted')
    if (options.copyFromId) {
      const source = await tx.objectStore('folder-items').get(options.copyFromId)
      if (source?.type !== 'file' || getBlobId(source) !== getBlobId(item))
        throw new Error('File source is unavailable')
      // Personal-cloud conflict recovery intentionally backs up deleted snapshots.
      if (!source.personalOwnerId) {
        if (source.deletedAt) throw new Error('File source was deleted')
        let parent = source.parentId
        const seen = new Set<string>()
        while (parent && parent !== 'file-root') {
          const folder: FolderRecord | undefined = await tx
            .objectStore('folder-records')
            .get(parent)
          if (!folder || folder.deletedAt || seen.has(parent))
            throw new Error('File source was deleted')
          seen.add(parent)
          parent = folder.parentId ?? 'file-root'
        }
      }
    }
    const blob = await tx.objectStore('file-blobs').get(getBlobId(item))
    if (!blob) throw new Error('File source is unavailable')
    if (options.copyFromId)
      await tx.objectStore('file-blobs').put({ ...blob, refCount: (blob.refCount ?? 1) + 1 })
    await tx.objectStore('folder-items').add(item)
    if (options.stagingCleanupId)
      await tx.objectStore('resource-cleanup-journal').delete(options.stagingCleanupId)
    await tx.done
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* The transaction may have already aborted. */
    }
    await tx.done.catch(() => undefined)
    throw error
  }
}
