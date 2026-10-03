import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItemRecord } from '@shared/types/folder'
import NextItemPreview from '../NextItemPreview'
import { getFileSource } from '@renderer/lib/file-explorer-db'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: vi.fn(async () => ({})),
  getFileSource: vi.fn()
}))
const { snapshot, getDocument, renderPdf, destroyPdf } = vi.hoisted(() => ({
  snapshot: {
    entries: [] as Array<{
      itemId: string
      sourceUrl: string
      remoteItem?: { remoteItemId: string }
      remoteSource?: { etag: string }
    }>
  },
  getDocument: vi.fn(),
  renderPdf: vi.fn(() => ({ promise: Promise.resolve() })),
  destroyPdf: vi.fn(async () => undefined)
}))
vi.mock('@renderer/stores/media-projection', () => ({
  useMediaProjectionStore: (
    selector: (state: {
      snapshot: typeof snapshot
      typeStates: { presentation: { slideIndex: number } }
    }) => unknown
  ) => selector({ snapshot, typeStates: { presentation: { slideIndex: 3 } } })
}))
vi.mock('@renderer/contexts/PresentationSessionRegistryContext', () => ({
  usePresentationSessionRegistry: () => ({ get: () => undefined })
}))
vi.mock('@renderer/lib/pdfjs-loader', () => ({
  loadPdfjsLib: vi.fn(async () => ({ getDocument }))
}))
const thumbnail = 'data:image/jpeg;base64,thumbnail'
const makeItem = (overrides: Partial<FileItemRecord> = {}): FileItemRecord => ({
  id: 'item-1',
  parentId: 'folder-1',
  type: 'file',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null,
  name: 'test.jpg',
  url: 'blob:source-1',
  size: 1000,
  mimeType: 'image/jpeg',
  ...overrides
})

describe('NextItemPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    snapshot.entries = []
    vi.mocked(getFileSource).mockResolvedValue(null)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  })

  it('uses the original image rather than enlarging the cached thumbnail and releases it', async () => {
    const revoke = vi.fn()
    vi.mocked(getFileSource).mockResolvedValue({ url: 'blob:original-image', revoke })
    const { unmount } = render(
      <NextItemPreview item={makeItem()} previewCache={{ 'item-1': thumbnail }} />
    )
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:original-image')
    )
    expect(getFileSource).toHaveBeenCalledWith(expect.anything(), 'source-1', 'image/jpeg')
    unmount()
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('releases a source that finishes loading after unmount', async () => {
    const revoke = vi.fn()
    let resolve!: (source: { url: string; revoke: () => void }) => void
    vi.mocked(getFileSource).mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { unmount } = render(<NextItemPreview item={makeItem()} />)
    await waitFor(() => expect(getFileSource).toHaveBeenCalled())
    unmount()
    resolve({ url: 'blob:late-image', revoke })
    await waitFor(() => expect(revoke).toHaveBeenCalledOnce())
  })

  it('keeps the cached thumbnail when the source fails to decode', async () => {
    vi.mocked(getFileSource).mockResolvedValue({ url: 'blob:broken-image', revoke: vi.fn() })
    render(<NextItemPreview item={makeItem()} previewCache={{ 'item-1': thumbnail }} />)
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:broken-image'))
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByRole('img')).toHaveAttribute('src', thumbnail)
  })

  it('does not read a remote file before its authorized source is ready', async () => {
    snapshot.entries = [
      { itemId: 'item-1', sourceUrl: 'hhc-line:asset', remoteItem: { remoteItemId: 'asset' } }
    ]
    const { rerender } = render(<NextItemPreview item={makeItem()} />)
    expect(screen.getByText('test.jpg')).toBeInTheDocument()
    expect(getFileSource).not.toHaveBeenCalled()
    snapshot.entries = [
      {
        ...snapshot.entries[0],
        sourceUrl: 'https://www.alive.org.tw/api/assets/content?ticket=ready',
        remoteSource: { etag: 'etag-1' }
      }
    ]
    rerender(<NextItemPreview item={makeItem()} />)
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', snapshot.entries[0].sourceUrl)
    )
    expect(getFileSource).not.toHaveBeenCalled()
  })

  it('renders the first PDF page at a readable resolution and destroys its loading task', async () => {
    vi.mocked(getFileSource).mockResolvedValue({ url: 'blob:pdf-original', revoke: vi.fn() })
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 640 * scale,
            height: 360 * scale
          }),
          render: renderPdf
        })
      }),
      destroy: destroyPdf
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D
    )
    const { unmount } = render(
      <NextItemPreview item={makeItem({ name: 'test.pdf', mimeType: 'application/pdf' })} />
    )
    const canvas = await screen.findByRole('img', { name: 'test.pdf' })
    await waitFor(() => expect(canvas).toHaveAttribute('width', '1280'))
    expect(canvas).toHaveAttribute('height', '720')
    expect(getDocument).toHaveBeenCalledWith({ url: 'blob:pdf-original' })
    unmount()
    expect(destroyPdf).toHaveBeenCalledOnce()
  })

  it('previews a native video without playing it or showing controls', async () => {
    vi.mocked(getFileSource).mockResolvedValue({ url: 'blob:video-original', revoke: vi.fn() })
    const { container } = render(
      <NextItemPreview item={makeItem({ name: 'test.mp4', mimeType: 'video/mp4' })} />
    )
    await waitFor(() =>
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:video-original')
    )
    const video = container.querySelector('video')!
    expect(video.autoplay).toBe(false)
    expect(video.controls).toBe(false)
    expect(video.muted).toBe(true)
  })

  it('retains the filename for audio instead of mounting a blank video', async () => {
    vi.mocked(getFileSource).mockResolvedValue({ url: 'blob:audio', revoke: vi.fn() })
    const { container } = render(
      <NextItemPreview item={makeItem({ name: 'sermon.mp3', mimeType: 'audio/mpeg' })} />
    )
    await act(async () => undefined)
    expect(screen.getByText('sermon.mp3')).toBeInTheDocument()
    expect(container.querySelector('video')).toBeNull()
    expect(getFileSource).not.toHaveBeenCalled()
  })

  it('stops loading a native video on unmount even when source revocation is a no-op', async () => {
    vi.mocked(getFileSource).mockResolvedValue({
      url: 'hhc-media://native/video',
      revoke: () => undefined
    })
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    const { container, unmount } = render(
      <NextItemPreview item={makeItem({ mimeType: 'video/mp4' })} />
    )
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    const video = container.querySelector('video')!
    unmount()
    expect(pause).toHaveBeenCalledOnce()
    expect(video).not.toHaveAttribute('src')
    expect(load).toHaveBeenCalledOnce()
  })

  it('restores the paused video source after StrictMode replays its resource lifecycle', async () => {
    vi.mocked(getFileSource).mockResolvedValue({ url: 'blob:strict-video', revoke: vi.fn() })
    const { container } = render(
      <StrictMode>
        <NextItemPreview item={makeItem({ mimeType: 'video/mp4' })} />
      </StrictMode>
    )
    await waitFor(() =>
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:strict-video')
    )
    await act(async () => undefined)
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()
    expect(container.querySelector('video')).toHaveAttribute('src', 'blob:strict-video')
  })

  it('falls back to the cover when the PPTX original is unavailable', async () => {
    render(
      <NextItemPreview
        item={makeItem({
          name: 'test.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        })}
        previewCache={{ 'item-1': thumbnail }}
      />
    )
    expect(await screen.findByRole('img', { name: 'test.pptx' })).toHaveAttribute('src', thumbnail)
  })
})
