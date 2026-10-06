import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FileProjection from '../FileProjection'

let resizeObserverCallback: ResizeObserverCallback | undefined
let resizeObserverDisconnect = vi.fn()

const {
  mockGetFileSource,
  mockLoadPdfjsLib,
  mockProjectionHandlers,
  mockProjectionSend,
  mockProjectionSetGeneration,
  mockProjectionVlcStop,
  mockGetPdfPageThumbs
} = vi.hoisted(() => ({
  mockGetFileSource: vi.fn(),
  mockLoadPdfjsLib: vi.fn(),
  mockProjectionHandlers: new Map<string, Array<(data: unknown) => void>>(),
  mockProjectionSend: vi.fn(),
  mockProjectionSetGeneration: vi.fn(),
  mockProjectionVlcStop: vi.fn(),
  mockGetPdfPageThumbs: vi.fn()
}))

vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: vi.fn().mockResolvedValue({}),
  getFileSource: mockGetFileSource
}))

vi.mock('@renderer/lib/pdfjs-loader', () => ({
  loadPdfjsLib: mockLoadPdfjsLib
}))

vi.mock('@renderer/lib/thumbnail-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/thumbnail-db')>()),
  getPdfPageThumbs: mockGetPdfPageThumbs
}))

vi.mock('@renderer/lib/projection-adapter', () => ({
  createProjectionAdapter: () => ({
    setGeneration: mockProjectionSetGeneration,
    getGeneration: vi.fn(() => 4),
    send: mockProjectionSend,
    on: vi.fn((channel: string, handler: (data: unknown) => void) => {
      const handlers = mockProjectionHandlers.get(channel) ?? []
      handlers.push(handler)
      mockProjectionHandlers.set(channel, handlers)
      return () => {
        mockProjectionHandlers.set(
          channel,
          (mockProjectionHandlers.get(channel) ?? []).filter((item) => item !== handler)
        )
      }
    }),
    dispose: vi.fn()
  })
}))

vi.mock('@renderer/components/Common/PptxSlideSurface', () => ({
  default: ({
    source,
    verifyNativeFile
  }: {
    source: { id: string; url: string }
    verifyNativeFile?: boolean
  }) => (
    <div
      data-testid="pptx-surface"
      data-source-id={source.id}
      data-source-url={source.url}
      data-verify-native-file={String(verifyNativeFile)}
    />
  )
}))

function mockPdf(
  pageCount = 100,
  pendingRenders = false,
  pageSize = { width: 640, height: 360 }
): {
  pdf: {
    numPages: number
    getPage: ReturnType<typeof vi.fn>
    loadingTask: { destroy: ReturnType<typeof vi.fn> }
  }
  renderCancels: Map<number, ReturnType<typeof vi.fn>>
  renderResolves: Map<number, () => void>
} {
  const renderCancels = new Map<number, ReturnType<typeof vi.fn>>()
  const renderResolves = new Map<number, () => void>()
  const pdf = {
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber: number) => ({
      getViewport: () => pageSize,
      render: vi.fn(({ canvas }: { canvas: HTMLCanvasElement }) => {
        canvas.dataset.pdfPage = String(pageNumber)
        let rejectRender: ((error: Error) => void) | undefined
        const promise = pendingRenders
          ? new Promise<void>((resolve, reject) => {
              renderResolves.set(pageNumber, resolve)
              rejectRender = reject
            })
          : Promise.resolve()
        const cancel = vi.fn(() => {
          const error = new Error('cancelled')
          error.name = 'RenderingCancelledException'
          rejectRender?.(error)
        })
        renderCancels.set(pageNumber, cancel)
        return { promise, cancel }
      })
    })),
    loadingTask: { destroy: vi.fn(() => Promise.resolve()) }
  }
  mockLoadPdfjsLib.mockResolvedValue({
    getDocument: vi.fn(() => ({ promise: Promise.resolve(pdf) }))
  })
  return { pdf, renderCancels, renderResolves }
}

