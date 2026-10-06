import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  envState,
  mockDeleteThumbnail,
  mockDeletePdfPageThumbs,
  mockDeleteDerivedAssets,
  mockDeleteNativeFile,
  mockCancelAndWait,
  mockWithCancellationFence
} = vi.hoisted(() => ({
  envState: { isElectron: false },
  mockDeleteThumbnail: vi.fn(),
  mockDeletePdfPageThumbs: vi.fn(),
  mockDeleteDerivedAssets: vi.fn(),
  mockDeleteNativeFile: vi.fn(),
  mockCancelAndWait: vi.fn(
    async (
      _predicate: (job: { type: string; itemId?: string; sourceBlobId?: string }) => boolean
    ) => 0
  ),
  mockWithCancellationFence: vi.fn(
    async <T>(
      predicate: (job: { type: string; itemId?: string; sourceBlobId?: string }) => boolean,
      operation: () => Promise<T>
    ) => {
      await mockCancelAndWait(predicate)
      return operation()
    }
  )
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => envState.isElectron
}))

vi.mock('@renderer/lib/thumbnail-db', () => ({
  deleteThumbnail: mockDeleteThumbnail,
  deletePdfPageThumbs: mockDeletePdfPageThumbs
}))

vi.mock('@renderer/lib/media-work-db', () => ({
  deleteDerivedAssetsForSource: mockDeleteDerivedAssets,
  listMediaJobs: vi.fn(async () => [])
}))

vi.mock('@renderer/lib/media-job-queue', () => ({
  mediaJobQueue: {
    cancelAndWait: mockCancelAndWait,
    withCancellationFence: mockWithCancellationFence
  }
}))

import {
  cleanupFileResources,
  listFileResourceCleanupItemIds,
  purgeExpiredFileTrash
} from '../file-resource-cleanup'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { lockMediaResources, resetMediaResourceLocksForTests } from '../media-resource-locks'
import {
  listResourceCleanupRecords,
  retryPendingResourceCleanups
} from '../resource-cleanup-journal'

const originalBlobId = '123e4567-e89b-12d3-a456-426614174000'
const nativeBlobId = '223e4567-e89b-12d3-a456-426614174000'

beforeAll(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      nativeFs: {
        delete: mockDeleteNativeFile
      }
    }
  })
})

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  vi.clearAllMocks()
  resetMediaResourceLocksForTests()
  envState.isElectron = false
  mockDeleteNativeFile.mockResolvedValue(undefined)
})

