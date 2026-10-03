import type { PresentationDraftRecord } from './presentation-drafts'
import type { DBSchema, IDBPDatabase } from 'idb'
import { openDB, unwrap } from 'idb'
import type { AnyItemRecord, FolderRecord } from '@shared/types/folder'
import { isElectron } from './env'
import type { PersonalOutboxRecord, PersonalSyncNode, PersonalSyncState } from './personal-sync-db'

export interface FileBlobRecord {
  id: string
  blob?: Blob
  storage?: 'indexed-db' | 'native-fs'
  size?: number
  refCount?: number
  revision?: number
}

export interface ResourceCleanupJournalRecord {
  id: string
  blobId: string
  storage?: 'indexed-db' | 'native-fs'
  deleteNativeFile: boolean
  deleteDerivedAssets: boolean
  deletePdfPageThumbs: boolean
  itemThumbnailIds: string[]
  status: 'pending' | 'failed'
  attempt: number
  lastError?: string
  createdAt: number
  updatedAt: number
  stagingLock?: string
}

export interface FileExplorerDBSchema extends DBSchema {
  'presentation-drafts': { key: string; value: PresentationDraftRecord }
  'personal-sync-outbox': {
    key: string
    value: PersonalOutboxRecord
    indexes: { 'by-owner': string }
  }
  'personal-sync-nodes': {
    key: string
    value: PersonalSyncNode
    indexes: { 'by-owner': string }
  }
  'personal-sync-state': {
    key: string
    value: PersonalSyncState
  }
  'file-blobs': {
    key: string
    value: FileBlobRecord
  }
  'folder-records': {
    key: string
    value: FolderRecord
    indexes: { 'by-parent': string }
  }
  'folder-items': {
    key: string
    value: AnyItemRecord
    indexes: { 'by-parent': string; 'by-deleted-at': number }
  }
  'resource-cleanup-journal': {
    key: string
    value: ResourceCleanupJournalRecord
  }
}

const DB_NAME = 'hhc-file-explorer'
export const FILE_EXPLORER_DB_VERSION = 7

let fileExplorerDBPromise: Promise<IDBPDatabase<FileExplorerDBSchema>> | null = null

function getFileExplorerDB(): Promise<IDBPDatabase<FileExplorerDBSchema>> {
  if (!fileExplorerDBPromise) {
    fileExplorerDBPromise = openDB<FileExplorerDBSchema>(DB_NAME, FILE_EXPLORER_DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains('presentation-drafts'))
          db.createObjectStore('presentation-drafts', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('personal-sync-outbox')) {
          db.createObjectStore('personal-sync-outbox', { keyPath: 'id' }).createIndex(
            'by-owner',
            'ownerId'
          )
        }
        if (!db.objectStoreNames.contains('personal-sync-nodes')) {
          db.createObjectStore('personal-sync-nodes', { keyPath: 'id' }).createIndex(
            'by-owner',
            'ownerId'
          )
        }
        if (!db.objectStoreNames.contains('personal-sync-state')) {
          db.createObjectStore('personal-sync-state', { keyPath: 'ownerId' })
        }
        if (!db.objectStoreNames.contains('file-blobs')) {
          db.createObjectStore('file-blobs', { keyPath: 'id' })
        }

        if (!db.objectStoreNames.contains('folder-records')) {
          const folderRecordStore = db.createObjectStore('folder-records', { keyPath: 'id' })
          folderRecordStore.createIndex('by-parent', 'parentId')
        }

        if (!db.objectStoreNames.contains('folder-items')) {
          const folderItemStore = db.createObjectStore('folder-items', { keyPath: 'id' })
          folderItemStore.createIndex('by-parent', 'parentId')
        }

        if (oldVersion < 2) {
          const nativeDb: IDBDatabase = unwrap(db)
          if (nativeDb.objectStoreNames.contains('folders')) nativeDb.deleteObjectStore('folders')
          if (nativeDb.objectStoreNames.contains('items')) nativeDb.deleteObjectStore('items')
        }

        if (oldVersion < 4) {
          const itemStore = tx.objectStore('folder-items')
          if (!itemStore.indexNames.contains('by-deleted-at')) {
            itemStore.createIndex('by-deleted-at', 'deletedAt')
          }
        }

        if (!db.objectStoreNames.contains('resource-cleanup-journal')) {
          db.createObjectStore('resource-cleanup-journal', { keyPath: 'id' })
        }
      }
    })
  }

  return fileExplorerDBPromise
}

