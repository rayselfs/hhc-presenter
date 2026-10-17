import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItemRecord } from '@shared/types/folder'

const {
  mockEnsureSourceMediaMetadata,
  mockEnqueueVideoPosterJob,
  mockGenerateThumbnail,
  mockSaveThumbnail,
  mockSaveThumbnailBlob
} = vi.hoisted(() => ({
  mockEnsureSourceMediaMetadata: vi.fn(),
  mockEnqueueVideoPosterJob: vi.fn(),
  mockGenerateThumbnail: vi.fn(),
  mockSaveThumbnail: vi.fn(),
  mockSaveThumbnailBlob: vi.fn()
}))

vi.mock('../env', () => ({
  isElectron: vi.fn(() => true),
  isWeb: vi.fn(() => false)
}))

vi.mock('../video-poster-jobs', () => ({
  enqueueVideoPosterJob: mockEnqueueVideoPosterJob
}))

vi.mock('../media-metadata', () => ({
  ensureSourceMediaMetadata: mockEnsureSourceMediaMetadata
}))

vi.mock('../thumbnail-generator', () => ({
  generateThumbnail: mockGenerateThumbnail
}))

vi.mock('../thumbnail-db', () => ({
  saveThumbnail: mockSaveThumbnail,
  saveThumbnailBlob: mockSaveThumbnailBlob
}))