describe('file resource cleanup', () => {
  it('does not cancel unknown shared sources for already-missing item IDs', async () => {
    await expect(
      listFileResourceCleanupItemIds({ itemIds: ['already-removed-item'] })
    ).resolves.toEqual(['already-removed-item'])

    await cleanupFileResources({ itemIds: ['already-removed-item'] })
    const predicate = mockCancelAndWait.mock.calls[0][0]
    expect(
      predicate({
        type: 'pdf-pages',
        itemId: 'already-removed-item',
        sourceBlobId: 'shared-source'
      })
    ).toBe(false)
  })

  it('recursively deletes unloaded descendants and their resources from the database', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-records', {
      id: 'deep-root',
      name: 'Deep',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    })
    await db.put('folder-records', {
      id: 'deep-child',
      name: 'Child',
      parentId: 'deep-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    })
    await db.put('folder-items', {
      id: 'deep-item',
      parentId: 'deep-child',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'deep.pdf',
      url: `blob:${originalBlobId}`,
      size: 1,
      mimeType: 'application/pdf'
    })
    await db.put('file-blobs', {
      id: originalBlobId,
      blob: new Blob(['pdf']),
      refCount: 1
    })

    await expect(listFileResourceCleanupItemIds({ folderIds: ['deep-root'] })).resolves.toEqual([
      'deep-item'
    ])
    const result = await cleanupFileResources({ folderIds: ['deep-root'] })

    expect(result.folderIds).toEqual(expect.arrayContaining(['deep-root', 'deep-child']))
    expect(result.itemIds).toEqual(['deep-item'])
    await expect(db.get('folder-records', 'deep-child')).resolves.toBeUndefined()
    await expect(db.get('folder-items', 'deep-item')).resolves.toBeUndefined()
    await expect(db.get('file-blobs', originalBlobId)).resolves.toBeUndefined()
    expect(mockDeleteThumbnail).toHaveBeenCalledWith('deep-item')
    expect(mockDeleteDerivedAssets).toHaveBeenCalledWith(originalBlobId)
    expect(mockDeletePdfPageThumbs).toHaveBeenCalledWith(originalBlobId)
  })

  it('waits for derived-asset jobs before permanently deleting their source', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-items', {
      id: 'pdf-item',
      parentId: 'file-root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'slides.pdf',
      url: `blob:${originalBlobId}`,
      size: 1,
      mimeType: 'application/pdf'
    })
    await db.put('file-blobs', {
      id: originalBlobId,
      blob: new Blob(['pdf']),
      refCount: 1
    })

    await cleanupFileResources({ itemIds: ['pdf-item'] })

    expect(mockCancelAndWait).toHaveBeenCalledOnce()
    const predicate = mockCancelAndWait.mock.calls[0][0]
    expect(
      predicate({ type: 'cover-thumbnail', itemId: 'pdf-item', sourceBlobId: originalBlobId })
    ).toBe(true)
    expect(predicate({ type: 'pdf-pages', itemId: 'pdf-item', sourceBlobId: originalBlobId })).toBe(
      true
    )
    expect(predicate({ type: 'video-poster', sourceBlobId: originalBlobId })).toBe(true)
    expect(predicate({ type: 'pdf-pages', itemId: 'other-item', sourceBlobId: 'other' })).toBe(
      false
    )
    expect(predicate({ type: 'sync-download', itemId: 'pdf-item' })).toBe(false)
    expect(mockCancelAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteDerivedAssets.mock.invocationCallOrder[0]
    )
  })

  it('preserves shared blobs until the final copied item is removed', async () => {
    const db = await openFileExplorerDB()
    for (const id of ['original-item', 'copy-item']) {
      await db.put('folder-items', {
        id,
        parentId: 'file-root',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: `${id}.png`,
        url: `blob:${originalBlobId}`,
        size: 1,
        mimeType: 'image/png'
      })
    }
    await db.put('file-blobs', {
      id: originalBlobId,
      blob: new Blob(['image']),
      refCount: 2
    })

    await cleanupFileResources({ itemIds: ['original-item'] })
    const sharedBlobPredicate = mockCancelAndWait.mock.calls[0][0]
    expect(
      sharedBlobPredicate({
        type: 'pdf-pages',
        itemId: 'original-item',
        sourceBlobId: originalBlobId
      })
    ).toBe(false)
    await expect(db.get('file-blobs', originalBlobId)).resolves.toMatchObject({ refCount: 1 })
    expect(mockDeleteDerivedAssets).not.toHaveBeenCalled()
    expect(mockDeletePdfPageThumbs).not.toHaveBeenCalled()
    expect(mockDeleteThumbnail).toHaveBeenCalledWith('original-item')

    await cleanupFileResources({ itemIds: ['copy-item'] })
    await expect(db.get('file-blobs', originalBlobId)).resolves.toBeUndefined()
    expect(mockDeleteDerivedAssets).toHaveBeenCalledWith(originalBlobId)
    expect(mockDeletePdfPageThumbs).toHaveBeenCalledWith(originalBlobId)
  })

  it('serializes concurrent deletes so the final shared reference is fenced', async () => {
    const db = await openFileExplorerDB()
    for (const id of ['first-copy', 'second-copy']) {
      await db.put('folder-items', {
        id,
        parentId: 'file-root',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: `${id}.pdf`,
        url: `blob:${originalBlobId}`,
        size: 1,
        mimeType: 'application/pdf'
      })
    }
    await db.put('file-blobs', {
      id: originalBlobId,
      blob: new Blob(['pdf']),
      refCount: 2
    })

    await Promise.all([
      cleanupFileResources({ itemIds: ['first-copy'] }),
      cleanupFileResources({ itemIds: ['second-copy'] })
    ])

    const predicates = mockCancelAndWait.mock.calls.map(([predicate]) => predicate)
    expect(
      predicates.some((predicate) => predicate({ type: 'pdf-pages', sourceBlobId: originalBlobId }))
    ).toBe(true)
    await expect(db.get('file-blobs', originalBlobId)).resolves.toBeUndefined()
  })

  it('defers final source and derived-asset cleanup while projection holds a lock', async () => {
    const release = lockMediaResources([originalBlobId])
    const db = await openFileExplorerDB()
    await db.put('folder-items', {
      id: 'presenting-item',
      parentId: 'file-root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'presenting.png',
      url: `blob:${originalBlobId}`,
      size: 1,
      mimeType: 'image/png'
    })
    await db.put('file-blobs', {
      id: originalBlobId,
      blob: new Blob(['image']),
      refCount: 1
    })

    await cleanupFileResources({ itemIds: ['presenting-item'] })

    await expect(db.get('file-blobs', originalBlobId)).resolves.toMatchObject({ refCount: 0 })
    expect(mockDeleteDerivedAssets).not.toHaveBeenCalled()

    release()
    await vi.waitFor(async () => {
      await expect(db.get('file-blobs', originalBlobId)).resolves.toBeUndefined()
    })
    expect(mockDeleteDerivedAssets).toHaveBeenCalledWith(originalBlobId)
  })

  it('cleans native and legacy storage through the same automatic purge path', async () => {
    envState.isElectron = true
    const db = await openFileExplorerDB()
    await db.put('folder-items', {
      id: 'expired-native',
      parentId: 'file-root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      deletedAt: 1,
      name: 'native.mp4',
      url: `blob:${nativeBlobId}`,
      size: 1,
      mimeType: 'video/mp4'
    })
    await db.put('file-blobs', {
      id: nativeBlobId,
      storage: 'native-fs',
      size: 1,
      refCount: 1
    })
    await db.put('folder-items', {
      id: 'expired-legacy',
      parentId: 'file-root',
      type: 'file',
      sortIndex: 1,
      createdAt: 1,
      expiresAt: null,
      deletedAt: 1,
      name: 'legacy.png',
      url: 'blob:legacy-blob-id',
      size: 1,
      mimeType: 'image/png'
    })
    await db.put('file-blobs', {
      id: 'legacy-blob-id',
      blob: new Blob(['legacy']),
      refCount: 1
    })

    const result = await purgeExpiredFileTrash(100, 1000)

    expect(result.itemIds).toContain('expired-native')
    expect(mockDeleteNativeFile).toHaveBeenCalledWith(nativeBlobId)
    expect(mockDeleteNativeFile).not.toHaveBeenCalledWith('legacy-blob-id')
    await expect(db.get('folder-items', 'expired-native')).resolves.toBeUndefined()
    await expect(db.get('file-blobs', nativeBlobId)).resolves.toBeUndefined()
  })

  it('retains failed native cleanup after the catalog transaction commits', async () => {
    envState.isElectron = true
    mockDeleteNativeFile.mockRejectedValueOnce(new Error('native file busy'))
    const db = await openFileExplorerDB()
    await db.put('folder-items', {
      id: 'native-item',
      parentId: 'file-root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'native.mp4',
      url: `blob:${nativeBlobId}`,
      size: 1,
      mimeType: 'video/mp4'
    })
    await db.put('file-blobs', {
      id: nativeBlobId,
      storage: 'native-fs',
      size: 1,
      refCount: 1
    })

    await expect(cleanupFileResources({ itemIds: ['native-item'] })).resolves.toEqual({
      folderIds: [],
      itemIds: ['native-item']
    })

    await expect(db.get('folder-items', 'native-item')).resolves.toBeUndefined()
    await expect(db.get('file-blobs', nativeBlobId)).resolves.toMatchObject({ refCount: 0 })
    await expect(listResourceCleanupRecords()).resolves.toEqual([
      expect.objectContaining({
        blobId: nativeBlobId,
        status: 'failed',
        attempt: 1,
        itemThumbnailIds: ['native-item']
      })
    ])

    await retryPendingResourceCleanups()
    await expect(listResourceCleanupRecords()).resolves.toEqual([])
  })

  it('durably journals source cleanup before a projection lock is released', async () => {
    const release = lockMediaResources([originalBlobId])
    const db = await openFileExplorerDB()
    await db.put('folder-items', {
      id: 'locked-item',
      parentId: 'file-root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'locked.png',
      url: `blob:${originalBlobId}`,
      size: 1,
      mimeType: 'image/png'
    })
    await db.put('file-blobs', {
      id: originalBlobId,
      blob: new Blob(['image']),
      refCount: 1
    })

    await cleanupFileResources({ itemIds: ['locked-item'] })

    await expect(db.get('file-blobs', originalBlobId)).resolves.toMatchObject({ refCount: 0 })
    await expect(listResourceCleanupRecords()).resolves.toEqual([
      expect.objectContaining({ blobId: originalBlobId, deleteBlobRecord: true })
    ])
    expect(mockDeleteThumbnail).not.toHaveBeenCalled()
    expect(mockDeleteDerivedAssets).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => {
      expect(mockDeleteDerivedAssets).toHaveBeenCalledWith(originalBlobId)
    })
    await expect(db.get('file-blobs', originalBlobId)).resolves.toBeUndefined()
    await expect(listResourceCleanupRecords()).resolves.toEqual([])
  })
})

