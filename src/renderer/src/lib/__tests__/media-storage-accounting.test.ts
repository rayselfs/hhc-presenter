import { beforeEach, describe, expect, it, vi } from 'vitest'

const { envState } = vi.hoisted(() => ({
  envState: { isElectron: false }
}))

vi.mock('../env', () => ({
  isElectron: () => envState.isElectron
}))

import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { getMediaStorageAccounting } from '../media-storage-accounting'
import { putCustomCoverOverride, putDerivedAsset, resetMediaWorkDBForTests } from '../media-work-db'
import { putSyncEntry, putSyncTombstone, resetSyncDBForTests } from '../sync-db'

beforeEach(async () => {
  envState.isElectron = false
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetSyncDBForTests()
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: undefined
  })
})

describe('getMediaStorageAccounting', () => {
  it('accounts for web source blobs and derived assets without reading file contents', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'web-source',
      blob: new Blob(['source']),
      size: 6,
      refCount: 1
    })
    await putDerivedAsset({
      sourceBlobId: 'web-source',
      kind: 'cover-thumbnail',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 5,
      blob: new Blob(['cover'])
    })
    await putDerivedAsset({
      sourceBlobId: 'web-source',
      kind: 'pdf-page-thumbnails',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'ready',
      size: 4,
      blobs: [new Blob(['p1']), new Blob(['p2'])]
    })
    await putDerivedAsset({
      sourceBlobId: 'web-source',
      kind: 'video-poster',
      variant: 'default',
      storage: 'indexed-db',
      mimeType: 'image/jpeg',
      status: 'failed',
      size: 33
    })
    await putDerivedAsset({
      sourceBlobId: 'web-source',
      kind: 'presentation-page-document',
      variant: 'document:item-1',
      storage: 'indexed-db',
      mimeType: 'application/json',
      status: 'ready',
      size: 7,
      blob: new Blob(['slides'])
    })
    await putCustomCoverOverride('item-1', new Blob(['custom']))

    const report = await getMediaStorageAccounting()

    expect(report.usage.webIndexedDbSourceBlobs).toBe(6)
    expect(report.usage.generatedCoverThumbnails).toBe(5)
    expect(report.usage.pdfPageThumbnails).toBe(4)
    expect(report.usage.presentationDocuments).toBe(7)
    expect(report.usage.temporaryAndFailedJobFiles).toBe(33)
    expect(Number.isNaN(report.usage.customCoverOverrides)).toBe(false)
  })

  it('separates Electron native source media from legacy IndexedDB blobs', async () => {
    envState.isElectron = true
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        nativeFs: {
          getVideoCacheUsage: vi.fn().mockResolvedValue({ cacheBytes: 500, temporaryBytes: 40 })
        }
      }
    })
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'native-source',
      storage: 'native-fs',
      size: 1024,
      refCount: 1
    })
    await db.put('file-blobs', {
      id: 'legacy-source',
      blob: new Blob(['legacy']),
      size: 6,
      refCount: 1
    })

    const report = await getMediaStorageAccounting()

    expect(report.usage.videoRemuxCache).toBe(500)
    expect(report.usage.temporaryAndFailedJobFiles).toBe(40)
    expect(report.usage.electronNativeSourceMedia).toBe(1024)
    expect(report.usage.legacyElectronIndexedDbBlobs).toBe(6)
    expect(report.usage.webIndexedDbSourceBlobs).toBe(0)
  })

  it('accounts for locally cached sync entries and excludes tombstoned blobs', async () => {
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-ready',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'ready.mp4',
      blobId: 'ready-blob',
      size: 100,
      status: 'available-offline'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-tombstoned',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'deleted.mp4',
      blobId: 'deleted-blob',
      size: 200,
      status: 'deleted-pending-release'
    })
    await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-tombstoned',
      blobId: 'deleted-blob',
      reason: 'remote-delete'
    })

    const report = await getMediaStorageAccounting()

    expect(report.usage.syncCache).toBe(100)
  })

  it('counts a shared sync blob only once across source records and sync entries', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', { id: 'shared-cache', size: 120, storage: 'native-fs', refCount: 2 })
    for (const remoteItemId of ['first', 'second']) {
      await putSyncEntry({
        providerConnectionId: 'connection',
        remoteItemId,
        parentRemoteItemId: null,
        kind: 'file',
        name: 'video.mkv',
        blobId: 'shared-cache',
        size: 100,
        status: 'available-offline'
      })
    }
    const report = await getMediaStorageAccounting()
    expect(report.usage.electronNativeSourceMedia).toBe(0)
    expect(report.usage.syncCache).toBe(120)
    expect(report.total).toBe(120)
  })

  it('includes browser quota and persistence status when available', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: vi.fn(async () => ({ quota: 1000, usage: 250 })),
        persisted: vi.fn(async () => true)
      }
    })

    const report = await getMediaStorageAccounting()

    expect(report.browser).toEqual({ quota: 1000, usage: 250, persisted: true })
  })
})
