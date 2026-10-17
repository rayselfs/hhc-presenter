import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../thumbnail-worker-client', () => ({
  renderCoverThumbnail: vi.fn()
}))

vi.mock('../pptx-renderer-service', () => ({
  generatePptxFirstSlideThumbnail: vi.fn()
}))

import { generateThumbnail } from '../thumbnail-generator'
import { renderCoverThumbnail } from '../thumbnail-worker-client'
import { generatePptxFirstSlideThumbnail } from '../pptx-renderer-service'

const mockRenderCoverThumbnail = vi.mocked(renderCoverThumbnail)
const mockGeneratePptxFirstSlideThumbnail = vi.mocked(generatePptxFirstSlideThumbnail)

describe('thumbnail generation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['slides.pdf', 'application/pdf']
  ])('delegates %s rendering to the background Worker', async (name, mimeType) => {
    const file = new File(['source'], name, { type: mimeType })
    const blob = new Blob(['cover'], { type: 'image/jpeg' })
    mockRenderCoverThumbnail.mockResolvedValue(blob)

    await expect(generateThumbnail(file, mimeType)).resolves.toBe(blob)
    expect(mockRenderCoverThumbnail).toHaveBeenCalledWith(file, mimeType)
    expect(document.querySelector('canvas')).toBeNull()
  })

  it('delegates PPTX thumbnails to the browser renderer', async () => {
    const file = new File(['pptx'], 'sermon.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })
    mockGeneratePptxFirstSlideThumbnail.mockResolvedValue('data:image/jpeg;base64,pptx')

    await expect(generateThumbnail(file, file.type)).resolves.toBe('data:image/jpeg;base64,pptx')
    expect(mockGeneratePptxFirstSlideThumbnail).toHaveBeenCalledWith(file)
  })

  it('falls back silently when a browser canvas is tainted', async () => {
    const file = new File(['pptx'], 'sermon.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockGeneratePptxFirstSlideThumbnail.mockRejectedValue(
      Object.assign(new Error('tainted'), { name: 'SecurityError' })
    )

    await expect(generateThumbnail(file, file.type)).resolves.toBeNull()
    expect(consoleError).not.toHaveBeenCalled()
  })
  it.each(['Thumbnail Worker failed', 'Background rendering unavailable'])(
    'propagates %s to the caller',
    async (message) => {
      const error = new Error(message)
      mockRenderCoverThumbnail.mockRejectedValue(error)
      const file = new File(['source'], 'slides.pdf', { type: 'application/pdf' })
      await expect(generateThumbnail(file)).rejects.toBe(error)
    }
  )

  it('propagates PPTX rendering failures', async () => {
    const error = new Error('Render failed')
    mockGeneratePptxFirstSlideThumbnail.mockRejectedValue(error)
    const file = new File(['source'], 'slides.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })
    await expect(generateThumbnail(file)).rejects.toBe(error)
  })

  it('keeps unsupported content and an absent preview distinct from failed rendering', async () => {
    await expect(
      generateThumbnail(new File(['source'], 'audio.mp3', { type: 'audio/mpeg' }))
    ).resolves.toBeNull()
    mockRenderCoverThumbnail.mockResolvedValue(null)
    await expect(
      generateThumbnail(new File(['source'], 'empty.pdf', { type: 'application/pdf' }))
    ).resolves.toBeNull()
  })
})
