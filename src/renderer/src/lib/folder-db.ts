import type { FolderPersistence } from '@shared/types/folder'
import { openBibleDB } from './bible-db'
import { openFileExplorerDB } from './file-explorer-db'
import { saveCatalogRecords } from './file-catalog-mutations'

type FolderRecordsPersistence = Omit<FolderPersistence, 'deleteExpired' | 'purgeTrashOlderThan'>
export type FolderDB = FolderPersistence

function withMaintenance(
  records: FolderRecordsPersistence,
  loadDeletedItems: (cutoff: number) => ReturnType<FolderPersistence['loadItemsByParent']>
): FolderPersistence {
  return {
    ...records,
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
  const persistence = withMaintenance(records, async (cutoff) => {
    const db = await getDB()
    return (await db.getAll('folder-items')).filter(
      (item) => item.deletedAt != null && item.deletedAt < cutoff
    )
  })
  return {
    ...persistence,
    async deleteExpired(now) {
      const tx = (await getDB()).transaction(['folder-records', 'folder-items'], 'readwrite')
      try {
        const folders = await tx.objectStore('folder-records').getAll()
        const folderIds = new Set(
          folders
            .filter(
              (folder) => folder.id !== rootId && folder.expiresAt != null && folder.expiresAt < now
            )
            .map((folder) => folder.id)
        )
        const children = new Map<string, string[]>()
        for (const folder of folders) {
          if (!folder.parentId || folder.id === rootId) continue
          const siblings = children.get(folder.parentId) ?? []
          siblings.push(folder.id)
          children.set(folder.parentId, siblings)
        }
        for (const id of folderIds) {
          for (const child of children.get(id) ?? []) folderIds.add(child)
        }
        const items = await tx.objectStore('folder-items').getAll()
        const itemIds = items
          .filter(
            (item) =>
              folderIds.has(item.parentId) ||
              (item.parentId === rootId && item.expiresAt != null && item.expiresAt < now)
          )
          .map((item) => item.id)
        await Promise.all([
          ...[...folderIds].map((id) => tx.objectStore('folder-records').delete(id)),
          ...itemIds.map((id) => tx.objectStore('folder-items').delete(id)),
          tx.done
        ])
        return { folderIds: [...folderIds], itemIds }
      } catch (error) {
        try {
          tx.abort()
        } catch {
          /* The transaction may already have aborted. */
        }
        await tx.done.catch(() => undefined)
        throw error
      }
    }
  }
}

export function createFileExplorerFolderDB(): FolderPersistence {
  const getDB = openFileExplorerDB
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
  return withMaintenance(records, async (cutoff) => {
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
