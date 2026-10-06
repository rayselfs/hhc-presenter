import { beforeEach, describe, expect, it, vi } from 'vitest'
const { mockIsElectron } = vi.hoisted(() => ({ mockIsElectron: vi.fn(() => false) }))
vi.mock('../env', () => ({ isElectron: mockIsElectron }))

import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { lockMediaResources, resetMediaResourceLocksForTests } from '../media-resource-locks'
import { getDerivedAsset, putDerivedAsset, resetMediaWorkDBForTests } from '../media-work-db'
import {
  clearRegenerableDerivedAssets,
  clearUnpinnedSyncCache,
  evictRegenerableDerivedAssetsToBudget,
  removeUnusedDerivedAssets
} from '../media-storage-cleanup'
import {
  getSyncEntryByRemoteItem,
  putProviderConnection,
  putSyncEntry,
  putSyncEntryPreference,
  resetSyncDBForTests
} from '../sync-db'

beforeEach(async () => {
  mockIsElectron.mockReturnValue(false)
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetSyncDBForTests()
  resetMediaResourceLocksForTests()
})

describe('media storage cleanup', () => {
  it('clears desktop playback caches and surfaces failures for retry', async () => {
    mockIsElectron.mockReturnValue(true)
    const clearVideoCache = vi
      .fn()
      .mockRejectedValueOnce(new Error('cache busy'))
      .mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { nativeFs: { clearVideoCache } }
    })
    await expect(clearRegenerableDerivedAssets()).rejects.toThrow('cache busy')
    await expect(clearRegenerableDerivedAssets()).resolves.toEqual({ deletedAssetIds: [] })
    expect(clearVideoCache).toHaveBeenCalledTimes(2)
  })

  it('removes derived assets whose source blob no longer exists', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'kept-source',
      storage: 'native-fs',
      size: 10,
      refCount: 1
    })
    const kept = await putDerivedAsset({
      sourceBlobId: 'kept-source',
      kind: 'cover-thumbnail',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 1
    })
    const orphan = await putDerivedAsset({
      sourceBlobId: 'missing-source',
      kind: 'cover-thumbnail',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 1
    })

    const result = await removeUnusedDerivedAssets()

    expect(result.deletedAssetIds).toEqual([orphan.id])
    await expect(getDerivedAsset('kept-source', 'cover-thumbnail')).resolves.toMatchObject({
      id: kept.id
    })
    await expect(getDerivedAsset('missing-source', 'cover-thumbnail')).resolves.toBeUndefined()
    await expect(db.get('file-blobs', 'kept-source')).resolves.toBeDefined()
  })

  it('clears regenerable thumbnails and posters but preserves metadata assets', async () => {
    const cover = await putDerivedAsset({
      sourceBlobId: 'source',
      kind: 'cover-thumbnail',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 1
    })
    const pdf = await putDerivedAsset({
      sourceBlobId: 'source',
      kind: 'pdf-page-thumbnails',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 1
    })
    const metadata = await putDerivedAsset({
      sourceBlobId: 'source',
      kind: 'media-metadata',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'application/json',
      status: 'ready',
      size: 1
    })

    const result = await clearRegenerableDerivedAssets()

    expect(result.deletedAssetIds).toEqual(expect.arrayContaining([cover.id, pdf.id]))
    expect(result.deletedAssetIds).not.toContain(metadata.id)
    await expect(getDerivedAsset('source', 'cover-thumbnail')).resolves.toBeUndefined()
    await expect(getDerivedAsset('source', 'pdf-page-thumbnails')).resolves.toBeUndefined()
    await expect(getDerivedAsset('source', 'media-metadata')).resolves.toMatchObject({
      id: metadata.id
    })
  })

  it('evicts oldest regenerable derived assets until the budget is met', async () => {
    const oldest = await putDerivedAsset({
      sourceBlobId: 'source-a',
      kind: 'cover-thumbnail',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 5,
      updatedAt: 1
    })
    const newest = await putDerivedAsset({
      sourceBlobId: 'source-b',
      kind: 'pdf-page-thumbnails',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 5,
      updatedAt: 2
    })

    const result = await evictRegenerableDerivedAssetsToBudget(5)

    expect(result.deletedAssetIds).toEqual([oldest.id])
    await expect(getDerivedAsset('source-a', 'cover-thumbnail')).resolves.toBeUndefined()
    await expect(getDerivedAsset('source-b', 'pdf-page-thumbnails')).resolves.toMatchObject({
      id: newest.id
    })
  })

  it('does not evict locked sources or metadata assets for regenerable budgets', async () => {
    const release = lockMediaResources(['locked-source'])
    const locked = await putDerivedAsset({
      sourceBlobId: 'locked-source',
      kind: 'cover-thumbnail',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 5,
      updatedAt: 1
    })
    const metadata = await putDerivedAsset({
      sourceBlobId: 'source',
      kind: 'media-metadata',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'application/json',
      status: 'ready',
      size: 5,
      updatedAt: 2
    })

    const result = await evictRegenerableDerivedAssetsToBudget(0)

    expect(result.deletedAssetIds).toEqual([])
    await expect(getDerivedAsset('locked-source', 'cover-thumbnail')).resolves.toMatchObject({
      id: locked.id
    })
    await expect(getDerivedAsset('source', 'media-metadata')).resolves.toMatchObject({
      id: metadata.id
    })
    release()
  })

  it('clears unpinned sync cache while preserving pinned and locked entries', async () => {
    const db = await openFileExplorerDB()
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await db.put('file-blobs', { id: 'evict-blob', blob: new Blob(['a']), refCount: 1 })
    await db.put('file-blobs', { id: 'pinned-blob', blob: new Blob(['b']), refCount: 1 })
    await db.put('file-blobs', { id: 'locked-blob', blob: new Blob(['c']), refCount: 1 })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-evict',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'evict.mp4',
      itemId: 'item-evict',
      blobId: 'evict-blob',
      status: 'available-offline',
      size: 1
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-pinned',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'pinned.mp4',
      itemId: 'item-pinned',
      blobId: 'pinned-blob',
      status: 'available-offline',
      size: 1
    })
    await putSyncEntryPreference({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-pinned',
      offlinePolicyOverride: 'always-offline'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-locked',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'locked.mp4',
      itemId: 'item-locked',
      blobId: 'locked-blob',
      status: 'available-offline',
      size: 1
    })
    const release = lockMediaResources(['locked-blob'])

    const result = await clearUnpinnedSyncCache()

    expect(result.deletedSyncBlobIds).toEqual(['evict-blob'])
    await expect(db.get('file-blobs', 'evict-blob')).resolves.toBeUndefined()
    await expect(db.get('file-blobs', 'pinned-blob')).resolves.toBeDefined()
    await expect(db.get('file-blobs', 'locked-blob')).resolves.toBeDefined()
    await expect(getSyncEntryByRemoteItem('connection-1', 'remote-evict')).resolves.toMatchObject({
      status: 'remote-only',
      blobId: undefined
    })
    await expect(getSyncEntryByRemoteItem('connection-1', 'remote-pinned')).resolves.toMatchObject({
      status: 'available-offline',
      blobId: 'pinned-blob'
    })
    release()
  })
})
