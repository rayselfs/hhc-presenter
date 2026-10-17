import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listMediaJobs, resetMediaWorkDBForTests } from '../media-work-db'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'

const { mockRenderCover, mockRenderPdfPages, mockSaveCover, mockSavePdfPages } = vi.hoisted(() => ({
  mockRenderCover: vi.fn(),
  mockRenderPdfPages: vi.fn(),
  mockSaveCover: vi.fn(),
  mockSavePdfPages: vi.fn()
}))

vi.mock('../thumbnail-worker-client', () => ({
  BackgroundRenderingUnavailableError: class BackgroundRenderingUnavailableError extends Error {},
  renderCoverThumbnail: mockRenderCover,
  renderPdfPageThumbnails: mockRenderPdfPages
}))

vi.mock('../thumbnail-db', () => ({
  getPdfPageThumbs: vi.fn().mockResolvedValue([]),
  saveThumbnail: vi.fn(),
  saveThumbnailBlob: mockSaveCover,
  savePdfPageThumbBlobs: mockSavePdfPages
}))

vi.mock('../pptx-renderer-service', () => ({ generatePptxFirstSlideThumbnail: vi.fn() }))

import { generatePptxFirstSlideThumbnail } from '../pptx-renderer-service'
import { enqueueCoverThumbnailJob } from '../cover-thumbnail-jobs'
import { ensurePdfPageJob } from '../pdf-page-jobs'
import { BackgroundRenderingUnavailableError } from '../thumbnail-worker-client'

describe('background thumbnail jobs', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await resetMediaWorkDBForTests()
    await resetFileExplorerDBForTests()
  })

  it('stores image covers returned by the Worker as blobs', async () => {
    const cover = new Blob(['cover'], { type: 'image/jpeg' })
    mockRenderCover.mockResolvedValue(cover)

    await enqueueCoverThumbnailJob({
      sourceBlobId: 'image-blob',
      itemId: 'image-item',
      file: new File(['image'], 'photo.jpg', { type: 'image/jpeg' }),
      mimeType: 'image/jpeg'
    })

    await vi.waitFor(() => expect(mockSaveCover).toHaveBeenCalledWith('image-blob', cover))
  })

  it('stores PDF pages returned by the Worker as blobs', async () => {
    const pages = [new Blob(['page-1']), new Blob(['page-2'])]
    mockRenderPdfPages.mockResolvedValue(pages)

    await ensurePdfPageJob({
      sourceBlobId: 'pdf-blob',
      itemId: 'pdf-item',
      file: new File(['pdf'], 'slides.pdf', { type: 'application/pdf' })
    })

    await vi.waitFor(() => expect(mockSavePdfPages).toHaveBeenCalledWith('pdf-blob', pages))
    await vi.waitFor(async () => {
      expect((await listMediaJobs())[0]?.status).toBe('completed')
    })
  })

  it('finishes shared PDF prewarming through a surviving copy item', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-items', {
      id: 'surviving-copy',
      parentId: 'file-root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'slides-copy.pdf',
      url: 'blob:shared-pdf',
      size: 3,
      mimeType: 'application/pdf'
    })
    await db.put('file-blobs', {
      id: 'shared-pdf',
      blob: new Blob(['pdf']),
      refCount: 1
    })
    mockRenderPdfPages.mockResolvedValue([new Blob(['page'])])

    await ensurePdfPageJob({ sourceBlobId: 'shared-pdf', itemId: 'deleted-original' })

    await vi.waitFor(() => expect(mockRenderPdfPages).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(mockSavePdfPages).toHaveBeenCalledOnce())
  })

  it('blocks the job instead of falling back to renderer-thread PDF work', async () => {
    mockRenderPdfPages.mockRejectedValue(new BackgroundRenderingUnavailableError())

    await ensurePdfPageJob({
      sourceBlobId: 'unsupported-pdf',
      itemId: 'unsupported-item',
      file: new File(['pdf'], 'slides.pdf', { type: 'application/pdf' })
    })

    await vi.waitFor(async () => {
      expect((await listMediaJobs())[0]).toMatchObject({
        status: 'blocked',
        blockedReason: 'configuration'
      })
    })
  })
  it('fails a PPTX rendering job without publishing a ready event', async () => {
    vi.mocked(generatePptxFirstSlideThumbnail).mockRejectedValue(new Error('Render failed'))
    const ready = vi.fn()
    window.addEventListener('hhc:thumbnail-ready', ready)
    try {
      const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      await enqueueCoverThumbnailJob({
        sourceBlobId: 'failed-pptx',
        itemId: 'failed-item',
        file: new File(['pptx'], 'slides.pptx', { type: mimeType }),
        mimeType
      })
      await vi.waitFor(async () => {
        expect((await listMediaJobs())[0]).toMatchObject({ status: 'failed' })
      })
      expect(ready).not.toHaveBeenCalled()
      expect(mockSaveCover).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('hhc:thumbnail-ready', ready)
    }
  })
})