export async function openFileExplorerDB(): Promise<IDBPDatabase<FileExplorerDBSchema>> {
  return getFileExplorerDB()
}

export async function listFileBlobRecords(): Promise<FileBlobRecord[]> {
  return (await getFileExplorerDB()).getAll('file-blobs')
}

export async function getFileBlobRecord(id: string): Promise<FileBlobRecord | undefined> {
  return (await getFileExplorerDB()).get('file-blobs', id)
}

export async function isFileBlobRecordAvailable(
  record: FileBlobRecord | undefined
): Promise<boolean> {
  if (!record) return false
  if (record.storage === 'native-fs') {
    if (!isElectron()) return false
    return window.api.nativeFs.exists(record.id)
  }
  return Boolean(record.blob)
}

export async function isFileBlobAvailable(id: string): Promise<boolean> {
  return isFileBlobRecordAvailable(await getFileBlobRecord(id))
}

export async function collectAvailableFileBlobIds(records: FileBlobRecord[]): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const record of records) {
    if (await isFileBlobRecordAvailable(record)) ids.add(record.id)
  }
  return ids
}

export async function storeFileBlob(
  db: IDBPDatabase<FileExplorerDBSchema>,
  id: string,
  file: File
): Promise<void> {
  if (isElectron()) {
    const imported = await window.api.nativeFs.importFile(id, file)
    try {
      await db.put('file-blobs', {
        id,
        storage: 'native-fs',
        size: imported.size,
        refCount: 1
      })
    } catch (error) {
      await window.api.nativeFs.delete(id).catch(() => undefined)
      throw error
    }
    return
  }

  await db.put('file-blobs', { id, blob: file, refCount: 1 })
}

export async function getFileBlob(
  db: IDBPDatabase<FileExplorerDBSchema>,
  id: string
): Promise<Blob | null> {
  const record = await db.get('file-blobs', id)
  return record?.blob ?? null
}

export interface FileSource {
  url: string
  revoke: () => void
}

export interface GetFileSourceOptions {
  verifyNativeFile?: boolean
}

export async function getFileSource(
  db: IDBPDatabase<FileExplorerDBSchema>,
  id: string,
  mimeType: string,
  options: GetFileSourceOptions = {}
): Promise<FileSource | null> {
  const record = await db.get('file-blobs', id)
  if (!record) return null

  if (record.storage !== 'native-fs' || options.verifyNativeFile !== false) {
    if (!(await isFileBlobRecordAvailable(record))) return null
  }

  if (record.storage === 'native-fs') {
    return {
      url: window.api.nativeFs.getUrl(id, mimeType),
      revoke: () => undefined
    }
  }

  if (!record.blob) return null
  const url = URL.createObjectURL(record.blob)
  return {
    url,
    revoke: () => URL.revokeObjectURL(url)
  }
}

export async function deleteFileBlob(
  db: IDBPDatabase<FileExplorerDBSchema>,
  id: string
): Promise<boolean> {
  const record = await db.get('file-blobs', id)
  if (!record) return false

  if (record.refCount === undefined || record.refCount <= 1) {
    if (record.storage === 'native-fs' && isElectron()) {
      await window.api.nativeFs.delete(id)
    }
    await db.delete('file-blobs', id)
    return true
  }

  await db.put('file-blobs', { ...record, refCount: record.refCount - 1 })
  return false
}

export async function incrementBlobRef(
  db: IDBPDatabase<FileExplorerDBSchema>,
  id: string
): Promise<void> {
  const record = await db.get('file-blobs', id)
  if (!record) throw new Error(`File blob not found: ${id}`)

  await db.put('file-blobs', { ...record, refCount: (record.refCount ?? 1) + 1 })
}

export async function resetFileExplorerDB(): Promise<void> {
  const db = await fileExplorerDBPromise
  db?.close()
  fileExplorerDBPromise = null
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('File explorer database deletion blocked'))
  })
}

export const resetFileExplorerDBForTests = resetFileExplorerDB
