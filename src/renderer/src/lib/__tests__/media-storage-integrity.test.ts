import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { repairMediaStorageIntegrity, scanMediaStorageIntegrity } from '../media-storage-integrity'
import { listDerivedAssets, putDerivedAsset, resetMediaWorkDBForTests } from '../media-work-db'
import { listResourceCleanupRecords } from '../resource-cleanup-journal'
import { putSyncEntry, resetSyncDBForTests } from '../sync-db'

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetSyncDBForTests()
})

describe('scanMediaStorageIntegrity', () => {
  it('reports file items that reference missing Blob records', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-items', {
      id: 'item-1',
      parentId: 'root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      size: 10,
      url: 'blob:missing-blob'
    })

    const report = await scanMediaStorageIntegrity(123)

    expect(report).toMatchObject({
      checkedAt: 123,
      issueCount: 1,
      issues: [
        {
          kind: 'file-item-missing-blob',
          severity: 'error',
          resourceId: 'item-1',
          relatedId: 'missing-blob'
        }
      ]
    })
  })

  it('reports derived assets and sync entries whose source Blob is missing', async () => {
    await putDerivedAsset({
      sourceBlobId: 'missing-source',
      kind: 'video-poster',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 10
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'clip.mp4',
      blobId: 'missing-sync-blob',
      status: 'available-offline'
    })

    const report = await scanMediaStorageIntegrity()

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'derived-asset-missing-source',
          severity: 'error',
          relatedId: 'missing-source'
        }),
        expect.objectContaining({
          kind: 'sync-entry-missing-blob',
          severity: 'error',
          relatedId: 'missing-sync-blob'
        })
      ])
    )
  })

  it('reports unreferenced Blob records without reading Blob contents', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'orphan-blob',
      blob: new Blob(['source']),
      size: 6,
      refCount: 0
    })

    const report = await scanMediaStorageIntegrity()

    expect(report.issues).toEqual([
      expect.objectContaining({
        kind: 'file-blob-unreferenced',
        severity: 'warning',
        resourceId: 'orphan-blob'
      })
    ])
  })

  it('reports authoritative reference-count mismatches and stale positive orphans', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'shared-blob',
      blob: new Blob(['source']),
      refCount: 9
    })
    await db.put('file-blobs', {
      id: 'stale-orphan',
      blob: new Blob(['orphan']),
      refCount: 4
    })
    for (const id of ['item-1']) {
      await db.put('folder-items', {
        id,
        parentId: 'root',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: `${id}.png`,
        mimeType: 'image/png',
        size: 6,
        url: 'blob:shared-blob'
      })
    }
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'cached.png',
      blobId: 'shared-blob',
      status: 'available-offline'
    })

    const report = await scanMediaStorageIntegrity()

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'file-blob-ref-count-mismatch',
          resourceId: 'shared-blob',
          actualRefCount: 9,
          expectedRefCount: 1
        }),
        expect.objectContaining({
          kind: 'file-blob-unreferenced',
          resourceId: 'stale-orphan'
        }),
        expect.objectContaining({
          kind: 'file-blob-ref-count-mismatch',
          resourceId: 'stale-orphan',
          actualRefCount: 4,
          expectedRefCount: 0
        })
      ])
    )
  })

  it('repairs nonzero counts and routes zero-reference blobs through cleanup journal', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'shared-blob',
      blob: new Blob(['source']),
      refCount: 1
    })
    await db.put('file-blobs', {
      id: 'orphan-blob',
      blob: new Blob(['orphan']),
      refCount: 5
    })
    for (const id of ['item-1', 'item-2']) {
      await db.put('folder-items', {
        id,
        parentId: 'root',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: `${id}.png`,
        mimeType: 'image/png',
        size: 6,
        url: 'blob:shared-blob'
      })
    }
    await putDerivedAsset({
      sourceBlobId: 'orphan-blob',
      kind: 'video-poster',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 1,
      blob: new Blob(['poster'])
    })

    const result = await repairMediaStorageIntegrity()

    expect(result.correctedRefCounts).toEqual(['shared-blob'])
    expect(result.cleanupJournalIds).toHaveLength(1)
    await expect(db.get('file-blobs', 'shared-blob')).resolves.toMatchObject({ refCount: 2 })
    await expect(db.get('file-blobs', 'orphan-blob')).resolves.toBeUndefined()
    await expect(listDerivedAssets()).resolves.toEqual([])
    await expect(listResourceCleanupRecords()).resolves.toEqual([])

    const report = await scanMediaStorageIntegrity()
    expect(report.issues).toEqual([])
  })

  it('does not report healthy referenced media records', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'blob-1',
      blob: new Blob(['source']),
      size: 6,
      refCount: 1
    })
    await db.put('folder-items', {
      id: 'item-1',
      parentId: 'root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      size: 6,
      url: 'blob:blob-1'
    })

    const report = await scanMediaStorageIntegrity()

    expect(report.issues).toEqual([])
  })

  it('does not count sync metadata as an additional Blob owner', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'synced-blob',
      blob: new Blob(['source']),
      size: 6,
      refCount: 1
    })
    await db.put('folder-items', {
      id: 'synced-item',
      parentId: 'root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'synced.jpg',
      mimeType: 'image/jpeg',
      size: 6,
      url: 'blob:synced-blob'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'synced.jpg',
      blobId: 'synced-blob',
      status: 'available-offline'
    })

    const report = await scanMediaStorageIntegrity()
    const repair = await repairMediaStorageIntegrity()

    expect(report.issues).toEqual([])
    expect(repair.correctedRefCounts).toEqual([])
    await expect(db.get('file-blobs', 'synced-blob')).resolves.toMatchObject({ refCount: 1 })
  })

  it('does not delete a sync-cached Blob when its folder item is missing', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'sync-only-blob',
      blob: new Blob(['source']),
      size: 6,
      refCount: 1
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'sync-only.jpg',
      blobId: 'sync-only-blob',
      status: 'available-offline'
    })

    const repair = await repairMediaStorageIntegrity()
    const report = await scanMediaStorageIntegrity()

    expect(repair.cleanupJournalIds).toEqual([])
    await expect(db.get('file-blobs', 'sync-only-blob')).resolves.toBeDefined()
    expect(report.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'sync-entry-missing-blob', relatedId: 'sync-only-blob' })
      ])
    )
  })

  it('publishes a semantic recovery change after a ref-count-only repair commits', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'blob-1',
      blob: new Blob(['source']),
      refCount: 5
    })
    await db.put('folder-items', {
      id: 'item-1',
      parentId: 'root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      size: 6,
      url: 'blob:blob-1'
    })
    const changed = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', changed)

    const result = await repairMediaStorageIntegrity()

    window.removeEventListener('hhc:recovery-source-changed', changed)
    expect(result).toEqual({ correctedRefCounts: ['blob-1'], cleanupJournalIds: [] })
    expect(changed).toHaveBeenCalledOnce()
    await expect(db.get('file-blobs', 'blob-1')).resolves.toMatchObject({ refCount: 1 })
  })
})

