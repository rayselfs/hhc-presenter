import { publishCatalogDeletion } from './file-catalog-events'
import {
  FOLDER_DURATION_MS,
  type AnyItemRecord,
  type FileItemRecord,
  type FolderRecord
} from '@shared/types/folder'
import { openFileExplorerDB } from './file-explorer-db'
import { getBlobId } from './blob-identity'
import { hasNameConflict, resolveUniqueName, validateDisplayName } from './file-naming'
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

export async function restoreLocalCatalogEntry(
  kind: 'folder' | 'file',
  id: string,
  name?: string
): Promise<FolderRecord | FileItemRecord> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(['folder-items', 'folder-records', 'catalog-deletions'], 'readwrite')
  try {
    const record =
      kind === 'folder'
        ? await tx.objectStore('folder-records').get(id)
        : await tx.objectStore('folder-items').get(id)
    if (!record || record.personalOwnerId || ('type' in record && record.type !== 'file'))
      throw new Error('Restore source is unavailable')
    if (!record.deletedAt) throw new Error('Restore source is no longer in trash')
    if (name !== undefined && !validateDisplayName(name.trim()))
      throw new Error('Restore name is invalid')
    if (await tx.objectStore('catalog-deletions').get(id))
      throw new Error('Restore source was deleted')
    let ancestor = record.parentId
    const seen = new Set<string>()
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor)
      if (await tx.objectStore('catalog-deletions').get(ancestor))
        throw new Error('Restore source was deleted')
      ancestor = (await tx.objectStore('folder-records').get(ancestor))?.parentId ?? null
    }
    const folders = await tx.objectStore('folder-records').getAll()
    const originalParent = folders.find(
      (folder) => folder.id === record.originalParentId && !folder.deletedAt
    )
    const parentId = originalParent?.id ?? 'file-root'
    assertLocalDestination(parentId, folders)
    const restored = {
      ...record,
      ...(name ? { name: name.trim() } : {}),
      ...(!('type' in record) ? { isFavorited: false } : {}),
      parentId,
      deletedAt: undefined,
      originalParentId: undefined
    }
    const siblings =
      'type' in restored
        ? (await tx.objectStore('folder-items').index('by-parent').getAll(parentId)).filter(
            (item) => item.type === 'file'
          )
        : folders.filter((folder) => folder.parentId === parentId)
    if (
      hasNameConflict(
        restored.name,
        siblings.filter((entry) => entry.id !== id && !entry.deletedAt).map((entry) => entry.name)
      )
    )
      throw new Error('Restore name already exists')
    if ('type' in restored) await tx.objectStore('folder-items').put(restored)
    else await tx.objectStore('folder-records').put(restored)
    await tx.done
    return restored
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* Already completed. */
    }
    await tx.done.catch(() => undefined)
    throw error
  }
}

export async function updateLocalCatalogEntry(
  kind: 'folder' | 'file',
  id: string,
  updates: { name: string; expiresAt?: number | null }
): Promise<FolderRecord | FileItemRecord> {
  const nextName = updates.name.trim()
  if (!validateDisplayName(nextName)) throw new Error('Rename name is invalid')
  if (
    updates.expiresAt !== undefined &&
    updates.expiresAt !== null &&
    !Number.isFinite(updates.expiresAt)
  )
    throw new Error('Folder expiration is invalid')
  const db = await openFileExplorerDB()
  const tx = db.transaction(['folder-items', 'folder-records', 'catalog-deletions'], 'readwrite')
  try {
    const record =
      kind === 'folder'
        ? await tx.objectStore('folder-records').get(id)
        : await tx.objectStore('folder-items').get(id)
    if (
      !record ||
      record.personalOwnerId ||
      record.deletedAt ||
      !record.parentId ||
      ('type' in record && record.type !== 'file')
    )
      throw new Error('Rename source is unavailable')
    const folders = await tx.objectStore('folder-records').getAll()
    assertLocalDestination(record.parentId, folders)
    if (
      kind === 'folder' &&
      isFolderReadOnlyBySyncLink(
        id,
        Object.fromEntries(folders.map((folder) => [folder.id, folder]))
      )
    )
      throw new Error('Rename source is read-only')
    let ancestor: string | null = id
    const seen = new Set<string>()
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor)
      if (await tx.objectStore('catalog-deletions').get(ancestor))
        throw new Error('Rename source was deleted')
      ancestor =
        ancestor === id
          ? record.parentId
          : ((await tx.objectStore('folder-records').get(ancestor))?.parentId ?? null)
    }
    const siblings =
      kind === 'folder'
        ? folders.filter((folder) => folder.parentId === record.parentId)
        : (await tx.objectStore('folder-items').index('by-parent').getAll(record.parentId)).filter(
            (item) => item.type === 'file'
          )
    if (
      hasNameConflict(
        nextName,
        siblings.filter((entry) => !entry.deletedAt).map((entry) => entry.name),
        { excludeName: record.name }
      )
    )
      throw new Error('Rename name already exists')
    const renamed = { ...record, name: nextName }
    if (!('type' in renamed) && updates.expiresAt !== undefined && !renamed.isFavorited)
      renamed.expiresAt = updates.expiresAt
    if ('type' in renamed) await tx.objectStore('folder-items').put(renamed)
    else await tx.objectStore('folder-records').put(renamed)
    await tx.done
    return renamed
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* Already completed. */
    }
    await tx.done.catch(() => undefined)
    throw error
  }
}

export async function createLocalCatalogFolder(
  name: string,
  parentId: string,
  expiresAt: number | null | undefined,
  isVisible: (folder: FolderRecord) => boolean
): Promise<FolderRecord> {
  if (!validateDisplayName(name)) throw new Error('Folder name is invalid')
  if (expiresAt !== undefined && expiresAt !== null && !Number.isFinite(expiresAt))
    throw new Error('Folder expiration is invalid')
  const db = await openFileExplorerDB()
  const tx = db.transaction(['folder-records', 'catalog-deletions'], 'readwrite')
  try {
    const folders = await tx.objectStore('folder-records').getAll()
    assertLocalDestination(parentId, folders)
    const byId = Object.fromEntries(folders.map((folder) => [folder.id, folder]))
    let ancestor: string | null = parentId
    const seen = new Set<string>()
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor)
      if (await tx.objectStore('catalog-deletions').get(ancestor))
        throw new Error('Folder destination was deleted')
      ancestor = byId[ancestor]?.parentId ?? null
    }
    const siblings = folders.filter(
      (folder) => folder.parentId === parentId && !folder.deletedAt && isVisible(folder)
    )
    const now = Date.now()
    const folder: FolderRecord = {
      id: crypto.randomUUID(),
      parentId,
      name: resolveUniqueName(
        name,
        siblings.map((sibling) => sibling.name)
      ),
      sortIndex: siblings.length,
      createdAt: now,
      expiresAt:
        expiresAt !== undefined
          ? expiresAt
          : parentId === 'file-root'
            ? now + FOLDER_DURATION_MS['1day']
            : (byId[parentId]?.expiresAt ?? null)
    }
    await tx.objectStore('folder-records').add(folder)
    await tx.done
    return folder
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* Already completed. */
    }
    await tx.done.catch(() => undefined)
    throw error
  }
}