it('protects active and unsynced personal files while purging only expired clean cloud trash', async () => {
  const db = await openFileExplorerDB()
  const now = Date.now()
  const day = 86_400_000
  await db.put('folder-records', {
    id: 'cloud',
    personalOwnerId: 'alice',
    name: 'Cloud',
    parentId: 'file-root',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null
  })
  for (const [id, deletedAt, dirty] of [
    ['active', undefined, false],
    ['recent', now - 29 * day, false],
    ['pending', now - 31 * day, true],
    ['expired', now - 31 * day, false]
  ] as const) {
    await db.put('folder-items', {
      id,
      personalOwnerId: 'alice',
      parentId: 'cloud',
      type: 'file',
      name: `${id}.png`,
      url: `blob:${id}`,
      size: 3,
      mimeType: 'image/png',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      deletedAt
    })
    await db.put('file-blobs', { id, blob: new Blob(['one']), size: 3, refCount: dirty ? 2 : 1 })
    await db.put('personal-sync-nodes', {
      id,
      ownerId: 'alice',
      remoteId: id,
      kind: 'file',
      localRevision: dirty ? 2 : 1,
      syncedLocalRevision: 1,
      remoteRevision: 1
    })
  }
  const result = await cleanupFileResources({ folderIds: ['cloud'] })
  expect(result.folderIds).toEqual([])
  expect(result.itemIds).toEqual(['expired'])
  expect(await db.get('folder-records', 'cloud')).toBeDefined()
  for (const id of ['active', 'recent', 'pending'])
    expect(await db.get('file-blobs', id)).toBeDefined()
  expect(await db.get('personal-sync-nodes', 'expired')).toBeUndefined()
})
