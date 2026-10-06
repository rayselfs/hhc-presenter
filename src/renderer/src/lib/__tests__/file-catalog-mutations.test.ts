import { beforeEach, expect, it } from 'vitest'
import { openDB } from 'idb'
import { Blob as NodeBlob } from 'node:buffer'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { commitLocalFileItem, saveCatalogRecords } from '../file-catalog-mutations'
import { cleanupFileResources } from '../file-resource-cleanup'
import type { FileItemRecord } from '@shared/types/folder'

const item = (id: string, parentId = 'file-root'): FileItemRecord => ({
  id,
  parentId,
  type: 'file',
  name: `${id}.jpg`,
  mimeType: 'image/jpeg',
  url: 'blob:source',
  size: 1,
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null
})

beforeEach(async () => {
  await resetFileExplorerDBForTests()
})

it('rejects an import into a trashed destination before publishing metadata', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-records', {
    id: 'folder',
    parentId: 'file-root',
    name: 'Folder',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    deletedAt: 2
  })
  await db.put('file-blobs', { id: 'source', blob: new Blob(['x']), refCount: 1 })
  await expect(commitLocalFileItem(item('new', 'folder'))).rejects.toThrow('destination')
  expect(await db.get('folder-items', 'new')).toBeUndefined()
})

it('never resurrects permanently deleted items from stale queued writes', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-items', item('original'))
  await db.put('file-blobs', { id: 'source', blob: new Blob(['x']), refCount: 1 })
  await cleanupFileResources({ itemIds: ['original'] })
  await saveCatalogRecords('folder-items', [item('original')])
  expect(await db.get('folder-items', 'original')).toBeUndefined()
})

it('atomically counts concurrent copies and retains the surviving source', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-items', item('original'))
  await db.put('file-blobs', { id: 'source', blob: new Blob(['x']), refCount: 1 })
  await Promise.all(
    ['copy-a', 'copy-b'].map((id) => commitLocalFileItem(item(id), { copyFromId: 'original' }))
  )
  expect((await db.get('file-blobs', 'source'))?.refCount).toBe(3)
  await cleanupFileResources({ itemIds: ['original', 'copy-a'] })
  expect(await db.get('folder-items', 'copy-b')).toBeDefined()
  expect((await db.get('file-blobs', 'source'))?.refCount).toBe(1)
})

it('does not increment references when a copy destination is invalid', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-items', item('original'))
  await db.put('file-blobs', { id: 'source', blob: new Blob(['x']), refCount: 1 })
  await expect(
    commitLocalFileItem(item('copy', 'missing'), { copyFromId: 'original' })
  ).rejects.toThrow()
  expect((await db.get('file-blobs', 'source'))?.refCount).toBe(1)
})

it('upgrades a version 7 catalog without losing files, outbox work or cleanup intents', async () => {
  const legacy = await openDB('hhc-file-explorer', 7, {
    upgrade(db) {
      db.createObjectStore('folder-records', { keyPath: 'id' }).createIndex('by-parent', 'parentId')
      const items = db.createObjectStore('folder-items', { keyPath: 'id' })
      items.createIndex('by-parent', 'parentId')
      items.createIndex('by-deleted-at', 'deletedAt')
      db.createObjectStore('file-blobs', { keyPath: 'id' })
      db.createObjectStore('resource-cleanup-journal', { keyPath: 'id' })
      db.createObjectStore('personal-sync-outbox', { keyPath: 'id' }).createIndex(
        'by-owner',
        'ownerId'
      )
    }
  })
  await legacy.put('folder-items', item('preserved'))
  await legacy.put('file-blobs', { id: 'source', blob: new NodeBlob(['original']), refCount: 1 })
  await legacy.put('personal-sync-outbox', {
    id: 'pending-upload',
    ownerId: 'owner',
    status: 'pending'
  })
  await legacy.put('resource-cleanup-journal', {
    id: 'pending-cleanup',
    blobId: 'orphan',
    status: 'pending'
  })
  legacy.close()
  const upgraded = await openFileExplorerDB()
  expect(upgraded.version).toBe(8)
  expect(upgraded.objectStoreNames.contains('catalog-deletions')).toBe(true)
  expect(await upgraded.get('folder-items', 'preserved')).toEqual(item('preserved'))
  expect((await upgraded.get('file-blobs', 'source'))?.blob?.size).toBe(8)
  expect(await upgraded.get('personal-sync-outbox', 'pending-upload')).toMatchObject({
    ownerId: 'owner',
    status: 'pending'
  })
  expect(await upgraded.get('resource-cleanup-journal', 'pending-cleanup')).toMatchObject({
    blobId: 'orphan',
    status: 'pending'
  })
})
