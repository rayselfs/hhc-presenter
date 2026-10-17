import type { FolderPersistence } from '@shared/types/folder'
import { openBibleDB } from './bible-db'
import { openFileExplorerDB } from './file-explorer-db'
import { saveCatalogRecords } from './file-catalog-mutations'

type FolderRecordsPersistence = Omit<
  FolderPersistence,
  'deleteExpiredFolders' | 'deleteExpiredItems' | 'purgeTrashOlderThan'
>
export type FolderDB = FolderPersistence

function withMaintenance(
  records: FolderRecordsPersistence,
  rootId: string,
  loadDeletedItems: (cutoff: number) => ReturnType<FolderPersistence['loadItemsByParent']>
): FolderPersistence {
  return {
    ...records,
    async deleteExpiredFolders(now) {
      const expired = (await records.loadAllFolders()).filter(
        (folder) => folder.expiresAt != null && folder.expiresAt < now
      )
      const ids = expired.map((folder) => folder.id)
      if (ids.length) await records.deleteFolders(ids)
      return ids
    },
    async deleteExpiredItems(now) {
      const expired = (await records.loadItemsByParent(rootId)).filter(
        (item) => item.expiresAt != null && item.expiresAt < now
      )
      const ids = expired.map((item) => item.id)
      if (ids.length) await records.deleteItems(ids)
      return ids
    },
    async purgeTrashOlderThan(now, retentionMs) {
      const cutoff = now - retentionMs
      const expiredFolders = (await records.loadAllFolders()).filter(
        (folder) => folder.deletedAt != null && folder.deletedAt < cutoff
      )
      const expiredItems = await loadDeletedItems(cutoff)
      const folderIds = expiredFolders.map((folder) => folder.id)
      const itemIds = expiredItems.map((item) => item.id)
      for (const id of folderIds) await records.deleteItemsByParent(id)
      if (folderIds.length) await records.deleteFolders(folderIds)
      if (itemIds.length) await records.deleteItems(itemIds)
      return { folderIds, itemIds }
    }
  }
}

export function createBibleFolderDB(
  getDB: typeof openBibleDB = openBibleDB,
  rootId = 'bible-root'
): FolderPersistence {
  const records: FolderRecordsPersistence = {
    async loadAllFolders() {
      return (await getDB()).getAll('folder-records')
    },
    async loadItemsByParent(parentId) {
      return (await getDB()).getAllFromIndex('folder-items', 'by-parent', parentId)
    },
    async saveFolder(record) {
      await (await getDB()).put('folder-records', record)
    },
    async saveFolders(values) {
      const tx = (await getDB()).transaction('folder-records', 'readwrite')
      await Promise.all([...values.map((value) => tx.store.put(value)), tx.done])
    },
    async deleteFolders(ids) {
      const tx = (await getDB()).transaction('folder-records', 'readwrite')
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
    },
    async saveItem(record) {
      await (await getDB()).put('folder-items', record)
    },
    async saveItems(values) {
      const tx = (await getDB()).transaction('folder-items', 'readwrite')
      await Promise.all([...values.map((value) => tx.store.put(value)), tx.done])
    },
    async deleteItems(ids) {
      const tx = (await getDB()).transaction('folder-items', 'readwrite')
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
    },
    async deleteItem(id) {
      await (await getDB()).delete('folder-items', id)
    },
    async deleteItemsByParent(parentId) {
      const db = await getDB()
      const ids = await db.getAllKeysFromIndex('folder-items', 'by-parent', parentId)
      const tx = db.transaction('folder-items', 'readwrite')
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
    }
  }
  return withMaintenance(records, rootId, async (cutoff) => {
    const db = await getDB()
    return (await db.getAll('folder-items')).filter(
      (item) => item.deletedAt != null && item.deletedAt < cutoff
    )
  })
}

export function createFileExplorerFolderDB(): FolderPersistence {
  const getDB = openFileExplorerDB
  const rootId = 'file-root'
  const records: FolderRecordsPersistence = {
    async loadAllFolders() {
      return (await getDB()).getAll('folder-records')
    },
    async loadItemsByParent(parentId) {
      return (await getDB()).getAllFromIndex('folder-items', 'by-parent', parentId)
    },
    async saveFolder(record) {
      await saveCatalogRecords('folder-records', [record])
    },
    async saveFolders(values) {
      await saveCatalogRecords('folder-records', values)
    },
    async deleteFolders(ids) {
      const tx = (await getDB()).transaction('folder-records', 'readwrite')
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
    },
    async saveItem(record) {
      await saveCatalogRecords('folder-items', [record])
    },
    async saveItems(values) {
      await saveCatalogRecords('folder-items', values)
    },
    async deleteItems(ids) {
      const tx = (await getDB()).transaction('folder-items', 'readwrite')
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
    },
    async deleteItem(id) {
      await (await getDB()).delete('folder-items', id)
    },
    async deleteItemsByParent(parentId) {
      const db = await getDB()
      const ids = await db.getAllKeysFromIndex('folder-items', 'by-parent', parentId)
      const tx = db.transaction('folder-items', 'readwrite')
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
    }
  }
  return withMaintenance(records, rootId, async (cutoff) => {
    const db = await getDB()
    try {
      return (
        await db.getAllFromIndex('folder-items', 'by-deleted-at', IDBKeyRange.upperBound(cutoff))
      ).filter((item) => item.deletedAt != null)
    } catch {
      return (await db.getAll('folder-items')).filter(
        (item) => item.deletedAt != null && item.deletedAt < cutoff
      )
    }
  })
}
