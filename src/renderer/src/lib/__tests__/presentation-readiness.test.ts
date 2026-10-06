import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItemRecord } from '@shared/types/folder'
import { resetMediaWorkDBForTests } from '../media-work-db'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  analyzePresentationReadiness,
  createPresentationSnapshot,
  getPresentationSnapshotResourceIds
} from '../presentation-readiness'
import { putProviderConnection, putSyncEntry, resetSyncDBForTests } from '../sync-db'
import { putSourceMediaMetadata } from '../media-metadata'

const { mockEnsurePdfPageJob } = vi.hoisted(() => ({ mockEnsurePdfPageJob: vi.fn() }))

vi.mock('../pdf-page-jobs', () => ({
  ensurePdfPageJob: mockEnsurePdfPageJob
}))

function file(id: string, name: string, mimeType: string, url = `blob:${id}`): FileItemRecord {
  return {
    id,
    parentId: 'root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name,
    mimeType,
    url,
    size: 1024
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  await resetMediaWorkDBForTests()
  await resetSyncDBForTests()
  await resetFileExplorerDBForTests()
})

describe('analyzePresentationReadiness', () => {
  it('enqueues missing PDF pages at the explicit readiness boundary', async () => {
    await (
      await openFileExplorerDB()
    ).put('file-blobs', {
      id: 'legacy-pdf',
      blob: new Blob(['pdf']),
      refCount: 1
    })

    const report = await analyzePresentationReadiness(
      [file('legacy-item', 'legacy.pdf', 'application/pdf', 'blob:legacy-pdf')],
      'web'
    )

    expect(report.items[0].status).toBe('ready')
    expect(mockEnsurePdfPageJob).toHaveBeenCalledWith({
      sourceBlobId: 'legacy-pdf',
      itemId: 'legacy-item'
    })
  })

  it('enqueues missing pages for a synced PDF after it becomes available offline', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-pdf',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'synced.pdf',
      mimeType: 'application/pdf',
      itemId: 'synced-item',
      blobId: 'synced-blob',
      status: 'available-offline'
    })
    await (
      await openFileExplorerDB()
    ).put('file-blobs', {
      id: 'synced-blob',
      blob: new Blob(['pdf']),
      refCount: 1
    })

    const report = await analyzePresentationReadiness(
      [file('synced-item', 'synced.pdf', 'application/pdf', 'blob:synced-blob')],
      'web'
    )

    expect(report.items[0].status).toBe('ready')
    expect(mockEnsurePdfPageJob).toHaveBeenCalledWith({
      sourceBlobId: 'synced-blob',
      itemId: 'synced-item'
    })
  })
  it('uses embedded VLC for Electron native videos when available', async () => {
    const probe = vi.fn().mockResolvedValue({ durationMs: 120000 })
    vi.stubGlobal('window', {
      api: {
        nativeFs: {
          exists: vi.fn().mockResolvedValue(true)
        },
        projectionVlc: {
          getInfo: vi.fn().mockResolvedValue({ status: 'ready' }),
          probe
        }
      }
    })
    await (
      await openFileExplorerDB()
    ).put('file-blobs', {
      id: 'source-video',
      storage: 'native-fs',
      refCount: 1
    })

    const report = await analyzePresentationReadiness(
      [file('source-video', 'source.mkv', 'video/x-matroska')],
      'electron'
    )

    expect(report.summary).toMatchObject({ ready: 1, preparing: 0 })
    expect(report.items[0]).toMatchObject({
      status: 'ready',
      reason: 'ready-vlc-embedded',
      support: 'desktop-engine',
      playbackMode: 'vlc-embedded',
      playbackVariant: 'matroska-remux'
    })
    expect(report.items[0]).not.toHaveProperty('seekable')
    expect(report.items[0]).not.toHaveProperty('durationMs')
    expect(probe).not.toHaveBeenCalled()
  })

  it.each(['mp4', 'mov'])(
    'falls back to VLC for a known unplayable native %s',
    async (extension) => {
      const getInfo = vi.fn().mockResolvedValue({ status: 'ready' })
      vi.stubGlobal('window', {
        api: {
          nativeFs: { exists: vi.fn().mockResolvedValue(true) },
          projectionVlc: { getInfo }
        }
      })
      await (
        await openFileExplorerDB()
      ).put('file-blobs', {
        id: 'codec-video',
        storage: 'native-fs',
        refCount: 1
      })
      await putSourceMediaMetadata('codec-video', { kind: 'video', browserPlayback: 'unplayable' })
      const report = await analyzePresentationReadiness(
        [
          file(
            'codec-item',
            `codec.${extension}`,
            extension === 'mp4' ? 'video/mp4' : 'video/quicktime',
            'blob:codec-video'
          )
        ],
        'electron'
      )
      expect(report.items[0]).toMatchObject({
        status: 'ready',
        playbackMode: 'vlc-embedded',
        playbackVariant: 'source'
      })
      expect(getInfo).toHaveBeenCalledOnce()
    }
  )

  it.each(['missing', 'indexed-db'])(
    'reports unavailable fallback for %s',
    async (availability) => {
      const getInfo = vi.fn().mockResolvedValue({ status: availability })
      vi.stubGlobal('window', {
        api: {
          nativeFs: { exists: vi.fn().mockResolvedValue(true) },
          projectionVlc: { getInfo }
        }
      })
      await (
        await openFileExplorerDB()
      ).put('file-blobs', {
        id: 'codec-video',
        storage: availability === 'indexed-db' ? 'indexed-db' : 'native-fs',
        ...(availability === 'indexed-db' ? { blob: new Blob(['video']) } : {}),
        refCount: 1
      })
      await putSourceMediaMetadata('codec-video', { kind: 'video', browserPlayback: 'unplayable' })
      const report = await analyzePresentationReadiness(
        [file('codec-item', 'codec.mp4', 'video/mp4', 'blob:codec-video')],
        'electron'
      )
      expect(report.items[0]).toMatchObject({
        status: 'failed',
        reason: 'video-engine-unavailable'
      })
      if (availability === 'indexed-db') expect(getInfo).not.toHaveBeenCalled()
    }
  )

  it('keeps healthy native video independent of VLC runtime', async () => {
    const getInfo = vi.fn()
    vi.stubGlobal('window', {
      api: {
        nativeFs: { exists: vi.fn().mockResolvedValue(true) },
        projectionVlc: { getInfo }
      }
    })
    await (
      await openFileExplorerDB()
    ).put('file-blobs', { id: 'healthy-video', storage: 'native-fs', refCount: 1 })
    await putSourceMediaMetadata('healthy-video', {
      kind: 'video',
      browserPlayback: 'playable',
      durationMs: 8000
    })
    const report = await analyzePresentationReadiness(
      [file('healthy-item', 'healthy.mp4', 'video/mp4', 'blob:healthy-video')],
      'electron'
    )
    expect(report.items[0]).toMatchObject({
      status: 'ready',
      playbackMode: 'native',
      durationMs: 8000
    })
    expect(getInfo).not.toHaveBeenCalled()
  })

  it('omits inferred seekability for remote desktop-engine video', async () => {
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'remote-file',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name: 'movie.mkv',
      mimeType: 'video/x-matroska',
      itemId: 'remote-item',
      status: 'remote-only'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        projectionVlc: {
          getInfo: vi.fn().mockResolvedValue({ status: 'ready' })
        }
      }
    })

    const report = await analyzePresentationReadiness(
      [file('remote-item', 'movie.mkv', 'video/x-matroska', 'hhc-line:remote-file')],
      'electron'
    )

    expect(report.items[0]).toMatchObject({
      status: 'ready',
      support: 'desktop-engine',
      playbackMode: 'vlc-embedded',
      playbackVariant: 'matroska-remux'
    })
    expect(report.items[0]).not.toHaveProperty('seekable')
  })

  it('fails when VLC is unavailable for Electron desktop-engine videos', async () => {
    vi.stubGlobal('window', {
      api: {
        nativeFs: {
          exists: vi.fn().mockResolvedValue(true)
        },
        projectionVlc: {
          getInfo: vi.fn().mockResolvedValue({ status: 'missing' })
        }
      }
    })
    await (
      await openFileExplorerDB()
    ).put('file-blobs', {
      id: 'source-video',
      storage: 'native-fs',
      refCount: 1
    })

    const report = await analyzePresentationReadiness(
      [file('source-video', 'source.mkv', 'video/x-matroska')],
      'electron'
    )

    expect(report.summary).toMatchObject({ ready: 0, failed: 1 })
    expect(report.items[0]).toMatchObject({
      status: 'failed',
      reason: 'video-engine-unavailable',
      support: 'desktop-engine'
    })
  })

  it('fails desktop-engine videos when the source is not in native storage', async () => {
    vi.stubGlobal('window', {
      api: {
        projectionVlc: {
          getInfo: vi.fn().mockResolvedValue({ status: 'missing' })
        }
      }
    })
    await (
      await openFileExplorerDB()
    ).put('file-blobs', {
      id: 'legacy-video',
      blob: new Blob(['video']),
      refCount: 1
    })
    await putSourceMediaMetadata('legacy-video', {
      kind: 'video',
      durationMs: 1000
    })

    const report = await analyzePresentationReadiness(
      [file('legacy-video', 'legacy.mkv', 'video/x-matroska')],
      'electron'
    )

    expect(report.summary).toMatchObject({ ready: 0, failed: 1 })
    expect(report.items[0]).toMatchObject({
      status: 'failed',
      reason: 'video-engine-unavailable'
    })
  })

  it('summarizes ready, unsupported, missing, and failed items', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'ready-image',
      blob: new Blob(['image']),
      refCount: 1
    })
    await db.put('file-blobs', {
      id: 'failed-video',
      blob: new Blob(['video']),
      refCount: 1
    })
    await putSourceMediaMetadata('failed-video', {
      kind: 'video',
      durationMs: 1000
    })

    const report = await analyzePresentationReadiness(
      [
        file('ready-image', 'ready.png', 'image/png'),
        file('unsupported-video', 'movie.mpeg', 'video/mpeg'),
        file('missing-source', 'missing.png', 'image/png', ''),
        file('failed-video', 'failed.avi', 'video/x-msvideo')
      ],
      'electron'
    )

    expect(report.summary).toEqual({
      ready: 1,
      preparing: 0,
      unsupported: 1,
      missing: 1,
      failed: 1
    })
    expect(report.items.map((item) => item.reason)).toEqual([
      'ready-native',
      'unsupported-platform',
      'missing-source',
      'video-engine-unavailable'
    ])
  })

  it('marks remote-only sync items as preparing', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'remote.png',
      itemId: 'remote-item',
      blobId: 'remote-blob',
      status: 'remote-only'
    })

    const report = await analyzePresentationReadiness(
      [file('remote-item', 'remote.png', 'image/png', 'blob:remote-blob')],
      'web'
    )

    expect(report.summary).toMatchObject({ ready: 0, preparing: 1 })
    expect(report.items[0]).toMatchObject({
      status: 'preparing',
      reason: 'sync-remote-only'
    })
  })

  it.each([
    ['image/png', 'image.png'],
    ['audio/mpeg', 'audio.mp3'],
    ['video/mp4', 'video.mp4'],
    ['application/pdf', 'document.pdf'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides.pptx']
  ])('allows HHC %s items to prepare from an ephemeral browser source', async (mimeType, name) => {
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'remote-file',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name,
      mimeType,
      itemId: 'remote-item',
      status: 'remote-only'
    })

    const report = await analyzePresentationReadiness(
      [file('remote-item', name, mimeType, 'hhc-line:remote-file')],
      'web'
    )

    expect(report.items[0]).toMatchObject({
      status: 'ready',
      reason: 'ready-remote',
      support: 'native',
      seekable: mimeType.startsWith('audio/') || mimeType.startsWith('video/')
    })
    expect(report.items[0]).not.toHaveProperty('playbackVariant')
  })

  it('fails unsupported HHC remote media without requesting a source', async () => {
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'remote-file',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name: 'image.heic',
      mimeType: 'image/heic',
      itemId: 'remote-item',
      status: 'remote-only'
    })

    const report = await analyzePresentationReadiness(
      [file('remote-item', 'image.heic', 'image/heic', 'hhc-line:remote-file')],
      'web'
    )

    expect(report.items[0]).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported-platform'
    })
  })

  it('fails remote desktop-engine media when VLC is unavailable', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { projectionVlc: { getInfo: vi.fn(async () => ({ status: 'missing' })) } }
    })
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'remote-file',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name: 'movie.mkv',
      mimeType: 'video/x-matroska',
      itemId: 'remote-item',
      status: 'remote-only'
    })

    const report = await analyzePresentationReadiness(
      [file('remote-item', 'movie.mkv', 'video/x-matroska', 'hhc-line:remote-file')],
      'electron'
    )

    expect(report.items[0]).toMatchObject({
      status: 'failed',
      reason: 'video-engine-unavailable'
    })
  })

  it('marks available-offline sync items as preparing when the native file is missing', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        nativeFs: {
          exists: vi.fn().mockResolvedValue(false)
        }
      }
    })
    await (
      await openFileExplorerDB()
    ).put('file-blobs', {
      id: 'remote-blob',
      storage: 'native-fs',
      size: 100,
      refCount: 1
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'remote.png',
      itemId: 'remote-item',
      blobId: 'remote-blob',
      status: 'available-offline'
    })

    const report = await analyzePresentationReadiness(
      [file('remote-item', 'remote.png', 'image/png', 'blob:remote-blob')],
      'electron'
    )

    expect(report.summary).toMatchObject({ ready: 0, preparing: 1 })
    expect(report.items[0]).toMatchObject({
      status: 'preparing',
      reason: 'sync-missing-source'
    })
  })

  it('excludes browser-unplayable Web videos', async () => {
    await (
      await openFileExplorerDB()
    ).put('file-blobs', {
      id: 'bad-video',
      blob: new Blob(['video']),
      refCount: 1
    })
    await putSourceMediaMetadata('bad-video', {
      kind: 'video',
      browserPlayback: 'unplayable'
    })

    const report = await analyzePresentationReadiness(
      [file('bad-video', 'bad.mkv', 'video/x-matroska')],
      'web'
    )

    expect(report.summary).toMatchObject({ ready: 0, unsupported: 1 })
    expect(report.items[0]).toMatchObject({
      status: 'unsupported',
      reason: 'browser-video-unplayable'
    })
  })
})

describe('createPresentationSnapshot', () => {
  it('captures immutable item and blob identities', () => {
    const item = file('copy-id', 'Original.png', 'image/png', 'blob:source-blob')
    const snapshot = createPresentationSnapshot([item])

    item.name = 'Renamed.png'
    item.url = 'blob:other-blob'

    expect(snapshot.entries[0]).toMatchObject({
      index: 0,
      itemId: 'copy-id',
      blobId: 'source-blob',
      name: 'Original.png',
      sourceUrl: 'blob:source-blob'
    })
  })

  it('reports every resource identity protected by the snapshot', () => {
    const item = file('copy-id', 'Original.avi', 'video/x-msvideo', 'blob:source-blob')
    const snapshot = createPresentationSnapshot(
      [item],
      [
        {
          itemId: 'copy-id',
          blobId: 'source-blob',
          status: 'ready',
          reason: 'ready-vlc-embedded',
          support: 'desktop-engine'
        }
      ]
    )

    expect(getPresentationSnapshotResourceIds(snapshot)).toEqual(['source-blob'])
  })
})
