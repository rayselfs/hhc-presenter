import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItemRecord } from '@shared/types/folder'
import { presentMediaItem } from '@renderer/lib/projection-actions'
import ImagePreview from '../ImagePreview'
import VideoPreview from '../VideoPreview'

const { mockGetFileSource, mockNext, mockExit, mockT, mockSendCommand } = vi.hoisted(() => ({
  mockGetFileSource: vi.fn(),
  mockNext: vi.fn(),
  mockExit: vi.fn(),
  mockT: (key: string) => key,
  mockSendCommand: vi.fn()
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: mockT })
}))

vi.mock('@heroui/react/toast', () => ({
  toast: { warning: vi.fn() }
}))

vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: vi.fn().mockResolvedValue({}),
  getFileSource: mockGetFileSource
}))

vi.mock('@renderer/contexts/PresenterCommandContext', () => ({
  usePresenterCommands: () => ({
    sendCommand: mockSendCommand,
    cancelPreparation: mockExit,
    thumbnails: { 'copy-id': 'blob:poster' }
  })
}))

const storeState = {
  sessionRevision: 1,
  projectionRetryRevision: 0,
  zoomLevel: 1,
  pan: { x: 0, y: 0 },
  snapshot: null as null | {
    entries: Array<{
      itemId: string
      sourceUrl: string
      seekable?: boolean
      playbackMode?: 'native' | 'vlc-embedded'
      remoteSource?: {
        providerConnectionId: string
        remoteItemId: string
        rootRemoteFolderId: string
        etag: string
      }
      remoteItem?: {
        providerConnectionId: string
        remoteItemId: string
        rootRemoteFolderId: string
      }
    }>
  },
  typeStates: {} as {
    video?: {
      phase?: 'preparing' | 'ready' | 'playing' | 'paused' | 'ended'
      preparationPhase?: 'inspection' | 'remux' | 'player'
      hasStarted?: boolean
      isPlaying?: boolean
      isEnded?: boolean
      currentTime?: number
      duration?: number
      seekable?: boolean
      volume?: number
    }
  },
  setTypeState: vi.fn(),
  next: mockNext,
  exit: mockExit,
  canNext: () => true
}
const storeListeners = new Set<(state: typeof storeState) => void>()

function notifyStore(): void {
  for (const listener of storeListeners) listener(storeState)
}

vi.mock('@renderer/stores/media-projection', () => ({
  useMediaProjectionStore: Object.assign(
    vi.fn((selector: (state: typeof storeState) => unknown) => selector(storeState)),
    {
      getState: () => storeState,
      subscribe: (listener: (state: typeof storeState) => void) => {
        storeListeners.add(listener)
        return () => storeListeners.delete(listener)
      }
    }
  )
}))

function makeCopy(mimeType: string, name: string): FileItemRecord {
  return {
    id: 'copy-id',
    parentId: 'folder-id',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name,
    url: 'blob:original-id',
    size: 1,
    mimeType
  }
}

function setRemoteSource(sourceUrl: string): void {
  storeState.snapshot = {
    entries: [
      {
        itemId: 'copy-id',
        sourceUrl,
        remoteSource: {
          providerConnectionId: 'hhc-line:user-1',
          remoteItemId: 'asset-1',
          rootRemoteFolderId: 'collection-1',
          etag: 'etag-1'
        },
        remoteItem: {
          providerConnectionId: 'hhc-line:user-1',
          remoteItemId: 'asset-1',
          rootRemoteFolderId: 'collection-1'
        }
      }
    ]
  }
}

function setPendingRemoteSource(): void {
  storeState.snapshot = {
    entries: [
      {
        itemId: 'copy-id',
        sourceUrl: 'hhc-line:asset-1',
        remoteItem: {
          providerConnectionId: 'hhc-line:user-1',
          remoteItemId: 'asset-1',
          rootRemoteFolderId: 'collection-1'
        }
      }
    ]
  }
}

function setVlcPlaybackMode(): void {
  storeState.snapshot = {
    entries: [
      {
        itemId: 'copy-id',
        sourceUrl: 'blob:original-id',
        playbackMode: 'vlc-embedded'
      }
    ]
  }
}

async function presentRemoteItem(item: FileItemRecord, sourceUrl: string): Promise<void> {
  const navigate = vi.fn()
  await expect(
    presentMediaItem({
      item,
      playlist: [item],
      start: async () => {
        setRemoteSource(sourceUrl)
        return {
          summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
          items: [
            {
              itemId: item.id,
              blobId: 'original-id',
              status: 'ready',
              reason: 'ready-remote',
              support: 'native'
            }
          ]
        }
      },
      navigate
    })
  ).resolves.toBeNull()
  expect(navigate).toHaveBeenCalledWith('/media')
}

