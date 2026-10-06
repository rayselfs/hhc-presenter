import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileItemRecord } from '@shared/types/folder'

const { deleteNative } = vi.hoisted(() => ({ deleteNative: vi.fn() }))
vi.mock('../env', () => ({ isElectron: () => true }))

import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  createResourceCleanupRecord,
  retryPendingResourceCleanups
} from '../resource-cleanup-journal'
import { createPersistenceOperationQueue } from '../persistence-operation-queue'
import { saveCatalogRecords } from '../file-catalog-mutations'
import { cleanupFileResources } from '../file-resource-cleanup'
import { lockMediaResources, resetMediaResourceLocksForTests } from '../media-resource-locks'

const sourceId = '123e4567-e89b-42d3-a456-426614174000'
const item: FileItemRecord = {
  id: 'original',
  parentId: 'file-root',
  type: 'file',
  name: 'clip.mp4',
  mimeType: 'video/mp4',
  url: `blob:${sourceId}`,
  size: 10,
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null
}

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  resetMediaResourceLocksForTests()
  deleteNative.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { nativeFs: { delete: deleteNative } }
  })
})

afterEach(() => {
  resetMediaResourceLocksForTests()
})

it('reclaims a crashed native import even when no blob or catalog record was committed', async () => {
  const db = await openFileExplorerDB()
  const record = createResourceCleanupRecord({
    blobId: sourceId,
    storage: 'native-fs',
    stagingLock: `local-blob:${sourceId}`,
    deleteNativeFile: true,
    deleteBlobRecord: true,
    deleteDerivedAssets: false,
    deletePdfPageThumbs: false,
    itemThumbnailIds: []
  })
  await db.put('resource-cleanup-journal', record)
  expect(await db.get('file-blobs', sourceId)).toBeUndefined()
  deleteNative.mockRejectedValueOnce(new Error('File is busy'))
  expect(await retryPendingResourceCleanups()).toEqual({ attempted: 1, failed: 1 })
  expect((await db.get('resource-cleanup-journal', record.id))?.status).toBe('failed')
  expect(await retryPendingResourceCleanups()).toEqual({ attempted: 1, failed: 0 })
  expect(deleteNative).toHaveBeenLastCalledWith(sourceId)
  expect(await db.get('resource-cleanup-journal', record.id)).toBeUndefined()
})

it('retries a previously failed metadata queue without resurrecting a purged UUID', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-items', item)
  await db.put('file-blobs', { id: sourceId, storage: 'native-fs', size: 10, refCount: 1 })
  let fail = true
  const queue = createPersistenceOperationQueue()
  queue.enqueue(async () => {
    if (fail) throw new Error('temporarily unavailable')
    await saveCatalogRecords('folder-items', [{ ...item, name: 'stale name' }])
  })
  await vi.waitFor(() => expect(queue.snapshot().status).toBe('failed'))
  await cleanupFileResources({ itemIds: [item.id] })
  fail = false
  await queue.retry()
  expect(queue.snapshot().status).toBe('idle')
  expect(await db.get('folder-items', item.id)).toBeUndefined()
  expect(await db.get('file-blobs', sourceId)).toBeUndefined()
})

it('recovers deferred deletion after all renderer-local locks disappear on restart', async () => {
  const db = await openFileExplorerDB()
  await db.put('folder-items', item)
  await db.put('file-blobs', { id: sourceId, storage: 'native-fs', size: 10, refCount: 1 })
  lockMediaResources([sourceId])
  await cleanupFileResources({ itemIds: [item.id] })
  expect(deleteNative).not.toHaveBeenCalled()
  expect(await db.get('folder-items', item.id)).toBeUndefined()
  expect(await db.count('resource-cleanup-journal')).toBeGreaterThan(0)
  resetMediaResourceLocksForTests()
  await retryPendingResourceCleanups()
  expect(deleteNative).toHaveBeenCalledWith(sourceId)
  expect(await db.get('file-blobs', sourceId)).toBeUndefined()
  expect(await db.count('resource-cleanup-journal')).toBe(0)
})

it('does not recover a staging journal until the importing context releases its lock', async () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let finishImport: (() => void) | undefined
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(
        (_name: string, operation: () => Promise<void>) =>
          new Promise<void>((resolve, reject) => {
            finishImport = () => {
              operation().then(resolve, reject)
            }
          })
      )
    }
  })
  try {
    const db = await openFileExplorerDB()
    const record = createResourceCleanupRecord({
      blobId: sourceId,
      storage: 'native-fs',
      stagingLock: `local-blob:${sourceId}`,
      deleteNativeFile: true,
      deleteBlobRecord: true,
      deleteDerivedAssets: false,
      deletePdfPageThumbs: false,
      itemThumbnailIds: []
    })
    await db.put('resource-cleanup-journal', record)
    const recovery = retryPendingResourceCleanups()
    await vi.waitFor(() => expect(finishImport).toBeDefined())
    expect(deleteNative).not.toHaveBeenCalled()
    // The other context completes its commit and retires staging intent before releasing.
    await db.delete('resource-cleanup-journal', record.id)
    finishImport?.()
    await recovery
    expect(deleteNative).not.toHaveBeenCalled()
  } finally {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})