describe('FileProjection copied media identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjectionHandlers.clear()
    mockGetFileSource.mockResolvedValue({
      url: 'blob:projection-source',
      revoke: vi.fn()
    })
    mockLoadPdfjsLib.mockResolvedValue({
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({
          numPages: 0,
          getPage: vi.fn(),
          loadingTask: { destroy: vi.fn(() => Promise.resolve()) }
        })
      }))
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        projectionVlc: {
          start: vi.fn().mockResolvedValue(undefined),
          control: vi.fn().mockResolvedValue(undefined),
          stop: mockProjectionVlcStop
        }
      }
    })
    mockProjectionVlcStop.mockResolvedValue(undefined)
    mockGetPdfPageThumbs.mockResolvedValue([])
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
    HTMLMediaElement.prototype.pause = vi.fn()
    resizeObserverCallback = undefined
    resizeObserverDisconnect = vi.fn()
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback
      }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = resizeObserverDisconnect
    }
  })

  it('reports decode errors once for the current load, excluding network and stale elements', async () => {
    mockGetFileSource.mockResolvedValue({ url: 'blob:video', revoke: vi.fn() })
    const props = {
      initialItemId: 'video-1',
      initialBlobId: 'blob-1',
      initialMimeType: 'video/mp4',
      initialContentRevision: 7
    }
    const { container, rerender } = render(<FileProjection {...props} />)
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    const video = container.querySelector('video')!
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } })
    fireEvent.error(video)
    expect(mockProjectionSend).not.toHaveBeenCalledWith('file:playback-error', expect.anything())
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } })
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 18 })
    fireEvent.error(video)
    fireEvent.error(video)
    expect(
      mockProjectionSend.mock.calls.filter(([channel]) => channel === 'file:playback-error')
    ).toHaveLength(1)
    expect(mockProjectionSend).toHaveBeenCalledWith(
      'file:playback-error',
      expect.objectContaining({
        itemId: 'video-1',
        blobId: 'blob-1',
        contentRevision: 7,
        errorCode: 3,
        currentTime: 18
      })
    )
    rerender(<FileProjection {...props} initialContentRevision={8} />)
    await waitFor(() => expect(container.querySelector('video')).not.toBe(video))
    fireEvent.error(video)
    expect(
      mockProjectionSend.mock.calls.filter(([channel]) => channel === 'file:playback-error')
    ).toHaveLength(1)
    const current = container.querySelector('video')!
    Object.defineProperty(current, 'error', { value: { code: 4 } })
    fireEvent.error(current)
    expect(mockProjectionSend).toHaveBeenLastCalledWith(
      'file:playback-error',
      expect.objectContaining({ contentRevision: 8 })
    )
  })

  it('loads projection content with blobId while retaining itemId as UI identity', async () => {
    const { getByAltText } = render(
      <FileProjection
        fileName="copy.png"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="image/png"
      />
    )

    await waitFor(() => {
      expect(mockGetFileSource).toHaveBeenCalledWith({}, 'original-id', 'image/png', {
        verifyNativeFile: false
      })
    })
    expect(getByAltText('copy.png')).toHaveAttribute('src', 'blob:projection-source')
  })

  it('reuses an authorized native PPT source without another native availability check', () => {
    const { getByTestId } = render(
      <FileProjection
        fileName="copy.pptx"
        initialItemId="copied-item"
        initialBlobId="source-blob"
        initialMimeType="application/vnd.openxmlformats-officedocument.presentationml.presentation"
      />
    )

    const surface = getByTestId('pptx-surface')
    expect(surface).toHaveAttribute('data-source-id', 'copied-item')
    expect(surface).toHaveAttribute('data-source-url', 'blob:source-blob')
    expect(surface).toHaveAttribute('data-verify-native-file', 'false')
  })

  it('applies video seek after metadata is available', async () => {
    const { container, rerender } = render(
      <FileProjection
        fileName="copy.mp4"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="video/mp4"
      />
    )

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 0 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })

    rerender(
      <FileProjection
        fileName="copy.mp4"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="video/mp4"
        controlEvent={{ id: 1, data: { action: 'seek', itemId: 'copy-id', value: 35 } }}
      />
    )
    expect(video.currentTime).toBe(0)

    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    fireEvent.loadedMetadata(video)

    expect(video.currentTime).toBe(35)
  })

  it('applies replay seek and volume before resuming a playing video', async () => {
    const { container } = render(
      <FileProjection
        generation={4}
        fileName="copy.mp4"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="video/mp4"
        initialReplayState={{
          itemId: 'copy-id',
          positionSeconds: 18,
          durationSeconds: 100,
          isPlaying: true,
          isEnded: false,
          volume: 0.35,
          pdfPage: 1,
          pdfScroll: 0,
          pdfViewMode: 'single',
          zoom: 1,
          pan: { x: 0, y: 0 }
        }}
      />
    )
    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })
    fireEvent.loadedMetadata(video)

    expect(mockProjectionSetGeneration).toHaveBeenCalledWith(4)
    expect(video.currentTime).toBe(18)
    expect(video.volume).toBe(0.35)
    expect(video.play).toHaveBeenCalled()
  })

  it('passes replay state to embedded VLC startup', async () => {
    const { unmount } = render(
      <FileProjection
        generation={4}
        fileName="clip.mkv"
        initialItemId="video-id"
        initialBlobId="video-blob"
        initialMimeType="video/x-matroska"
        initialPlaybackMode="vlc-embedded"
        initialPlaybackVariant="matroska-remux"
        initialReplayState={{
          itemId: 'video-id',
          positionSeconds: 18,
          durationSeconds: 100,
          isPlaying: true,
          isEnded: false,
          volume: 0.35,
          pdfPage: 1,
          pdfScroll: 0,
          pdfViewMode: 'single',
          zoom: 1,
          pan: { x: 0, y: 0 }
        }}
      />
    )

    await waitFor(() => {
      expect(window.api.projectionVlc.start).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: expect.any(String),
          initialPositionSeconds: 18,
          initialVolume: 0.35,
          initialPlaybackState: 'playing',
          playbackVariant: 'matroska-remux'
        })
      )
    })

    const attemptId = vi.mocked(window.api.projectionVlc.start).mock.calls[0][0].attemptId
    unmount()
    expect(mockProjectionVlcStop).toHaveBeenCalledWith({ itemId: 'video-id', attemptId })
  })

  it('forwards embedded VLC seek to the owner session even before renderer capability state', async () => {
    const { rerender } = render(
      <FileProjection
        fileName="clip.mkv"
        initialItemId="video-id"
        initialBlobId="video-blob"
        initialMimeType="video/x-matroska"
        initialPlaybackMode="vlc-embedded"
        initialSeekable={false}
      />
    )
    await waitFor(() => expect(window.api.projectionVlc.start).toHaveBeenCalled())

    rerender(
      <FileProjection
        fileName="clip.mkv"
        initialItemId="video-id"
        initialBlobId="video-blob"
        initialMimeType="video/x-matroska"
        initialPlaybackMode="vlc-embedded"
        initialSeekable={false}
        controlEvent={{ id: 1, data: { action: 'seek', itemId: 'video-id', value: 20 } }}
      />
    )

    expect(window.api.projectionVlc.control).toHaveBeenCalledWith({
      action: 'seek',
      itemId: 'video-id',
      value: 20
    })
  })

  it('starts and controls the new VLC owner while the old owner stop is pending', async () => {
    let resolveOldStop: (() => void) | undefined
    const { rerender } = render(
      <FileProjection
        fileName="old.mkv"
        initialItemId="old-id"
        initialBlobId="old-blob"
        initialMimeType="video/x-matroska"
        initialPlaybackMode="vlc-embedded"
      />
    )
    await waitFor(() => expect(window.api.projectionVlc.start).toHaveBeenCalledOnce())
    mockProjectionVlcStop.mockImplementation((request: { force?: boolean }) =>
      request.force
        ? new Promise<void>((resolve) => {
            resolveOldStop = resolve
          })
        : Promise.resolve()
    )
    vi.mocked(window.api.projectionVlc.start).mockClear()
    vi.mocked(window.api.projectionVlc.control).mockClear()

    rerender(
      <FileProjection
        fileName="new.mkv"
        initialItemId="new-id"
        initialBlobId="new-blob"
        initialMimeType="video/x-matroska"
        initialPlaybackMode="vlc-embedded"
        controlEvent={{ id: 1, data: { action: 'play', itemId: 'new-id' } }}
      />
    )

    await waitFor(() =>
      expect(window.api.projectionVlc.start).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'new-id', sourceFileId: 'new-blob' })
      )
    )
    expect(window.api.projectionVlc.control).toHaveBeenCalledWith({
      action: 'play',
      itemId: 'new-id'
    })
    expect(mockProjectionVlcStop).not.toHaveBeenCalledWith({ force: true })
    resolveOldStop?.()
  })

  it('restarts embedded VLC exactly once for a same-generation replay revision', async () => {
    const props = {
      generation: 4,
      fileName: 'clip.mkv',
      initialItemId: 'video-id',
      initialBlobId: 'video-blob',
      initialMimeType: 'video/x-matroska',
      initialPlaybackMode: 'vlc-embedded' as const,
      initialPlaybackVariant: 'matroska-remux' as const
    }
    const { rerender } = render(<FileProjection {...props} vlcStartRevision={1} />)
    await waitFor(() => expect(window.api.projectionVlc.start).toHaveBeenCalledOnce())

    rerender(<FileProjection {...props} vlcStartRevision={2} />)

    await waitFor(() => expect(window.api.projectionVlc.start).toHaveBeenCalledTimes(2))
  })

  it('uses live stream URLs without loading a stored source and ignores seek controls', async () => {
    const { container, rerender } = render(
      <FileProjection
        fileName="live.mkv"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/x-matroska"
        initialStreamUrl="hhc-media://native/source-id"
        initialSeekable={false}
      />
    )

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })

    expect(mockGetFileSource).not.toHaveBeenCalled()
    expect(video).toHaveAttribute('src', 'hhc-media://native/source-id')
    expect(video).toHaveAttribute('preload', 'none')

    rerender(
      <FileProjection
        fileName="live.mkv"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/x-matroska"
        initialStreamUrl="hhc-media://native/source-id"
        initialSeekable={false}
        controlEvent={{ id: 1, data: { action: 'seek', itemId: 'live-id', value: 35 } }}
      />
    )

    expect(video.currentTime).toBe(0)
  })

  it('reports video playback state from the projection video element', async () => {
    const { container } = render(
      <FileProjection
        fileName="live.mkv"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/x-matroska"
        initialStreamUrl="hhc-media://native/source-id"
        initialSeekable={false}
      />
    )

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })
    video.currentTime = 12

    fireEvent.timeUpdate(video)

    expect(mockProjectionSend).toHaveBeenCalledWith('file:playback-state', {
      itemId: 'live-id',
      phase: 'paused',
      currentTime: 12,
      duration: 100,
      isPlaying: false,
      isEnded: false,
      playbackRate: 1,
      seekable: false,
      volume: 1
    })
  })

  it('restores video playback rate when an authoritative source URL is replaced', async () => {
    const replayState = {
      itemId: 'live-id',
      positionSeconds: 12,
      durationSeconds: 100,
      isPlaying: false,
      isEnded: false,
      volume: 0.4,
      playbackRate: 1.5,
      pdfPage: 1,
      pdfScroll: 0,
      pdfViewMode: 'single' as const,
      zoom: 1,
      pan: { x: 0, y: 0 }
    }
    const { container, rerender } = render(
      <FileProjection
        fileName="live.mp4"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/mp4"
        initialStreamUrl="https://www.alive.org.tw/api/assets/content?ticket=first"
        initialReplayState={replayState}
      />
    )
    const video = await waitFor(() => container.querySelector('video')!)
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })
    fireEvent.loadedMetadata(video)

    rerender(
      <FileProjection
        fileName="live.mp4"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/mp4"
        initialStreamUrl="https://www.alive.org.tw/api/assets/content?ticket=second"
        initialReplayState={replayState}
      />
    )
    fireEvent.loadedMetadata(video)

    expect(video.currentTime).toBe(12)
    expect(video.paused).toBe(true)
    expect(video.volume).toBe(0.4)
    expect(video.playbackRate).toBe(1.5)
  })

  it('captures live playback state before replacing a same-item source URL', async () => {
    const { container, rerender } = render(
      <FileProjection
        fileName="live.mp4"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/mp4"
        initialStreamUrl="https://www.alive.org.tw/api/assets/content?ticket=first"
      />
    )
    const video = await waitFor(() => container.querySelector('video')!)
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })
    video.currentTime = 18
    video.volume = 0.3
    video.playbackRate = 1.75

    rerender(
      <FileProjection
        fileName="live.mp4"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/mp4"
        initialStreamUrl="https://www.alive.org.tw/api/assets/content?ticket=second"
      />
    )
    fireEvent.loadedMetadata(video)

    expect(video.currentTime).toBe(18)
    expect(video.paused).toBe(true)
    expect(video.volume).toBe(0.3)
    expect(video.playbackRate).toBe(1.75)
  })

  it('starts live stream playback even before metadata is available', async () => {
    const { container, rerender } = render(
      <FileProjection
        fileName="live.mkv"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/x-matroska"
        initialStreamUrl="hhc-media://native/source-id"
        initialSeekable={false}
      />
    )

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 0 })

    rerender(
      <FileProjection
        fileName="live.mkv"
        initialItemId="live-id"
        initialBlobId="source-id"
        initialMimeType="video/x-matroska"
        initialStreamUrl="hhc-media://native/source-id"
        initialSeekable={false}
        controlEvent={{ id: 1, data: { action: 'play', itemId: 'live-id' } }}
      />
    )

    expect(video.play).toHaveBeenCalledOnce()
  })

  it('renders and controls an audio ticket through the shared media surface', async () => {
    const { container, rerender } = render(
      <FileProjection
        fileName="sermon.mp3"
        initialItemId="audio-id"
        initialBlobId="audio-blob"
        initialMimeType="audio/mpeg"
        initialStreamUrl="https://www.alive.org.tw/api/assets/content?ticket=audio-secret"
      />
    )

    const audio = await waitFor(() => {
      const element = container.querySelector('audio')
      expect(element).not.toBeNull()
      return element!
    })
    expect(audio).toHaveAttribute(
      'src',
      'https://www.alive.org.tw/api/assets/content?ticket=audio-secret'
    )
    expect(mockGetFileSource).not.toHaveBeenCalled()

    rerender(
      <FileProjection
        fileName="sermon.mp3"
        initialItemId="audio-id"
        initialBlobId="audio-blob"
        initialMimeType="audio/mpeg"
        initialStreamUrl="https://www.alive.org.tw/api/assets/content?ticket=audio-secret"
        controlEvent={{ id: 1, data: { action: 'play', itemId: 'audio-id' } }}
      />
    )
    expect(audio.play).toHaveBeenCalledOnce()
  })

  it('loads a remote PDF ticket through PDF.js without opening IndexedDB', async () => {
    const { pdf } = mockPdf(1)
    const ticket = 'https://www.alive.org.tw/api/assets/content?ticket=pdf-secret'

    render(
      <FileProjection
        fileName="bulletin.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        initialStreamUrl={ticket}
      />
    )

    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(1))
    expect(mockLoadPdfjsLib.mock.results.at(-1)?.value).toBeDefined()
    const pdfjs = await mockLoadPdfjsLib.mock.results.at(-1)?.value
    expect(pdfjs.getDocument).toHaveBeenCalledWith({ url: ticket })
    expect(mockGetFileSource).not.toHaveBeenCalled()
  })

  it.each([
    ['image/png', 'photo.png', 'img'],
    ['audio/mpeg', 'sermon.mp3', 'audio'],
    ['video/mp4', 'clip.mp4', 'video'],
    ['application/pdf', 'bulletin.pdf', 'pdf'],
    [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'slides.pptx',
      'pptx'
    ]
  ] as const)(
    'routes HHC %s tickets and native leases through the real projection surface',
    async (mimeType, fileName, surface) => {
      if (surface === 'pdf') mockPdf(1)
      const ticket = 'https://www.alive.org.tw/api/assets/content?ticket=matrix-secret'
      const lease =
        'hhc-media://lease/123e4567-e89b-12d3-a456-426614174000?type=application%2Foctet-stream'
      const { container, getByTestId, rerender } = render(
        <FileProjection
          fileName={fileName}
          initialItemId="remote-item"
          initialBlobId="remote-blob"
          initialMimeType={mimeType}
          initialStreamUrl={ticket}
        />
      )

      const expectSource = async (url: string): Promise<void> => {
        if (surface === 'pdf') {
          await waitFor(() => {
            const pdfjs = mockLoadPdfjsLib.mock.results.at(-1)?.value
            expect(pdfjs).toBeDefined()
          })
          const pdfjs = await mockLoadPdfjsLib.mock.results.at(-1)?.value
          expect(pdfjs.getDocument).toHaveBeenCalledWith({ url })
        } else if (surface === 'pptx') {
          expect(getByTestId('pptx-surface')).toHaveAttribute('data-source-url', url)
        } else {
          await waitFor(() => expect(container.querySelector(surface)).toHaveAttribute('src', url))
        }
      }

      await expectSource(ticket)
      rerender(
        <FileProjection
          fileName={fileName}
          initialItemId="remote-item"
          initialBlobId="remote-blob"
          initialMimeType={mimeType}
          initialStreamUrl={lease}
        />
      )
      await expectSource(lease)
      expect(mockGetFileSource).not.toHaveBeenCalled()
    }
  )

  it('applies pending video seek before pending play', async () => {
    const { container, rerender } = render(
      <FileProjection
        fileName="copy.mp4"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="video/mp4"
      />
    )

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 0 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })

    rerender(
      <FileProjection
        fileName="copy.mp4"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="video/mp4"
        controlEvent={{ id: 1, data: { action: 'seek', itemId: 'copy-id', value: 20 } }}
      />
    )
    rerender(
      <FileProjection
        fileName="copy.mp4"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="video/mp4"
        controlEvent={{ id: 2, data: { action: 'play', itemId: 'copy-id' } }}
      />
    )

    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    fireEvent.loadedMetadata(video)

    expect(video.currentTime).toBe(20)
    expect(video.play).toHaveBeenCalledOnce()
  })

  it('ignores video control commands for a different item', async () => {
    const { container, rerender } = render(
      <FileProjection
        fileName="copy.mp4"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="video/mp4"
      />
    )

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })

    rerender(
      <FileProjection
        fileName="copy.mp4"
        initialItemId="copy-id"
        initialBlobId="original-id"
        initialMimeType="video/mp4"
        controlEvent={{ id: 1, data: { action: 'seek', itemId: 'other-id', value: 35 } }}
      />
    )

    expect(video.currentTime).toBe(0)
  })

  it('waits for VLC to stop before loading the next non-VLC item', async () => {
    let resolveStop: (() => void) | undefined
    mockProjectionVlcStop.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStop = resolve
      })
    )

    const { rerender } = render(
      <FileProjection
        fileName="clip.mkv"
        initialItemId="video-id"
        initialBlobId="video-blob"
        initialMimeType="video/x-matroska"
        initialPlaybackMode="vlc-embedded"
      />
    )

    rerender(
      <FileProjection
        fileName="next.png"
        initialItemId="image-id"
        initialBlobId="image-blob"
        initialMimeType="image/png"
      />
    )

    expect(mockProjectionVlcStop).toHaveBeenCalled()
    expect(mockGetFileSource).not.toHaveBeenCalledWith({}, 'image-blob', 'image/png', {
      verifyNativeFile: false
    })

    resolveStop?.()

    await waitFor(() => {
      expect(mockGetFileSource).toHaveBeenCalledWith({}, 'image-blob', 'image/png', {
        verifyNativeFile: false
      })
    })
  })

  it('contains portrait images and native video without a fixed 16:9 frame', async () => {
    const { container, getByAltText, rerender } = render(
      <FileProjection
        fileName="portrait.png"
        initialItemId="portrait-image"
        initialBlobId="portrait-image"
        initialMimeType="image/png"
      />
    )

    const image = await waitFor(() => getByAltText('portrait.png'))
    expect(image).toHaveStyle({ width: '100%', height: '100%', objectFit: 'contain' })
    expect(image.parentElement).toHaveClass('h-screen', 'w-screen')
    expect(image.parentElement?.style.aspectRatio).toBe('')

    rerender(
      <FileProjection
        fileName="portrait.mp4"
        initialItemId="portrait-video"
        initialBlobId="portrait-video"
        initialMimeType="video/mp4"
      />
    )

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    expect(video).toHaveStyle({ width: '100%', height: '100%', objectFit: 'contain' })
    expect(video.parentElement).toHaveClass('h-screen', 'w-screen')
    expect(video.parentElement?.style.aspectRatio).toBe('')
  })

  it('contains a 4:3 PDF page using its rendered canvas viewport', async () => {
    mockPdf(1, false, { width: 640, height: 480 })
    const { container } = render(
      <FileProjection
        fileName="four-by-three.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
      />
    )

    const canvas = await waitFor(() => {
      const element = container.querySelector('canvas')
      expect(element).not.toBeNull()
      return element!
    })
    expect(canvas).toHaveAttribute('width', '640')
    expect(canvas).toHaveAttribute('height', '480')
    expect(canvas).toHaveStyle({ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' })
    expect(canvas.closest('.h-screen')).toHaveClass('w-screen')
    expect(canvas.closest('[style*="aspect-ratio"]')).toBeNull()
  })

  it('renders only the current PDF page in single mode', async () => {
    const { pdf } = mockPdf()
    const { container } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        initialReplayState={{
          itemId: 'pdf-id',
          positionSeconds: 0,
          durationSeconds: 0,
          isPlaying: false,
          isEnded: false,
          volume: 1,
          pdfPage: 50,
          pdfScroll: 49,
          pdfViewMode: 'single',
          zoom: 1,
          pan: { x: 0, y: 0 }
        }}
      />
    )

    await waitFor(() => {
      expect(container.querySelector('canvas')?.dataset.pdfPage).toBe('50')
    })
    expect(pdf.getPage).toHaveBeenCalledTimes(1)
    expect(pdf.getPage).toHaveBeenCalledWith(50)
  })

  it('keeps a decoded image through source renewal and rejects late completion after replacement', async () => {
    const props = { initialItemId: 'image', initialBlobId: 'blob', initialMimeType: 'image/png' }
    const { container, rerender } = render(
      <FileProjection {...props} initialStreamUrl="https://source/old" initialContentRevision={1} />
    )
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    fireEvent.load(container.querySelector('img')!)
    const preloads: HTMLImageElement[] = []
    const mockImage = vi.spyOn(globalThis, 'Image').mockImplementation(function () {
      const image = document.createElement('img')
      preloads.push(image)
      return image
    })
    try {
      rerender(
        <FileProjection
          {...props}
          initialStreamUrl="https://source/new"
          initialContentRevision={2}
        />
      )
      await waitFor(() => expect(preloads).toHaveLength(1))
      expect(container.querySelector('img')).toHaveAttribute('src', 'https://source/old')
      await act(async () => fireEvent.load(preloads[0]))
      expect(container.querySelector('img')).toHaveAttribute('src', 'https://source/new')
      rerender(
        <FileProjection
          {...props}
          initialStreamUrl="https://source/later"
          initialContentRevision={3}
        />
      )
      await waitFor(() => expect(preloads).toHaveLength(2))
      rerender(
        <FileProjection
          initialItemId="different"
          initialBlobId="different"
          initialMimeType="image/png"
          initialStreamUrl="https://source/different"
          initialContentRevision={4}
        />
      )
      await act(async () => fireEvent.load(preloads[1]))
      await waitFor(() =>
        expect(container.querySelector('img')).toHaveAttribute('src', 'https://source/different')
      )
    } finally {
      mockImage.mockRestore()
    }
  })

  it('keeps the previous PDF on renewal failure and cannot resurrect it after end', async () => {
    mockPdf(3)
    const props = {
      initialItemId: 'pdf',
      initialBlobId: 'blob',
      initialMimeType: 'application/pdf'
    }
    const { container, rerender } = render(
      <FileProjection {...props} initialStreamUrl="https://source/old" initialContentRevision={1} />
    )
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const originalCanvas = container.querySelector('canvas')
    mockLoadPdfjsLib.mockResolvedValue({
      getDocument: () => ({ promise: Promise.reject(new Error('network')) })
    })
    rerender(
      <FileProjection
        {...props}
        initialStreamUrl="https://source/failed"
        initialContentRevision={2}
      />
    )
    await waitFor(() =>
      expect(mockProjectionSend).toHaveBeenCalledWith('file:render-status', {
        itemId: 'pdf',
        blobId: 'blob',
        contentRevision: 2,
        status: 'failed',
        reason: 'decode-failed'
      })
    )
    expect(container.querySelector('canvas')).toBe(originalCanvas)
    const next = mockPdf(3, true)
    rerender(
      <FileProjection
        {...props}
        initialStreamUrl="https://source/retry"
        initialContentRevision={3}
      />
    )
    await waitFor(() => expect(next.renderResolves.has(1)).toBe(true))
    act(() => mockProjectionHandlers.get('file:end')?.forEach((handler) => handler(null)))
    await act(async () => next.renderResolves.get(1)?.())
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.textContent).toContain('投影結束')
    expect(mockProjectionSend).not.toHaveBeenCalledWith(
      'file:render-status',
      expect.objectContaining({ contentRevision: 3, status: 'ready' })
    )
  })

  it('retains a usable PDF while its same-item source renewal loads and renders', async () => {
    const first = mockPdf(3)
    const props = {
      initialItemId: 'pdf',
      initialBlobId: 'blob',
      initialMimeType: 'application/pdf'
    }
    const { container, rerender } = render(
      <FileProjection {...props} initialStreamUrl="https://source/old" initialContentRevision={1} />
    )
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const originalCanvas = container.querySelector('canvas')
    const next = mockPdf(3, true)
    rerender(
      <FileProjection {...props} initialStreamUrl="https://source/new" initialContentRevision={2} />
    )
    await waitFor(() => expect(next.renderResolves.has(1)).toBe(true))
    expect(container.querySelector('canvas')).toBe(originalCanvas)
    expect(first.pdf.loadingTask.destroy).not.toHaveBeenCalled()
    await act(async () => next.renderResolves.get(1)?.())
    await waitFor(() => expect(container.querySelector('canvas')).not.toBe(originalCanvas))
    expect(first.pdf.loadingTask.destroy).toHaveBeenCalledOnce()
  })

  it('retains the latest page controls while the document is loading', async () => {
    const { pdf } = mockPdf(10)
    let resolvePdf!: (value: typeof pdf) => void
    mockLoadPdfjsLib.mockResolvedValue({
      getDocument: vi.fn(() => ({
        promise: new Promise((resolve) => {
          resolvePdf = resolve
        })
      }))
    })
    const props = {
      initialItemId: 'pdf-id',
      initialBlobId: 'pdf-blob',
      initialMimeType: 'application/pdf'
    }
    const { container, rerender } = render(<FileProjection {...props} />)
    await waitFor(() => expect(resolvePdf).toBeDefined())
    rerender(
      <FileProjection {...props} controlEvent={{ id: 1, data: { action: 'pdfPage', value: 7 } }} />
    )
    await act(async () => resolvePdf(pdf))
    await waitFor(() => expect(container.querySelector('canvas')?.dataset.pdfPage).toBe('7'))
  })

  it('starts a new PDF in the selected reading mode and clamps its page', async () => {
    mockPdf(3)
    const { container } = render(
      <FileProjection
        initialItemId="pdf"
        initialBlobId="blob"
        initialMimeType="application/pdf"
        initialPdf={{ page: 50, scroll: 99, viewMode: 'continuous' }}
      />
    )
    await waitFor(() =>
      expect(container.querySelector('[data-pdf-canvas-host="3"]')).not.toBeNull()
    )
    expect(container.querySelector('.overflow-y-auto')).not.toBeNull()
  })

  it('does not publish a failed old document after replacement or end', async () => {
    let rejectPdf!: (reason: Error) => void
    const destroyLoading = vi.fn().mockResolvedValue(undefined)
    mockLoadPdfjsLib.mockResolvedValue({
      getDocument: () => ({
        destroy: destroyLoading,
        promise: new Promise((_resolve, reject) => {
          rejectPdf = reject
        })
      })
    })
    const { container, rerender } = render(
      <FileProjection
        initialItemId="pdf"
        initialBlobId="blob"
        initialMimeType="application/pdf"
        initialContentRevision={1}
      />
    )
    await waitFor(() => expect(rejectPdf).toBeDefined())
    rerender(
      <FileProjection
        initialItemId="image"
        initialBlobId="image"
        initialMimeType="image/png"
        initialContentRevision={2}
      />
    )
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    expect(destroyLoading).toHaveBeenCalledOnce()
    await act(async () => rejectPdf(new Error('obsolete')))
    expect(mockProjectionSend).not.toHaveBeenCalledWith(
      'file:render-status',
      expect.objectContaining({ status: 'failed' })
    )
    act(() => mockProjectionHandlers.get('file:end')?.forEach((handler) => handler(null)))
    expect(container.querySelector('img')).toBeNull()
  })

  it('reports image decode failure to the operator without showing diagnostics to the audience', async () => {
    const { container } = render(
      <FileProjection
        initialItemId="image"
        initialBlobId="blob"
        initialMimeType="image/png"
        fileName="private.png"
        initialContentRevision={4}
      />
    )
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    fireEvent.error(container.querySelector('img')!)
    expect(mockProjectionSend).toHaveBeenCalledWith('file:render-status', {
      itemId: 'image',
      blobId: 'blob',
      contentRevision: 4,
      status: 'failed',
      reason: 'decode-failed'
    })
    expect(container.textContent).not.toContain('private.png')
    expect(container.querySelector('img')).toBeNull()
  })

  it('shows the cached PDF page while the full-resolution document is loading', async () => {
    const { pdf, renderResolves } = mockPdf(1, true)
    let resolvePdf: ((value: typeof pdf) => void) | undefined
    const pdfPromise = new Promise<typeof pdf>((resolve) => {
      resolvePdf = resolve
    })
    mockLoadPdfjsLib.mockResolvedValue({
      getDocument: vi.fn(() => ({ promise: pdfPromise }))
    })
    mockGetPdfPageThumbs.mockResolvedValue(['blob:cached-pdf-page'])

    const { container } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
      />
    )

    const preview = await waitFor(() => {
      const image = container.querySelector<HTMLImageElement>('[data-pdf-preview="1"]')
      expect(image).not.toBeNull()
      return image!
    })
    expect(preview.src).toBe('blob:cached-pdf-page')

    await act(async () => resolvePdf?.(pdf))
    await waitFor(() => expect(renderResolves.has(1)).toBe(true))
    const renderedPreview = container.querySelector<HTMLElement>('[data-pdf-preview="1"]')
    const canvasHost = container.querySelector<HTMLElement>('[data-pdf-canvas-host="1"]')
    expect(renderedPreview).not.toBeNull()
    expect(canvasHost).not.toBeNull()
    expect(canvasHost).not.toContainElement(renderedPreview)
    expect(canvasHost?.parentElement).toBe(renderedPreview?.parentElement)
    expect(container.querySelector('canvas[data-pdf-page="1"]')).toBeNull()

    await act(async () => renderResolves.get(1)?.())
    await waitFor(() => {
      expect(container.querySelector('canvas[data-pdf-page="1"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-pdf-preview="1"]')).toBeNull()
  })

  it('keeps the requested cached PDF page until its full render completes', async () => {
    const { renderResolves } = mockPdf(2, true)
    mockGetPdfPageThumbs.mockResolvedValue(['blob:page-1', 'blob:page-2'])
    const { container, rerender } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
      />
    )
    await waitFor(() => expect(renderResolves.has(1)).toBe(true))

    rerender(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        controlEvent={{ id: 1, data: { action: 'pdfPage', value: 2 } }}
      />
    )
    await waitFor(() => expect(renderResolves.has(2)).toBe(true))
    expect(container.querySelector('[data-pdf-preview="2"]')).not.toBeNull()
    expect(container.querySelector('canvas[data-pdf-page="2"]')).toBeNull()

    await act(async () => renderResolves.get(2)?.())
    await waitFor(() => {
      expect(container.querySelector('canvas[data-pdf-page="2"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-pdf-preview="2"]')).toBeNull()
  })

  it('keeps only pages 48-52 mounted when continuous mode scrolls to page 50', async () => {
    mockPdf()
    const replayState = {
      itemId: 'pdf-id',
      positionSeconds: 0,
      durationSeconds: 0,
      isPlaying: false,
      isEnded: false,
      volume: 1,
      pdfPage: 1,
      pdfScroll: 0,
      pdfViewMode: 'continuous' as const,
      zoom: 1,
      pan: { x: 0, y: 0 }
    }
    const { container, rerender } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        initialReplayState={replayState}
      />
    )

    const oldCanvas = await waitFor(() => {
      const canvas = container.querySelector<HTMLCanvasElement>('canvas[data-pdf-page="1"]')
      expect(canvas).not.toBeNull()
      return canvas!
    })

    rerender(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        initialReplayState={replayState}
        controlEvent={{ id: 1, data: { action: 'pdfScroll', value: 49 } }}
      />
    )

    await waitFor(() => {
      expect(
        Array.from(container.querySelectorAll<HTMLCanvasElement>('canvas')).map(
          (canvas) => canvas.dataset.pdfPage
        )
      ).toEqual(['48', '49', '50', '51', '52'])
    })
    expect(oldCanvas.isConnected).toBe(false)
    expect(container.querySelectorAll('canvas')).toHaveLength(5)
    expect(container.querySelector<HTMLElement>('[data-pdf-spacer="top"]')).toHaveStyle({
      height: '17656px'
    })
  })

  it('cancels continuous PDF renders when their pages leave the window', async () => {
    const { renderCancels } = mockPdf(100, true)
    const replayState = {
      itemId: 'pdf-id',
      positionSeconds: 0,
      durationSeconds: 0,
      isPlaying: false,
      isEnded: false,
      volume: 1,
      pdfPage: 1,
      pdfScroll: 0,
      pdfViewMode: 'continuous' as const,
      zoom: 1,
      pan: { x: 0, y: 0 }
    }
    const { rerender } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        initialReplayState={replayState}
      />
    )

    await waitFor(() => {
      expect(renderCancels.has(1)).toBe(true)
    })

    rerender(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        initialReplayState={replayState}
        controlEvent={{ id: 1, data: { action: 'pdfScroll', value: 49 } }}
      />
    )

    await waitFor(() => {
      expect(renderCancels.get(1)).toHaveBeenCalledOnce()
    })
  })

  it('keeps the newer PDF when the same item loads a different blob', async () => {
    const oldPdf = mockPdf(1).pdf
    const newPdf = mockPdf(1).pdf
    let resolveOldPdf: ((pdf: typeof oldPdf) => void) | undefined
    const oldPdfPromise = new Promise<typeof oldPdf>((resolve) => {
      resolveOldPdf = resolve
    })
    mockGetFileSource.mockImplementation(async (_db, blobId: string) => ({
      url: `blob:${blobId}`,
      revoke: vi.fn()
    }))
    const getDocument = vi.fn(({ url }: { url: string }) => ({
      promise: url === 'blob:old-blob' ? oldPdfPromise : Promise.resolve(newPdf)
    }))
    mockLoadPdfjsLib.mockResolvedValue({
      getDocument
    })

    const { rerender } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="old-blob"
        initialMimeType="application/pdf"
      />
    )

    await waitFor(() => {
      expect(getDocument).toHaveBeenCalledWith({ url: 'blob:old-blob' })
    })

    rerender(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="new-blob"
        initialMimeType="application/pdf"
      />
    )

    await waitFor(() => {
      expect(newPdf.getPage).toHaveBeenCalledWith(1)
    })
    await act(async () => {
      resolveOldPdf?.(oldPdf)
      await oldPdfPromise
    })

    await waitFor(() => {
      expect(oldPdf.loadingTask.destroy).toHaveBeenCalledOnce()
    })
    expect(oldPdf.getPage).not.toHaveBeenCalled()
    expect(newPdf.loadingTask.destroy).not.toHaveBeenCalled()
  })

  it('destroys a PDF that resolves after projection unmount', async () => {
    const pdf = mockPdf(1).pdf
    let resolvePdf: ((value: typeof pdf) => void) | undefined
    const pdfPromise = new Promise<typeof pdf>((resolve) => {
      resolvePdf = resolve
    })
    const getDocument = vi.fn(() => ({ promise: pdfPromise }))
    mockLoadPdfjsLib.mockResolvedValue({ getDocument })

    const { unmount } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
      />
    )

    await waitFor(() => {
      expect(getDocument).toHaveBeenCalledWith({ url: 'blob:projection-source' })
    })
    unmount()
    await act(async () => {
      resolvePdf?.(pdf)
      await pdfPromise
    })

    await waitFor(() => {
      expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce()
    })
    expect(pdf.getPage).not.toHaveBeenCalled()
  })

  it('handles a pending getPage rejection after PDF disposal', async () => {
    const { pdf } = mockPdf(1)
    let rejectPage: ((error: Error) => void) | undefined
    const pagePromise = new Promise<never>((_resolve, reject) => {
      rejectPage = reject
    })
    pdf.getPage.mockReturnValue(pagePromise)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { unmount } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
      />
    )

    await waitFor(() => {
      expect(pdf.getPage).toHaveBeenCalledWith(1)
    })
    unmount()
    await act(async () => {
      rejectPage?.(new Error('Worker was destroyed'))
      await Promise.resolve()
    })

    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('preserves the final page fraction in continuous PDF scroll', async () => {
    mockPdf()
    const { container } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        initialReplayState={{
          itemId: 'pdf-id',
          positionSeconds: 0,
          durationSeconds: 0,
          isPlaying: false,
          isEnded: false,
          volume: 1,
          pdfPage: 100,
          pdfScroll: 99.5,
          pdfViewMode: 'continuous',
          zoom: 1,
          pan: { x: 0, y: 0 }
        }}
      />
    )

    await waitFor(() => {
      const scrollContainer = container.querySelector<HTMLElement>('.overflow-y-auto')
      expect(scrollContainer?.scrollTop).toBe(37420)
    })
  })

  it('recomputes continuous PDF spacers and scroll after container resize', async () => {
    const { pdf } = mockPdf()
    const replayState = {
      itemId: 'pdf-id',
      positionSeconds: 0,
      durationSeconds: 0,
      isPlaying: false,
      isEnded: false,
      volume: 1,
      pdfPage: 50,
      pdfScroll: 49,
      pdfViewMode: 'continuous' as const,
      zoom: 1,
      pan: { x: 0, y: 0 }
    }
    const { container, unmount } = render(
      <FileProjection
        fileName="slides.pdf"
        initialItemId="pdf-id"
        initialBlobId="pdf-blob"
        initialMimeType="application/pdf"
        initialReplayState={replayState}
      />
    )

    const scrollContainer = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('.overflow-y-auto')
      expect(element).not.toBeNull()
      expect(resizeObserverCallback).toBeTypeOf('function')
      expect(pdf.getPage).toHaveBeenCalledTimes(100)
      return element!
    })
    const getPageCallsBeforeResize = pdf.getPage.mock.calls.length
    let containerWidth = 640
    Object.defineProperty(scrollContainer, 'clientWidth', {
      configurable: true,
      get: () => containerWidth
    })

    act(() => resizeObserverCallback?.([], {} as ResizeObserver))
    containerWidth = 320
    act(() => resizeObserverCallback?.([], {} as ResizeObserver))

    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('[data-pdf-spacer="top"]')).toHaveStyle({
        height: '9196px'
      })
      expect(scrollContainer.scrollTop).toBe(9620)
    })
    expect(container.querySelectorAll('canvas')).toHaveLength(5)
    expect(pdf.getPage).toHaveBeenCalledTimes(getPageCallsBeforeResize)

    unmount()
    expect(resizeObserverDisconnect).toHaveBeenCalledOnce()
  })
})