function seekRelative(seconds: number): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('media:videoSeekRelative', { detail: { seconds } }))
  })
}

async function getLoadedVideo(container: HTMLElement): Promise<HTMLVideoElement> {
  const video = await waitFor(() => {
    const element = container.querySelector('video')
    expect(element).not.toBeNull()
    return element!
  })
  Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
  Object.defineProperty(video, 'duration', { configurable: true, value: 100 })
  fireEvent.loadedMetadata(video)
  video.currentTime = 30
  return video
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { projectionVlc: { getPreviewFrame: vi.fn().mockResolvedValue(null) } }
  })
  storeState.sessionRevision = 1
  storeState.projectionRetryRevision = 0
  storeState.snapshot = null
  storeState.typeStates = {}
  mockGetFileSource.mockResolvedValue({
    url: 'blob:resolved-source',
    revoke: vi.fn()
  })
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  HTMLMediaElement.prototype.pause = vi.fn()
})

describe('copied media preview identity', () => {
  it('loads a copied image by its original blob identity', async () => {
    render(<ImagePreview item={makeCopy('image/png', 'copy.png')} />)

    await waitFor(() => {
      expect(mockGetFileSource).toHaveBeenCalledWith({}, 'original-id', 'image/png')
    })
    expect(screen.getByAltText('copy.png')).toHaveAttribute('src', 'blob:resolved-source')
  })

  it('loads a copied video by its original blob identity', async () => {
    const { container } = render(<VideoPreview item={makeCopy('video/mp4', 'copy.mp4')} />)

    await waitFor(() => {
      expect(mockGetFileSource).toHaveBeenCalledWith({}, 'original-id', 'video/mp4')
    })
    expect(container.querySelector('video')).toHaveAttribute('src', 'blob:resolved-source')
  })

  it('keeps local audio on the existing Blob-backed controller path', async () => {
    const { container } = render(<VideoPreview item={makeCopy('audio/mpeg', 'copy.mp3')} />)

    await waitFor(() => {
      expect(mockGetFileSource).toHaveBeenCalledWith({}, 'original-id', 'audio/mpeg')
    })
    expect(container.querySelector('audio')).toHaveAttribute('src', 'blob:resolved-source')
  })

  it('uses the persistent native blob and existing controls after a remote VLC download', async () => {
    const item = makeCopy('video/x-matroska', 'movie.mkv')
    storeState.snapshot = {
      entries: [{ itemId: item.id, sourceUrl: item.url, seekable: true }]
    }
    const { container } = render(<VideoPreview item={item} />)

    await waitFor(() => {
      expect(mockGetFileSource).toHaveBeenCalledWith({}, 'original-id', 'video/x-matroska')
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:resolved-source')
    })
    fireEvent.click(container.querySelector('button')!)
    expect(mockSendCommand).toHaveBeenCalledWith({ action: 'play', itemId: item.id })
  })

  it.each([
    ['image/png', 'photo.png', 'img'],
    ['video/mp4', 'movie.mp4', 'video'],
    ['audio/mpeg', 'song.mp3', 'audio']
  ])(
    'uses the current browser ticket in the operator %s controller without reading IndexedDB',
    async (mimeType, name, selector) => {
      const sourceUrl = 'https://www.alive.org.tw/api/assets/content?ticket=browser-secret'
      const Component = mimeType.startsWith('image/') ? ImagePreview : VideoPreview
      const item = makeCopy(mimeType, name)
      await presentRemoteItem(item, sourceUrl)

      const { container } = render(<Component item={item} />)

      await waitFor(() => {
        expect(container.querySelector(selector)).toHaveAttribute('src', sourceUrl)
      })
      expect(mockGetFileSource).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['image/png', 'photo.png'],
    ['video/mp4', 'movie.mp4'],
    ['audio/mpeg', 'song.mp3'],
    ['video/x-matroska', 'movie.mkv']
  ])(
    'does not fall back to IndexedDB while the remote %s source is preparing',
    async (mimeType, name) => {
      setPendingRemoteSource()

      render(
        mimeType.startsWith('image/') ? (
          <ImagePreview item={makeCopy(mimeType, name)} />
        ) : (
          <VideoPreview item={makeCopy(mimeType, name)} />
        )
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(mockGetFileSource).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['image/png', 'photo.png', 'img'],
    ['video/mp4', 'movie.mp4', 'video'],
    ['audio/mpeg', 'song.mp3', 'audio']
  ])(
    'uses the current Electron lease in the operator %s controller without reading IndexedDB',
    async (mimeType, name, selector) => {
      const sourceUrl = 'hhc-media://lease/11111111-1111-4111-8111-111111111111'
      const Component = mimeType.startsWith('image/') ? ImagePreview : VideoPreview
      const item = makeCopy(mimeType, name)
      await presentRemoteItem(item, sourceUrl)

      const { container } = render(<Component item={item} />)

      await waitFor(() => {
        expect(container.querySelector(selector)).toHaveAttribute('src', sourceUrl)
      })
      expect(mockGetFileSource).not.toHaveBeenCalled()
    }
  )

  it('reloads the operator audio controller when its ticket is renewed', async () => {
    setRemoteSource('https://www.alive.org.tw/api/assets/content?ticket=first')
    const item = makeCopy('audio/mpeg', 'song.mp3')
    const { container, rerender } = render(<VideoPreview item={item} />)
    await waitFor(() => {
      expect(container.querySelector('audio')).toHaveAttribute(
        'src',
        'https://www.alive.org.tw/api/assets/content?ticket=first'
      )
    })

    setRemoteSource('https://www.alive.org.tw/api/assets/content?ticket=second')
    rerender(<VideoPreview item={item} />)

    await waitFor(() => {
      expect(container.querySelector('audio')).toHaveAttribute(
        'src',
        'https://www.alive.org.tw/api/assets/content?ticket=second'
      )
    })
    fireEvent.click(container.querySelector('button')!)
    expect(mockSendCommand).toHaveBeenCalledWith({ action: 'play', itemId: 'copy-id' })
  })

  it('does not confirm durable video playback state from a requested play', async () => {
    const { container } = render(<VideoPreview item={makeCopy('video/mp4', 'copy.mp4')} />)

    await waitFor(() => {
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:resolved-source')
    })
    storeState.setTypeState.mockClear()

    const playButton = container.querySelector('button')
    expect(playButton).not.toBeNull()
    fireEvent.click(playButton!)

    expect(storeState.setTypeState).not.toHaveBeenCalled()
  })

  it('renders projection playback state as the authoritative control state', async () => {
    const item = makeCopy('video/x-matroska', 'movie.mkv')
    const { container, rerender } = render(<VideoPreview item={item} />)

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    storeState.typeStates.video = {
      hasStarted: true,
      isPlaying: false,
      isEnded: true,
      currentTime: 42,
      duration: 183
    }
    rerender(<VideoPreview item={item} />)

    expect(screen.getByText('00:42 / 03:03')).toBeInTheDocument()
    expect(container.querySelector('input.video-seek-range')).toHaveValue('42')
  })

  it('renders actual live frames and ignores an old item response after switching', async () => {
    setVlcPlaybackMode()
    const capture = vi.fn()
    let deliver: ((frame: unknown) => void) | undefined
    capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { projectionVlc: { getPreviewFrame: capture } }
    })
    const item = makeCopy('video/x-matroska', 'live.mkv')
    const { container, rerender } = render(<VideoPreview item={item} />)
    expect(capture).toHaveBeenCalledWith(item.id)
    await act(async () => {
      deliver?.({ itemId: item.id, imageDataUrl: 'data:image/png;base64,bGl2ZQ==' })
    })
    expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,bGl2ZQ==')
    expect(screen.getByText('presenter.videoLivePreview')).toBeVisible()
    rerender(<VideoPreview item={{ ...item, id: 'next-item' }} />)
    expect(container.querySelector('img')).toBeNull()
  })

  it('clears live frames on null responses and isolates same-item retries', async () => {
    vi.useFakeTimers()
    try {
      setVlcPlaybackMode()
      const item = makeCopy('video/x-matroska', 'live.mkv')
      const capture = vi
        .fn()
        .mockResolvedValueOnce({ itemId: item.id, imageDataUrl: 'data:image/png;base64,bGl2ZQ==' })
        .mockResolvedValue(null)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { projectionVlc: { getPreviewFrame: capture } }
      })
      const { container, rerender } = render(<VideoPreview item={item} />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(container.querySelector('img')).toHaveAttribute('data-vlc-live-preview', 'true')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(container.querySelector('img')).toHaveAttribute('data-vlc-live-preview', 'false')
      let deliverOld: ((value: unknown) => void) | undefined
      capture.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliverOld = resolve
          })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      storeState.projectionRetryRevision += 1
      rerender(<VideoPreview item={item} />)
      await act(async () => {
        deliverOld?.({ itemId: item.id, imageDataUrl: 'data:image/png;base64,c3RhbGU=' })
      })
      expect(container.querySelector('img')).toHaveAttribute('src', 'blob:poster')
      expect(screen.queryByText('presenter.videoLivePreview')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends play without starting Chromium for a VLC-owned item', async () => {
    setVlcPlaybackMode()
    storeState.typeStates.video = {
      phase: 'ready',
      hasStarted: false,
      isPlaying: false,
      isEnded: false,
      currentTime: 0,
      duration: 81,
      seekable: true
    }
    const { container } = render(<VideoPreview item={makeCopy('video/x-matroska', 'movie.mkv')} />)
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:poster')
    expect(screen.getByText('presenter.videoLivePreviewWaiting')).toBeVisible()

    fireEvent.click(container.querySelector('button.absolute.inset-0.flex')!)

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(mockSendCommand).toHaveBeenCalledWith({ action: 'play', itemId: 'copy-id' })
  })

  it('keeps VLC pause and seek projection-authoritative', async () => {
    setVlcPlaybackMode()
    storeState.typeStates.video = {
      phase: 'playing',
      hasStarted: true,
      isPlaying: true,
      isEnded: false,
      currentTime: 30,
      duration: 100,
      seekable: true
    }
    const { container } = render(<VideoPreview item={makeCopy('video/x-matroska', 'movie.mkv')} />)
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:poster')
    expect(screen.getByText('presenter.videoLivePreviewWaiting')).toBeVisible()

    fireEvent.click(screen.getByLabelText('fileExplorer.presenter.togglePlay'))
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
    expect(mockSendCommand).toHaveBeenCalledWith({ action: 'pause', itemId: 'copy-id' })

    mockSendCommand.mockClear()
    seekRelative(5)
    expect(mockSendCommand).toHaveBeenCalledWith({ action: 'seek', itemId: 'copy-id', value: 35 })
  })

  it('shows preparation without claiming playback for a VLC-owned item', () => {
    setVlcPlaybackMode()
    storeState.typeStates.video = {
      phase: 'preparing',
      preparationPhase: 'remux',
      hasStarted: false,
      isPlaying: false,
      isEnded: false,
      currentTime: 0,
      duration: 81
    }

    const { container } = render(<VideoPreview item={makeCopy('video/x-matroska', 'movie.mkv')} />)

    expect(screen.getByRole('status')).toHaveTextContent('presenter.videoRemuxing')
    expect(container.querySelector('button.absolute.inset-0.flex')).toBeNull()
    expect(screen.queryByLabelText('fileExplorer.presenter.togglePlay')).toBeNull()
    fireEvent.click(screen.getByText('presenter.videoCancelPreparation'))
    expect(mockExit).toHaveBeenCalledOnce()
    expect(mockSendCommand).not.toHaveBeenCalled()
  })

  it('hides the central button after owner-confirmed playback starts', async () => {
    const item = makeCopy('video/x-matroska', 'movie.mkv')
    storeState.typeStates.video = {
      hasStarted: true,
      isPlaying: true,
      isEnded: false,
      currentTime: 0,
      duration: 120,
      seekable: true
    }
    const { container } = render(<VideoPreview item={item} />)
    await getLoadedVideo(container)

    expect(container.querySelector('button.absolute.inset-0.flex')).toBeNull()
    expect(container.querySelector('input.video-seek-range')).toBeEnabled()
  })

  it('shows a disabled timeline when duration is known but seek is unavailable', async () => {
    const item = makeCopy('video/x-matroska', 'movie.mkv')
    storeState.typeStates.video = {
      hasStarted: false,
      isPlaying: false,
      isEnded: false,
      currentTime: 0,
      duration: 120,
      seekable: false
    }
    const { container } = render(<VideoPreview item={item} />)
    await getLoadedVideo(container)

    expect(container.querySelector('input.video-seek-range')).toBeDisabled()
  })

  it('seeks a video relative to the current playback time', async () => {
    const { container } = render(<VideoPreview item={makeCopy('video/mp4', 'copy.mp4')} />)

    const video = await getLoadedVideo(container)

    seekRelative(5)

    expect(video.currentTime).toBe(35)
    expect(mockSendCommand).toHaveBeenCalledWith({ action: 'seek', itemId: 'copy-id', value: 35 })
  })

  it('disables pointer and relative seek until projection confirms seekability', async () => {
    const item = makeCopy('video/x-matroska', 'movie.mkv')
    storeState.typeStates.video = {
      hasStarted: true,
      isPlaying: false,
      isEnded: false,
      currentTime: 30,
      duration: 100,
      seekable: false
    }
    const { container } = render(<VideoPreview item={item} />)
    const video = await getLoadedVideo(container)
    mockSendCommand.mockClear()

    expect(container.querySelector('input.video-seek-range')).toBeDisabled()
    seekRelative(5)

    expect(video.currentTime).toBe(30)
    expect(mockSendCommand).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'seek' }))
  })

  it('keeps a requested seek visible until confirmed playback time arrives', async () => {
    const item = makeCopy('video/x-matroska', 'movie.mkv')
    storeState.typeStates.video = {
      hasStarted: true,
      isPlaying: false,
      isEnded: false,
      currentTime: 30,
      duration: 100,
      seekable: true
    }
    const { container, rerender } = render(<VideoPreview item={item} />)
    await getLoadedVideo(container)

    seekRelative(5)
    expect(container.querySelector('input.video-seek-range')).toHaveValue('35')

    storeState.typeStates.video = {
      ...storeState.typeStates.video,
      currentTime: 34.5
    }
    act(() => notifyStore())
    rerender(<VideoPreview item={item} />)
    expect(container.querySelector('input.video-seek-range')).toHaveValue('34.5')
  })

  it('shows accumulated video seek feedback for repeated same-direction jumps', async () => {
    const { container } = render(<VideoPreview item={makeCopy('video/mp4', 'copy.mp4')} />)
    await getLoadedVideo(container)

    seekRelative(5)
    expect(screen.getByTestId('video-seek-flash')).toHaveTextContent('+5')

    seekRelative(5)
    expect(screen.getByTestId('video-seek-flash')).toHaveTextContent('+10')

    seekRelative(-5)
    expect(screen.getByTestId('video-seek-flash')).toHaveTextContent('-5')
  })

  it('resets accumulated video seek feedback after the flash timeout', async () => {
    const { container } = render(<VideoPreview item={makeCopy('video/mp4', 'copy.mp4')} />)
    await getLoadedVideo(container)

    vi.useFakeTimers()
    try {
      seekRelative(5)
      seekRelative(5)
      expect(screen.getByTestId('video-seek-flash')).toHaveTextContent('+10')

      act(() => {
        vi.advanceTimersByTime(1100)
      })
      expect(screen.queryByTestId('video-seek-flash')).toBeNull()

      seekRelative(5)
      expect(screen.getByTestId('video-seek-flash')).toHaveTextContent('+5')
    } finally {
      vi.useRealTimers()
    }
  })

  it('blurs the seek range after pointer release so keyboard shortcuts resume', async () => {
    const { container } = render(<VideoPreview item={makeCopy('video/mp4', 'copy.mp4')} />)

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })
    fireEvent.loadedMetadata(video)

    const playButton = container.querySelector('button')
    expect(playButton).not.toBeNull()
    fireEvent.click(playButton!)

    const seekRange = container.querySelector<HTMLInputElement>('input.video-seek-range')
    expect(seekRange).not.toBeNull()
    seekRange!.focus()
    expect(document.activeElement).toBe(seekRange)

    fireEvent.pointerUp(seekRange!, { pointerId: 1 })

    expect(document.activeElement).not.toBe(seekRange)
  })

  it('pauses a playing video through the pause-only media event', async () => {
    const { container } = render(<VideoPreview item={makeCopy('video/mp4', 'copy.mp4')} />)

    const video = await waitFor(() => {
      const element = container.querySelector('video')
      expect(element).not.toBeNull()
      return element!
    })
    fireEvent.play(video)

    window.dispatchEvent(new CustomEvent('media:pauseVideo'))

    expect(video.pause).toHaveBeenCalled()
    expect(mockSendCommand).toHaveBeenCalledWith({ action: 'pause', itemId: 'copy-id' })
  })

  it('keeps the presenter open and retries a failed media load', async () => {
    mockGetFileSource.mockResolvedValueOnce(null).mockResolvedValueOnce({
      url: 'blob:retry-source',
      revoke: vi.fn()
    })
    render(<ImagePreview item={makeCopy('image/png', 'copy.png')} />)

    const retry = await screen.findByRole('button', { name: 'presenter.retryPreview' })
    expect(mockNext).not.toHaveBeenCalled()
    expect(mockExit).not.toHaveBeenCalled()

    fireEvent.click(retry)

    await waitFor(() => {
      expect(mockGetFileSource).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByAltText('copy.png')).toHaveAttribute('src', 'blob:retry-source')
  })
})
