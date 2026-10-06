import { saveCatalogRecords } from './file-catalog-mutations'
import type { FolderRecord, AnyItemRecord } from '@shared/types/folder'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = any

export type FolderDB = ReturnType<typeof createFolderDB>

export function createFolderDB(
  getDB: () => Promise<AnyDB>,
  rootId: string
): {
  loadAllFolders: () => Promise<FolderRecord[]>
  saveFolder: (folder: FolderRecord) => Promise<void>
  saveFolders: (folders: FolderRecord[]) => Promise<void>
  deleteFolders: (ids: string[]) => Promise<void>
  loadItemsByParent: (parentId: string) => Promise<AnyItemRecord[]>
  saveItem: (item: AnyItemRecord) => Promise<void>
  saveItems: (items: AnyItemRecord[]) => Promise<void>
  deleteItem: (id: string) => Promise<void>
  deleteItems: (ids: string[]) => Promise<void>
  deleteItemsByParent: (parentId: string) => Promise<void>
  deleteExpiredFolders: (now: number) => Promise<string[]>
  deleteExpiredItems: (now: number) => Promise<string[]>
  purgeTrashOlderThan: (
    now: number,
    retentionMs: number
  ) => Promise<{ folderIds: string[]; itemIds: string[] }>
} {
  async function loadAllFolders(): Promise<FolderRecord[]> {
    try {
      const db = await getDB()
      return await db.getAll('folder-records')
    } catch (error) {
      console.error('[folder-db] Failed to load folders:', error)
      throw error
    }
  }

  async function saveFolder(folder: FolderRecord): Promise<void> {
    if (rootId === 'file-root') return saveCatalogRecords('folder-records', [folder])
    try {
      const db = await getDB()
      await db.put('folder-records', folder)
    } catch (error) {
      console.error('[folder-db] Failed to save folder:', error)
      throw error
    }
  }

  async function saveFolders(folders: FolderRecord[]): Promise<void> {
    if (rootId === 'file-root') return saveCatalogRecords('folder-records', folders)
    try {
      const db = await getDB()
      const tx = db.transaction('folder-records', 'readwrite')
      await Promise.all([...folders.map((f: FolderRecord) => tx.store.put(f)), tx.done])
    } catch (error) {
      console.error('[folder-db] Failed to save folders:', error)
      throw error
    }
  }

  async function deleteFolders(ids: string[]): Promise<void> {
    try {
      const db = await getDB()
      const tx = db.transaction('folder-records', 'readwrite')
      await Promise.all([...ids.map((id: string) => tx.store.delete(id)), tx.done])
    } catch (error) {
      console.error('[folder-db] Failed to delete folders:', error)
      throw error
    }
  }

  async function loadItemsByParent(parentId: string): Promise<AnyItemRecord[]> {
    try {
      const db = await getDB()
      return await db.getAllFromIndex('folder-items', 'by-parent', parentId)
    } catch (error) {
      console.error('[folder-db] Failed to load items:', error)
      throw error
    }
  }

  async function saveItem(item: AnyItemRecord): Promise<void> {
    if (rootId === 'file-root') return saveCatalogRecords('folder-items', [item])
    try {
      const db = await getDB()
      await db.put('folder-items', item)
    } catch (error) {
      console.error('[folder-db] Failed to save item:', error)
      throw error
    }
  }

  async function saveItems(items: AnyItemRecord[]): Promise<void> {
    if (rootId === 'file-root') return saveCatalogRecords('folder-items', items)
    try {
      const db = await getDB()
      const tx = db.transaction('folder-items', 'readwrite')
      await Promise.all([...items.map((i: AnyItemRecord) => tx.store.put(i)), tx.done])
    } catch (error) {
      console.error('[folder-db] Failed to save items:', error)
      throw error
    }
  }

  async function deleteItem(id: string): Promise<void> {
    try {
      const db = await getDB()
      await db.delete('folder-items', id)
    } catch (error) {
      console.error('[folder-db] Failed to delete item:', error)
      throw error
    }
  }

  async function deleteItems(ids: string[]): Promise<void> {
    try {
      const db = await getDB()
      const tx = db.transaction('folder-items', 'readwrite')
      await Promise.all([...ids.map((id: string) => tx.store.delete(id)), tx.done])
    } catch (error) {
      console.error('[folder-db] Failed to delete items:', error)
      throw error
    }
  }

  async function deleteItemsByParent(parentId: string): Promise<void> {
    try {
      const db = await getDB()
      const items = await db.getAllKeysFromIndex('folder-items', 'by-parent', parentId)
      const tx = db.transaction('folder-items', 'readwrite')
      await Promise.all([...items.map((key: string) => tx.store.delete(key)), tx.done])
    } catch (error) {
      console.error('[folder-db] Failed to delete items by parent:', error)
      throw error
    }
  }

  async function deleteExpiredFolders(now: number): Promise<string[]> {
    try {
      const all = await loadAllFolders()
      const expired = all.filter((f) => f.expiresAt != null && f.expiresAt < now)
      if (expired.length === 0) return []
      const ids = expired.map((f) => f.id)
      await deleteFolders(ids)
      return ids
    } catch (error) {
      console.error('[folder-db] Failed to delete expired folders:', error)
      throw error
    }
  }

  async function deleteExpiredItems(now: number): Promise<string[]> {
    try {
      const db = await getDB()
      const items: AnyItemRecord[] = await db.getAllFromIndex('folder-items', 'by-parent', rootId)
      const expired = items.filter((i) => i.expiresAt != null && i.expiresAt < now)
      if (expired.length === 0) return []
      const ids = expired.map((i) => i.id)
      await deleteItems(ids)
      return ids
    } catch (error) {
      console.error('[folder-db] Failed to delete expired items:', error)
      throw error
    }
  }

  async function purgeTrashOlderThan(
    now: number,
    retentionMs: number
  ): Promise<{ folderIds: string[]; itemIds: string[] }> {
    try {
      const cutoff = now - retentionMs
      const allFolders = await loadAllFolders()
      const expiredFolders = allFolders.filter((f) => f.deletedAt != null && f.deletedAt < cutoff)
      const db = await getDB()

      let expiredItems: AnyItemRecord[]
      try {
        const range = IDBKeyRange.upperBound(cutoff)
        expiredItems = await db.getAllFromIndex('folder-items', 'by-deleted-at', range)
        expiredItems = expiredItems.filter((i) => i.deletedAt != null)
      } catch {
        // Index not available (e.g. bible-db) — full scan fallback
        const allItems: AnyItemRecord[] = await db.getAll('folder-items')
        expiredItems = allItems.filter((i) => i.deletedAt != null && i.deletedAt < cutoff)
      }

      const folderIds = expiredFolders.map((f) => f.id)
      const itemIds = expiredItems.map((i) => i.id)
      if (folderIds.length > 0) {
        for (const fid of folderIds) await deleteItemsByParent(fid)
        await deleteFolders(folderIds)
      }
      if (itemIds.length > 0) await deleteItems(itemIds)
      return { folderIds, itemIds }
    } catch (error) {
      console.error('[folder-db] Failed to purge trash:', error)
      throw error
    }
  }

  return {
    loadAllFolders,
    saveFolder,
    saveFolders,
    deleteFolders,
    loadItemsByParent,
    saveItem,
    saveItems,
    deleteItem,
    deleteItems,
    deleteItemsByParent,
    deleteExpiredFolders,
    deleteExpiredItems,
    purgeTrashOlderThan
  }
}