it('journals zero-reference repair before releasing a live projection source', async () => {
  const { lockMediaResources } = await import('../media-resource-locks')
  const db = await openFileExplorerDB()
  await db.put('file-blobs', { id: 'live', blob: new Blob(['frame']), refCount: 0 })
  const release = lockMediaResources(['live'])
  try {
    const result = await repairMediaStorageIntegrity()
    expect(result.cleanupJournalIds).toHaveLength(1)
    expect(await db.get('file-blobs', 'live')).toBeDefined()
    expect(await db.get('resource-cleanup-journal', result.cleanupJournalIds[0])).toMatchObject({
      deleteBlobRecord: true
    })
  } finally {
    release()
  }
  await vi.waitFor(async () => expect(await db.get('file-blobs', 'live')).toBeUndefined())
})

it('does not replace an active import staging cleanup intent during integrity repair', async () => {
  const { createResourceCleanupRecord } = await import('../resource-cleanup-journal')
  const db = await openFileExplorerDB()
  await db.put('file-blobs', { id: 'staging', blob: new Blob(['source']), refCount: 0 })
  const intent = createResourceCleanupRecord({
    blobId: 'staging',
    deleteNativeFile: false,
    deleteDerivedAssets: true,
    deletePdfPageThumbs: true,
    itemThumbnailIds: [],
    deleteBlobRecord: true,
    stagingLock: 'local-blob:staging'
  })
  await db.put('resource-cleanup-journal', intent)
  expect((await repairMediaStorageIntegrity()).cleanupJournalIds).toEqual([])
  expect(await db.get('file-blobs', 'staging')).toBeDefined()
  expect(await db.getAll('resource-cleanup-journal')).toEqual([intent])
})