import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { refreshImportedMediaAssets } from '../sync-media-preparation'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('refreshImportedMediaAssets', () => {
  async function createImageItems(count: number): Promise<FileItemRecord[]> {
    const db = await openFileExplorerDB()
    const images = Array.from({ length: count }, (_, index) => ({
      id: `image-${index}`,
      parentId: 'folder-1',
      type: 'file' as const,
      sortIndex: index,
      createdAt: 1,
      expiresAt: null,
      name: `photo-${index}.png`,
      url: `blob:image-${index}`,
      size: 3,
      mimeType: 'image/png'
    }))
    await Promise.all(
      images.map((item) =>
        db.put('file-blobs', {
          id: item.id,
          blob: new Blob(['png'], { type: 'image/png' }),
          storage: 'indexed-db',
          refCount: 1
        })
      )
    )
    return images
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetFileExplorerDBForTests()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
    URL.createObjectURL = vi.fn(() => 'blob:test-source')
    URL.revokeObjectURL = vi.fn()
    globalThis.fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([112, 110, 103]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' }
        })
    )
    mockEnsureSourceMediaMetadata.mockResolvedValue(null)
    mockEnqueueVideoPosterJob.mockResolvedValue(undefined)
    mockGenerateThumbnail.mockResolvedValue('data:image/jpeg;base64,thumb')
    mockSaveThumbnail.mockResolvedValue(undefined)
    mockSaveThumbnailBlob.mockResolvedValue(undefined)
  })

  it('generates thumbnails from Web IndexedDB blobs without nativeFs', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'image-1',
      blob: new Blob(['png'], { type: 'image/png' }),
      storage: 'indexed-db',
      refCount: 1
    })

    await refreshImportedMediaAssets([
      {
        id: 'image-1',
        parentId: 'folder-1',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: 'photo.png',
        url: 'blob:image-1',
        size: 3,
        mimeType: 'image/png'
      }
    ])

    expect(mockGenerateThumbnail).toHaveBeenCalledWith(expect.any(File), 'image/png')
    expect(mockSaveThumbnail).toHaveBeenCalledWith('image-1', 'data:image/jpeg;base64,thumb')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-source')
  })

  it('persists Worker-generated thumbnail blobs without data URL conversion', async () => {
    const [image] = await createImageItems(1)
    const thumbnail = new Blob(['jpeg'], { type: 'image/jpeg' })
    mockGenerateThumbnail.mockResolvedValueOnce(thumbnail)

    await refreshImportedMediaAssets([image])

    expect(mockSaveThumbnailBlob).toHaveBeenCalledWith(image.id, thumbnail)
    expect(mockSaveThumbnail).not.toHaveBeenCalled()
  })

  it('does not commit a thumbnail or ready event after authorization changes during generation', async () => {
    const [image] = await createImageItems(1)
    const generated = deferred<string | null>()
    let authorized = true
    const canCommit = vi.fn(async () => authorized)
    const ready = vi.fn()
    mockGenerateThumbnail.mockReturnValueOnce(generated.promise)
    window.addEventListener('hhc:thumbnail-ready', ready)

    const refresh = refreshImportedMediaAssets([image], canCommit)
    await vi.waitFor(() => expect(mockGenerateThumbnail).toHaveBeenCalledOnce())
    authorized = false
    generated.resolve('data:image/jpeg;base64,thumb')
    await refresh

    expect(mockEnsureSourceMediaMetadata).toHaveBeenCalledWith(image.id, image.mimeType, canCommit)
    expect(mockSaveThumbnail).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    window.removeEventListener('hhc:thumbnail-ready', ready)
  })

  it('forwards the HHC authorization guard to a deferred video poster', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'video-1',
      blob: new Blob(['video'], { type: 'video/mp4' }),
      storage: 'indexed-db',
      refCount: 1
    })
    const canCommit = vi.fn(async () => true)

    await refreshImportedMediaAssets(
      [
        {
          id: 'video-1',
          parentId: 'folder-1',
          type: 'file',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          name: 'video.mp4',
          url: 'blob:video-1',
          size: 5,
          mimeType: 'video/mp4'
        }
      ],
      canCommit
    )

    expect(mockEnqueueVideoPosterJob).toHaveBeenCalledWith({
      sourceBlobId: 'video-1',
      itemId: 'video-1',
      canCommit
    })
  })

  it('prepares at most three imported media assets concurrently', async () => {
    const images = await createImageItems(5)

    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []
    mockGenerateThumbnail.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return null
    })

    const refresh = refreshImportedMediaAssets([
      ...Array.from({ length: 3 }, (_, index) => ({
        ...images[index],
        id: `remote-${index}`,
        url: `https://example.com/remote-${index}.png`
      })),
      ...images
    ])

    await vi.waitFor(() => expect(mockGenerateThumbnail).toHaveBeenCalledTimes(3))
    expect(maxActive).toBe(3)

    releases.shift()?.()
    await vi.waitFor(() => expect(mockGenerateThumbnail).toHaveBeenCalledTimes(4))
    releases.shift()?.()
    await vi.waitFor(() => expect(mockGenerateThumbnail).toHaveBeenCalledTimes(5))
    releases.splice(0).forEach((release) => release())

    await refresh
    expect(maxActive).toBe(3)
  })

  it('limits overlapping invocations to three and releases a failed slot', async () => {
    const images = await createImageItems(5)
    let active = 0
    let maxActive = 0
    const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockGenerateThumbnail.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
      } finally {
        active -= 1
      }
      return null
    })

    const firstRefresh = refreshImportedMediaAssets(images.slice(0, 3))
    const secondRefresh = refreshImportedMediaAssets(images.slice(3))

    await vi.waitFor(() => expect(mockGenerateThumbnail).toHaveBeenCalledTimes(3))
    expect(maxActive).toBe(3)

    pending.shift()?.reject(new Error('thumbnail failed'))
    await vi.waitFor(() => expect(mockGenerateThumbnail).toHaveBeenCalledTimes(4))
    pending.shift()?.resolve()
    await vi.waitFor(() => expect(mockGenerateThumbnail).toHaveBeenCalledTimes(5))
    pending.splice(0).forEach(({ resolve }) => resolve())

    await Promise.all([firstRefresh, secondRefresh])
    expect(maxActive).toBe(3)
    expect(warn).toHaveBeenCalledWith(
      '[sync] Failed to refresh synced media asset',
      expect.objectContaining({ error: expect.any(Error) })
    )
    warn.mockRestore()
  })
})
