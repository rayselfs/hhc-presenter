import { act, renderHook } from '@testing-library/react'
import { createProjectionAdapter, type ProjectionAdapter } from '@renderer/lib/projection-adapter'
import type { ProjectionVlcFailure } from '@shared/ipc-channels'
import type {
  ProjectionChannel,
  ProjectionLifecycleEvent,
  ProjectionPayload
} from '@shared/projection-messages'

vi.mock('@renderer/lib/file-explorer-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/file-explorer-db')>()),
  getFileBlobRecord: vi.fn(async () => ({ storage: 'native-fs' }))
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: vi.fn(() => false)
}))

type TestAdapter = ProjectionAdapter & {
  _trigger<C extends ProjectionChannel>(channel: C, data: ProjectionPayload<C>): void
  _reset(): void
}

const mockAdapter: TestAdapter = (() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>()
  let generation = 0
  return {
    setGeneration: vi.fn((nextGeneration: number) => {
      generation = nextGeneration
    }),
    getGeneration: vi.fn(() => generation),
    send: vi.fn(),
    on: vi.fn((channel: string, handler: (data: unknown) => void) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set())
      handlers.get(channel)?.add(handler)
      return () => handlers.get(channel)?.delete(handler)
    }),
    dispose: vi.fn(),
    _trigger(channel, data) {
      handlers.get(channel)?.forEach((handler) => handler(data))
    },
    _reset() {
      generation = 0
      handlers.clear()
    }
  } as TestAdapter
})()

vi.mock('@renderer/lib/projection-adapter', () => ({
  createProjectionAdapter: vi.fn(() => mockAdapter)
}))

import { getFileBlobRecord } from '@renderer/lib/file-explorer-db'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { isElectron } from '@renderer/lib/env'
import { ProjectionProvider, useProjection } from '../ProjectionContext'

const mockWindowOpen = vi.fn<(url?: string, target?: string) => Window | null>()
const originalOpen = window.open
const originalFocus = window.focus

function renderProjection(): ReturnType<
  typeof renderHook<ReturnType<typeof useProjection>, unknown>
> {
  return renderHook(() => useProjection(), { wrapper: ProjectionProvider })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockAdapter._reset()
  window.open = mockWindowOpen as unknown as typeof window.open
  window.focus = vi.fn()
  mockWindowOpen.mockReturnValue({
    closed: false,
    close: vi.fn(),
    blur: vi.fn()
  } as unknown as Window)
})

afterEach(() => {
  vi.useRealTimers()
  window.open = originalOpen
  window.focus = originalFocus
})

describe('ProjectionContext web recovery', () => {
  const mockProjectionVlcStop = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        projectionVlc: {
          stop: mockProjectionVlcStop
        }
      }
    })
  })

  it('does not open projection on mount', () => {
    renderProjection()
    expect(mockWindowOpen).not.toHaveBeenCalled()
  })

  it('opens a session-isolated browser projection window', () => {
    const { result } = renderProjection()

    act(() => {
      void result.current.startProjection('timer')
    })

    const [url, target] = mockWindowOpen.mock.calls[0]
    const sessionId = new URLSearchParams(String(url).split('?')[1]).get('session')
    expect(sessionId).toMatch(/^[0-9a-f-]+$/i)
    expect(target).toBe(`hhc-projection-${sessionId}`)
    expect(createProjectionAdapter).toHaveBeenCalledWith('main', sessionId)
  })

  it('returns popup-blocked and keeps a retryable failed state', async () => {
    mockWindowOpen.mockReturnValue(null)
    const { result } = renderProjection()
    let operation

    await act(async () => {
      operation = await result.current.startProjection('timer', [
        ['timer:overtime-message', { message: 'saved' }]
      ])
    })

    expect(operation).toEqual({ ok: false, generation: 1, reason: 'popup-blocked' })
    expect(result.current.recovery).toEqual({
      status: 'failed',
      generation: 1,
      failure: { generation: 1, reason: 'popup-blocked' }
    })
  })

  it('resolves a start only after matching ready and replays the snapshot', async () => {
    const { result } = renderProjection()
    let operationPromise: ReturnType<typeof result.current.startProjection>

    act(() => {
      operationPromise = result.current.startProjection('timer', [
        ['timer:overtime-message', { message: 'saved' }]
      ])
    })
    expect(mockAdapter.send).not.toHaveBeenCalled()

    act(() => {
      mockAdapter._trigger('__system:ready', { generation: 1 })
    })

    await expect(operationPromise!).resolves.toEqual({ ok: true, generation: 1 })
    expect(mockAdapter.send).toHaveBeenCalledWith(
      '__system:replay',
      expect.objectContaining({ generation: 1 })
    )
  })

  it('ignores stale ready and reports a five-second timeout', async () => {
    const { result } = renderProjection()
    let operationPromise: ReturnType<typeof result.current.startProjection>

    act(() => {
      operationPromise = result.current.startProjection('timer')
      mockAdapter._trigger('__system:ready', { generation: 2 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    await expect(operationPromise!).resolves.toEqual({
      ok: false,
      generation: 1,
      reason: 'ready-timeout'
    })
  })

  it('retries a blocked popup with a newer generation', async () => {
    mockWindowOpen.mockReturnValueOnce(null)
    const { result } = renderProjection()
    await act(async () => {
      await result.current.startProjection('bible', [])
    })

    let retryPromise: ReturnType<typeof result.current.retryProjection>
    act(() => {
      retryPromise = result.current.retryProjection()
    })
    act(() => {
      mockAdapter._trigger('__system:ready', { generation: 2 })
    })

    await expect(retryPromise!).resolves.toEqual({ ok: true, generation: 2 })
    expect(mockWindowOpen).toHaveBeenCalledTimes(2)
  })

  it('returns focus to the control window after opening a browser projection', async () => {
    const popup = { closed: false, close: vi.fn(), blur: vi.fn() } as unknown as Window
    mockWindowOpen.mockReturnValue(popup)
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    const { result } = renderProjection()
    let operationPromise: ReturnType<typeof result.current.startProjection>

    act(() => {
      operationPromise = result.current.startProjection('timer')
      mockAdapter._trigger('__system:ready', { generation: 1 })
    })
    await operationPromise!

    expect(popup.blur).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
  })

  it('ends the session when popup polling observes an explicit close', async () => {
    const popup = { closed: false, close: vi.fn(), blur: vi.fn() } as unknown as Window
    mockWindowOpen.mockReturnValue(popup)
    const { result } = renderProjection()
    let operationPromise: ReturnType<typeof result.current.startProjection>
    act(() => {
      operationPromise = result.current.startProjection('timer')
      mockAdapter._trigger('__system:ready', { generation: 1 })
    })
    await operationPromise!

    Object.defineProperty(popup, 'closed', { value: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(result.current.isProjectionOpen).toBe(false)
    expect(result.current.recovery.status).toBe('closed')
  })

  it('blacks out and resumes retained content without focusing or closing projection', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    const { result } = renderProjection()
    let operationPromise: ReturnType<typeof result.current.startProjection>

    act(() => {
      operationPromise = result.current.startProjection('media', [
        [
          'file:show',
          {
            itemId: 'video-1',
            blobId: 'blob-1',
            fileName: 'video.mp4',
            mimeType: 'video/mp4',
            playlist: [],
            currentIndex: 0
          }
        ]
      ])
      mockAdapter._trigger('__system:ready', { generation: 1 })
    })
    await operationPromise!
    focus.mockClear()

    expect(result.current.sessionSummary).toMatchObject({
      owner: 'media',
      status: 'projecting',
      label: 'video.mp4',
      isBlackout: false
    })

    await act(async () => {
      await result.current.blackoutProjection(true)
    })

    expect(mockProjectionVlcStop).toHaveBeenCalledOnce()
    expect(result.current.sessionSummary).toMatchObject({
      owner: 'media',
      status: 'connected',
      label: 'video.mp4',
      isBlackout: true
    })
    expect(mockAdapter.send).toHaveBeenCalledWith('__system:blackout', { enabled: true })

    await act(async () => {
      await result.current.blackoutProjection(false)
    })

    expect(result.current.sessionSummary.status).toBe('projecting')
    expect(result.current.getProjectionSnapshot()?.media.show?.fileName).toBe('video.mp4')
    expect(focus).not.toHaveBeenCalled()
    expect(mockWindowOpen).toHaveBeenCalledOnce()
  })

  it('maps popup failure to a failed session summary', async () => {
    mockWindowOpen.mockReturnValue(null)
    const { result } = renderProjection()

    await act(async () => {
      await result.current.startProjection('timer')
    })

    expect(result.current.sessionSummary).toEqual({
      owner: 'timer',
      status: 'failed',
      label: null,
      isBlackout: false,
      failure: { generation: 1, reason: 'popup-blocked' }
    })
  })
})

describe('ProjectionContext Electron recovery', () => {
  let lifecycleCallback: ((event: ProjectionLifecycleEvent) => void) | null
  let vlcFailureCallback: ((failure: ProjectionVlcFailure) => void) | null
  let vlcStartedCallback: ((generation: number, itemId: string) => void) | null
  let mockCheck: ReturnType<typeof vi.fn>
  let mockEnsure: ReturnType<typeof vi.fn>
  let mockRetry: ReturnType<typeof vi.fn>
  let mockClose: ReturnType<typeof vi.fn>
  const unsubscribeLifecycle = vi.fn()
  const unsubscribeVlcFailure = vi.fn()
  const unsubscribeVlcStarted = vi.fn()

  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(true)
    lifecycleCallback = null
    vlcFailureCallback = null
    vlcStartedCallback = null
    mockCheck = vi.fn(() =>
      Promise.resolve({
        exists: false,
        lifecycle: { generation: 0, status: 'closed', reason: 'user-close' }
      })
    )
    mockEnsure = vi.fn(() => Promise.resolve({ created: true, generation: 4 }))
    mockRetry = vi.fn(() => Promise.resolve({ retried: true, generation: 5 }))
    mockClose = vi.fn(() => Promise.resolve({ closed: true }))

    Object.defineProperty(window, 'api', {
      value: {
        projection: {
          check: mockCheck,
          ensure: mockEnsure,
          retry: mockRetry,
          getGeneration: vi.fn(),
          moveToDisplay: vi.fn(),
          close: mockClose,
          getDisplays: vi.fn(),
          send: vi.fn(),
          sendToMain: vi.fn(),
          onProjectionMessage: vi.fn(() => vi.fn()),
          onProjectionLifecycle: vi.fn((callback: (event: ProjectionLifecycleEvent) => void) => {
            lifecycleCallback = callback
            return unsubscribeLifecycle
          })
        },
        projectionVlc: {
          stop: vi.fn(() => Promise.resolve()),
          onFailure: vi.fn((callback: (failure: ProjectionVlcFailure) => void) => {
            vlcFailureCallback = callback
            return unsubscribeVlcFailure
          }),
          onStarted: vi.fn((callback: (generation: number, itemId: string) => void) => {
            vlcStartedCallback = callback
            return unsubscribeVlcStarted
          })
        }
      },
      configurable: true
    })
  })

  async function startReadyVlcMedia(
    result: ReturnType<typeof renderProjection>['result'],
    itemId = 'item-1'
  ): Promise<void> {
    let startPromise: ReturnType<typeof result.current.startProjection>
    await act(async () => {
      startPromise = result.current.startProjection('media', [
        [
          'file:show',
          {
            itemId,
            blobId: `blob-${itemId}`,
            fileName: `${itemId}.mp4`,
            mimeType: 'video/mp4',
            playlist: [],
            currentIndex: 0,
            playbackMode: 'vlc-embedded'
          }
        ]
      ])
      await Promise.resolve()
    })
    act(() => {
      mockAdapter._trigger('__system:ready', { generation: 4 })
    })
    await act(async () => {
      await startPromise!
    })
  }

  function publishVlcFailure(itemId = 'item-1'): void {
    act(() => {
      vlcFailureCallback?.({
        itemId,
        code: 'playback-failed',
        recoverable: true,
        message: 'VLC playback stopped unexpectedly.'
      })
    })
  }

  it('does not treat an existing window as ready until matching ready arrives', async () => {
    mockCheck.mockResolvedValue({
      exists: true,
      lifecycle: { generation: 4, status: 'opening', reason: 'reload' }
    })
    const { result } = renderProjection()
    await act(async () => Promise.resolve())

    expect(result.current.isProjectionOpen).toBe(true)
    expect(result.current.recovery.status).toBe('opening')
    await act(async () => {
      await result.current.project('timer:overtime-message', { message: 'buffered' })
    })
    expect(mockAdapter.send).not.toHaveBeenCalledWith('timer:overtime-message', expect.anything())
  })

  it('resolves explicit start after the matching Electron ready', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    let operationPromise: ReturnType<typeof result.current.startProjection>

    await act(async () => {
      operationPromise = result.current.startProjection('timer')
      await Promise.resolve()
    })
    act(() => {
      mockAdapter._trigger('__system:ready', { generation: 4 })
    })

    await expect(operationPromise!).resolves.toEqual({ ok: true, generation: 4 })
  })

  it('reflects recovering and failed lifecycle events without foreground actions', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())

    act(() => {
      lifecycleCallback?.({ generation: 4, status: 'recovering', reason: 'renderer-crash' })
    })
    expect(result.current.recovery.status).toBe('recovering')

    act(() => {
      lifecycleCallback?.({ generation: 4, status: 'failed', reason: 'renderer-crash' })
    })
    expect(result.current.recovery).toEqual({
      status: 'failed',
      generation: 4,
      failure: { generation: 4, reason: 'renderer-crash' }
    })
  })

  it('stores only the latest current VLC runtime failure', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    await startReadyVlcMedia(result)

    act(() => {
      vlcFailureCallback?.({
        itemId: 'item-1',
        code: 'media-open-failed',
        recoverable: true,
        message: 'VLC could not open this media.'
      })
      vlcFailureCallback?.({
        itemId: 'item-1',
        code: 'playback-failed',
        recoverable: true,
        message: 'VLC playback stopped unexpectedly.'
      })
    })

    expect(result.current.vlcFailure).toEqual({
      itemId: 'item-1',
      code: 'playback-failed',
      recoverable: true,
      message: 'VLC playback stopped unexpectedly.'
    })
  })

  it('ignores a VLC failure that does not match the current ready media snapshot', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    await startReadyVlcMedia(result)

    publishVlcFailure('item-stale')

    expect(result.current.vlcFailure).toBeNull()
  })

  it('clears the current VLC failure when projection closes', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    await startReadyVlcMedia(result)
    publishVlcFailure()
    expect(result.current.vlcFailure).not.toBeNull()

    await act(async () => {
      await result.current.closeProjection()
    })

    expect(result.current.vlcFailure).toBeNull()
  })

  it('clears the current VLC failure when media switches to an image', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    await startReadyVlcMedia(result)
    publishVlcFailure()

    await act(async () => {
      await result.current.project('file:show', {
        itemId: 'image-1',
        blobId: 'blob-image-1',
        fileName: 'image.png',
        mimeType: 'image/png',
        playlist: [],
        currentIndex: 0,
        playbackMode: 'native'
      })
    })

    expect(result.current.vlcFailure).toBeNull()
  })

  it('clears the current VLC failure when another owner claims projection', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    await startReadyVlcMedia(result)
    publishVlcFailure()

    act(() => {
      result.current.claimProjection('bible')
    })

    expect(result.current.vlcFailure).toBeNull()
  })

  it('clears the current VLC failure when the projection lifecycle is replaced', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    await startReadyVlcMedia(result)
    publishVlcFailure()

    act(() => {
      lifecycleCallback?.({ generation: 5, status: 'opening', reason: 'reload' })
    })

    expect(result.current.vlcFailure).toBeNull()
  })

  it('keeps a VLC failure through replay and a repeated failed start', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    const media = {
      itemId: 'item-1',
      blobId: 'blob-1',
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
      playlist: [],
      currentIndex: 0,
      playbackMode: 'vlc-embedded' as const
    }
    let startPromise: ReturnType<typeof result.current.startProjection>
    await act(async () => {
      startPromise = result.current.startProjection('media', [['file:show', media]])
      await Promise.resolve()
    })
    act(() => {
      mockAdapter._trigger('__system:ready', { generation: 4 })
    })
    await act(async () => {
      await startPromise!
    })
    act(() => {
      vlcFailureCallback?.({
        itemId: 'item-1',
        code: 'playback-failed',
        recoverable: true,
        message: 'VLC playback stopped unexpectedly.'
      })
    })
    mockRetry.mockResolvedValueOnce({ retried: false, generation: 4 })
    vi.mocked(mockAdapter.send).mockClear()

    let retryResult
    await act(async () => {
      retryResult = await result.current.retryProjection()
    })
    expect(retryResult).toEqual({ ok: true, generation: 4 })
    expect(mockRetry).not.toHaveBeenCalled()
    expect(mockAdapter.send).toHaveBeenCalledWith(
      '__system:replay',
      expect.objectContaining({
        generation: 4,
        snapshot: expect.objectContaining({
          media: expect.objectContaining({ show: expect.objectContaining(media) })
        })
      })
    )
    expect(result.current.vlcFailure).not.toBeNull()

    act(() => {
      vlcFailureCallback?.({
        itemId: 'item-1',
        code: 'media-open-failed',
        recoverable: true,
        message: 'VLC could not open this media.'
      })
    })
    expect(result.current.vlcFailure?.code).toBe('media-open-failed')
  })

  it.each([
    ['same-item', 'item-1', 'item-1', 4, false, true],
    ['cross-item', 'item-2', 'item-2', 4, true, true],
    ['stale-item', 'item-2', 'item-1', 4, true, true],
    ['stale-generation', 'item-1', 'item-1', 3, false, false]
  ] as const)(
    'handles a %s VLC started acknowledgement against the current media snapshot',
    async (
      _case,
      currentItemId,
      startedItemId,
      startedGeneration,
      shouldClearOnProject,
      shouldClearAfterStarted
    ) => {
      const { result } = renderProjection()
      await act(async () => Promise.resolve())
      const failedMedia = {
        itemId: 'item-1',
        blobId: 'blob-1',
        fileName: 'video.mp4',
        mimeType: 'video/mp4',
        playlist: [],
        currentIndex: 0,
        playbackMode: 'vlc-embedded' as const
      }
      let startPromise: ReturnType<typeof result.current.startProjection>
      await act(async () => {
        startPromise = result.current.startProjection('media', [['file:show', failedMedia]])
        await Promise.resolve()
      })
      act(() => {
        mockAdapter._trigger('__system:ready', { generation: 4 })
      })
      await act(async () => {
        await startPromise!
      })
      act(() => {
        vlcFailureCallback?.({
          itemId: 'item-1',
          code: 'playback-failed',
          recoverable: true,
          message: 'VLC playback stopped unexpectedly.'
        })
      })
      const currentMedia = {
        ...failedMedia,
        itemId: currentItemId,
        blobId: `blob-${currentItemId}`
      }

      await act(async () => {
        await result.current.project('file:show', currentMedia)
      })
      expect(result.current.vlcFailure === null).toBe(shouldClearOnProject)
      act(() => {
        vlcStartedCallback?.(startedGeneration, startedItemId)
      })

      expect(result.current.vlcFailure === null).toBe(shouldClearAfterStarted)
    }
  )

  it('allocates a new generation for manual Retry', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    act(() => {
      lifecycleCallback?.({ generation: 4, status: 'failed', reason: 'renderer-crash' })
    })
    let retryPromise: ReturnType<typeof result.current.retryProjection>

    act(() => {
      retryPromise = result.current.retryProjection()
    })
    await act(async () => Promise.resolve())
    act(() => {
      mockAdapter._trigger('__system:ready', { generation: 5 })
    })

    await expect(retryPromise!).resolves.toEqual({ ok: true, generation: 5 })
    expect(mockRetry).toHaveBeenCalledOnce()
  })

  it('explicit close clears recovery and invokes Electron close', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    act(() => {
      lifecycleCallback?.({ generation: 4, status: 'opening', reason: 'created' })
    })

    await act(async () => {
      await result.current.closeProjection()
    })

    expect(mockClose).toHaveBeenCalledOnce()
    expect(result.current.recovery.status).toBe('closed')
    expect(mockAdapter.getGeneration()).toBe(0)
  })

  it('retains the active projection session when Electron close fails', async () => {
    const { result } = renderProjection()
    await act(async () => Promise.resolve())
    await startReadyVlcMedia(result)
    mockClose.mockRejectedValue(new Error('close failed'))

    await expect(
      act(async () => {
        await result.current.closeProjection()
      })
    ).rejects.toThrow('close failed')

    expect(result.current.getProjectionSnapshot()?.owner).toBe('media')
    expect(mockAdapter.getGeneration()).toBe(4)
  })

  it('unsubscribes from lifecycle events on cleanup', () => {
    const { unmount } = renderProjection()
    unmount()
    expect(unsubscribeLifecycle).toHaveBeenCalledOnce()
    expect(unsubscribeVlcFailure).toHaveBeenCalledOnce()
    expect(unsubscribeVlcStarted).toHaveBeenCalledOnce()
  })
})

describe('late native decode recovery', () => {
  const show: ProjectionPayload<'file:show'> = {
    itemId: 'video-1',
    blobId: 'blob-1',
    fileName: 'video.mp4',
    mimeType: 'video/mp4',
    playlist: [],
    currentIndex: 0,
    playbackMode: 'native'
  }
  const runtime = vi.fn()
  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(true)
    vi.mocked(getFileBlobRecord).mockResolvedValue({ storage: 'native-fs' } as Awaited<
      ReturnType<typeof getFileBlobRecord>
    >)
    runtime.mockReset().mockResolvedValue({ status: 'ready' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        nativeFs: { exists: vi.fn(async () => true) },
        projection: {
          check: vi.fn(async () => ({
            exists: true,
            lifecycle: { generation: 4, status: 'ready', reason: 'created' }
          })),
          onProjectionLifecycle: vi.fn(() => vi.fn())
        },
        projectionVlc: {
          getInfo: runtime,
          onFailure: vi.fn(() => vi.fn()),
          onStarted: vi.fn(() => vi.fn())
        }
      }
    })
    useMediaProjectionStore.setState({ snapshot: null, isEnded: false })
  })
  async function setup(): Promise<
    ReturnType<typeof renderProjection> & { report: ProjectionPayload<'file:playback-error'> }
  > {
    const hook = renderProjection()
    await act(async () => {
      await Promise.resolve()
      await hook.result.current.startProjection('media', [['file:show', show]])
    })
    const report: ProjectionPayload<'file:playback-error'> = {
      itemId: show.itemId,
      blobId: show.blobId,
      contentRevision: hook.result.current.getProjectionSnapshot()!.media.show!.contentRevision!,
      errorCode: 3,
      currentTime: 23,
      duration: 100,
      transport: 'pause',
      volume: 0.4
    }
    return { ...hook, report }
  }
  it('does not prepare VLC for healthy video and promotes only once on decode failure', async () => {
    const { result, report } = await setup()
    expect(runtime).not.toHaveBeenCalled()
    await act(async () => {
      mockAdapter._trigger('file:playback-error', report)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.getProjectionSnapshot()?.media.show?.playbackMode).toBe('vlc-embedded')
    expect(result.current.getProjectionSnapshot()?.media.state).toMatchObject({
      positionSeconds: 23,
      isPlaying: false,
      volume: 0.4
    })
    await act(async () => {
      mockAdapter._trigger('file:playback-error', report)
    })
    expect(runtime).toHaveBeenCalledOnce()
  })
  it.each(['restart', 'owner-aba', 'session', 'generation', 'item'] as const)(
    'discards %s while runtime awaits',
    async (change) => {
      let resolve!: (value: { status: string }) => void
      runtime.mockReturnValue(
        new Promise((done) => {
          resolve = done
        })
      )
      const { result, report } = await setup()
      await act(async () => {
        mockAdapter._trigger('file:playback-error', report)
        await Promise.resolve()
      })
      expect(runtime).toHaveBeenCalledOnce()
      await act(async () => {
        if (change === 'restart') result.current.send('file:show', show)
        if (change === 'owner-aba') {
          result.current.claimProjection('timer')
          result.current.claimProjection('media')
        }
        if (change === 'session')
          await result.current.startProjection('media', [['file:show', show]])
        if (change === 'generation') mockAdapter.setGeneration(5)
        if (change === 'item') result.current.send('file:show', { ...show, itemId: 'other' })
        resolve({ status: 'ready' })
        await Promise.resolve()
      })
      expect(result.current.getProjectionSnapshot()?.media.show?.playbackMode).toBe('native')
    }
  )
  it.each(['web', 'runtime', 'source'] as const)(
    'reports actionable %s failure without promoting',
    async (failure) => {
      const { result, report } = await setup()
      if (failure === 'web') vi.mocked(isElectron).mockReturnValue(false)
      if (failure === 'runtime') runtime.mockResolvedValue({ status: 'missing' })
      if (failure === 'source') vi.mocked(getFileBlobRecord).mockResolvedValue(undefined)
      await act(async () => {
        mockAdapter._trigger('file:playback-error', report)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.vlcFailure?.message).toBeTruthy()
      expect(result.current.getProjectionSnapshot()?.media.show?.playbackMode).toBe('native')
    }
  )
  it('allows the new projection generation to recover after discarding an older attempt', async () => {
    let resolve!: (value: { status: string }) => void
    runtime.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const { result, report } = await setup()
    await act(async () => {
      mockAdapter._trigger('file:playback-error', report)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(runtime).toHaveBeenCalledOnce()
    await act(async () => {
      const lifecycle = vi.mocked(window.api.projection.onProjectionLifecycle).mock.calls[0][0]
      lifecycle({ generation: 5, status: 'ready', reason: 'reload' })
      resolve({ status: 'ready' })
      await Promise.resolve()
      mockAdapter._trigger('file:playback-error', report)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(runtime).toHaveBeenCalledTimes(2)
    expect(result.current.getProjectionSnapshot()?.media.show?.playbackMode).toBe('vlc-embedded')
  })
  it('keeps newer seek and transport requested during runtime preparation', async () => {
    let resolve!: (value: { status: string }) => void
    runtime.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { result, report } = await setup()
    await act(async () => {
      mockAdapter._trigger('file:playback-error', report)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(runtime).toHaveBeenCalledOnce()
    await act(async () => {
      result.current.send('file:control', { itemId: 'video-1', action: 'seek', value: 70 })
      result.current.send('file:control', { itemId: 'video-1', action: 'play' })
      resolve({ status: 'ready' })
      await Promise.resolve()
    })
    expect(mockAdapter.send).toHaveBeenLastCalledWith(
      '__system:replay',
      expect.objectContaining({
        pendingFileControls: { itemId: 'video-1', seekSeconds: 70, transport: 'play' }
      })
    )
  })
  it('preserves controls acknowledged after the error while runtime preparation awaits', async () => {
    let resolve!: (value: { status: string }) => void
    runtime.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { result, report } = await setup()
    await act(async () => {
      mockAdapter._trigger('file:playback-error', { ...report, transport: 'play', volume: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(runtime).toHaveBeenCalledOnce()
    await act(async () => {
      result.current.send('file:control', { itemId: 'video-1', action: 'seek', value: 70 })
      result.current.send('file:control', { itemId: 'video-1', action: 'pause' })
      result.current.send('file:control', { itemId: 'video-1', action: 'volume', value: 0.2 })
      mockAdapter._trigger('file:playback-state', {
        itemId: 'video-1',
        phase: 'paused',
        currentTime: 70,
        duration: 100,
        isPlaying: false,
        isEnded: false,
        volume: 0.2
      })
      resolve({ status: 'ready' })
      await Promise.resolve()
    })
    expect(result.current.getProjectionSnapshot()?.media.state).toMatchObject({
      positionSeconds: 70,
      isPlaying: false,
      volume: 0.2
    })
    expect(mockAdapter.send).toHaveBeenLastCalledWith(
      '__system:replay',
      expect.objectContaining({
        snapshot: expect.objectContaining({
          media: expect.objectContaining({
            state: expect.objectContaining({ positionSeconds: 70, isPlaying: false, volume: 0.2 })
          })
        })
      })
    )
    expect(vi.mocked(mockAdapter.send).mock.calls.at(-1)?.[1]).not.toHaveProperty(
      'pendingFileControls'
    )
  })
  it('reports an unavailable native file before initializing VLC', async () => {
    const { result, report } = await setup()
    vi.mocked(window.api.nativeFs.exists).mockResolvedValue(false)
    await act(async () => {
      mockAdapter._trigger('file:playback-error', report)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.vlcFailure?.code).toBe('media-open-failed')
    expect(runtime).not.toHaveBeenCalled()
    expect(result.current.getProjectionSnapshot()?.media.show?.playbackMode).toBe('native')
    await act(async () => {
      result.current.send('file:show', show)
    })
    expect(result.current.vlcFailure).toBeNull()
  })
  it('does not recover over the end screen after last Next while runtime awaits', async () => {
    let resolve!: (value: { status: string }) => void
    runtime.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { result, report } = await setup()
    const store = useMediaProjectionStore.getState()
    store.startPresentation(
      [
        {
          id: 'video-1',
          name: 'video.mp4',
          mimeType: 'video/mp4',
          type: 'file',
          sortIndex: 0,
          parentId: 'root',
          size: 1024,
          url: 'blob:blob-1',
          createdAt: 0,
          expiresAt: null
        }
      ],
      0
    )
    const snapshot = useMediaProjectionStore.getState().snapshot!
    await act(async () => {
      mockAdapter._trigger('file:playback-error', report)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(runtime).toHaveBeenCalledOnce()
    vi.mocked(mockAdapter.send).mockClear()
    await act(async () => {
      store.next()
      result.current.send('file:end', null)
      resolve({ status: 'ready' })
      await Promise.resolve()
    })
    expect(useMediaProjectionStore.getState().isEnded).toBe(true)
    expect(useMediaProjectionStore.getState().snapshot).toBe(snapshot)
    expect(result.current.getProjectionSnapshot()?.media.show?.playbackMode).toBe('native')
    expect(mockAdapter.send).not.toHaveBeenCalledWith('__system:replay', expect.anything())
  })
  it('synchronizes the promoted snapshot for later file reprojection', async () => {
    const { result, report } = await setup()
    useMediaProjectionStore.setState({
      isPresenting: true,
      currentIndex: 0,
      snapshot: {
        id: 'session',
        createdAt: 0,
        entries: [
          {
            index: 0,
            itemId: 'video-1',
            blobId: 'blob-1',
            name: 'video.mp4',
            mimeType: 'video/mp4',
            sourceUrl: 'blob:blob-1',
            playbackMode: 'native'
          }
        ]
      }
    })
    await act(async () => {
      mockAdapter._trigger('file:playback-error', report)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useMediaProjectionStore.getState().snapshot?.entries[0].playbackMode).toBe(
      'vlc-embedded'
    )
    expect(result.current.getProjectionSnapshot()?.media.show?.playbackMode).toBe('vlc-embedded')
  })
  it('ignores network/abort and obsolete content reports', async () => {
    const { report, result } = await setup()
    await act(async () => {
      mockAdapter._trigger('file:playback-error', { ...report, errorCode: 1 })
      mockAdapter._trigger('file:playback-error', { ...report, errorCode: 2 })
      mockAdapter._trigger('file:playback-error', {
        ...report,
        contentRevision: report.contentRevision + 1
      })
    })
    expect(runtime).not.toHaveBeenCalled()
    expect(result.current.vlcFailure).toBeNull()
  })
})

it('does not promote from a stale storage await', async () => {
  vi.mocked(isElectron).mockReturnValue(true)
  let resolve!: (value: Awaited<ReturnType<typeof getFileBlobRecord>>) => void
  vi.mocked(getFileBlobRecord).mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const runtime = vi.fn(async () => ({ status: 'ready' }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projection: {
        check: vi.fn(async () => ({
          exists: true,
          lifecycle: { generation: 4, status: 'ready', reason: 'created' }
        })),
        onProjectionLifecycle: vi.fn(() => vi.fn())
      },
      nativeFs: { exists: vi.fn(async () => true) },
      projectionVlc: {
        getInfo: runtime,
        onFailure: vi.fn(() => vi.fn()),
        onStarted: vi.fn(() => vi.fn())
      }
    }
  })
  const { result } = renderProjection()
  const show: ProjectionPayload<'file:show'> = {
    itemId: 'video',
    blobId: 'blob',
    fileName: 'v.mp4',
    mimeType: 'video/mp4',
    playlist: [],
    currentIndex: 0
  }
  await act(async () => {
    await Promise.resolve()
    await result.current.startProjection('media', [['file:show', show]])
  })
  const revision = result.current.getProjectionSnapshot()!.media.show!.contentRevision!
  await act(async () => {
    mockAdapter._trigger('file:playback-error', {
      itemId: 'video',
      blobId: 'blob',
      contentRevision: revision,
      errorCode: 3,
      currentTime: 0,
      duration: 0,
      transport: 'pause',
      volume: 1
    })
  })
  await act(async () => {
    result.current.send('file:show', show)
    resolve({ storage: 'native-fs' } as Awaited<ReturnType<typeof getFileBlobRecord>>)
    await Promise.resolve()
  })
  expect(runtime).not.toHaveBeenCalled()
  expect(result.current.getProjectionSnapshot()?.media.show?.playbackMode).not.toBe('vlc-embedded')
})

it('accepts only render status for the current requested content revision', async () => {
  vi.mocked(isElectron).mockReturnValue(false)
  useMediaProjectionStore.setState({ isEnded: false, projectionRenderStatus: null })
  const { result } = renderProjection()
  act(() => {
    void result.current.startProjection('media', [
      [
        'file:show',
        {
          itemId: 'image',
          blobId: 'image',
          mimeType: 'image/png',
          fileName: 'image',
          currentIndex: 0,
          playlist: []
        }
      ]
    ])
  })
  act(() => mockAdapter._trigger('__system:ready', { generation: 1 }))
  const show = result.current.getProjectionSnapshot()!.media.show!
  act(() =>
    mockAdapter._trigger('file:render-status', {
      itemId: 'image',
      blobId: 'image',
      contentRevision: show.contentRevision! - 1,
      status: 'failed'
    })
  )
  expect(useMediaProjectionStore.getState().projectionRenderStatus?.status).toBe('preparing')
  act(() =>
    mockAdapter._trigger('file:render-status', {
      itemId: 'image',
      blobId: 'image',
      contentRevision: show.contentRevision!,
      status: 'ready'
    })
  )
  expect(useMediaProjectionStore.getState().projectionRenderStatus?.status).toBe('ready')
  act(() => mockAdapter._trigger('__system:ready', { generation: 1 }))
  expect(useMediaProjectionStore.getState().projectionRenderStatus?.status).toBe('preparing')
  act(() => result.current.claimProjection('timer'))
  act(() =>
    mockAdapter._trigger('file:render-status', {
      itemId: 'image',
      blobId: 'image',
      contentRevision: show.contentRevision!,
      status: 'failed'
    })
  )
  expect(useMediaProjectionStore.getState().projectionRenderStatus).toBeNull()
})

it.each(['video/mp4', 'audio/mpeg'])(
  'clears document render status for %s transport',
  (mimeType) => {
    vi.mocked(isElectron).mockReturnValue(false)
    useMediaProjectionStore.setState({ isEnded: false, projectionRenderStatus: null })
    const { result } = renderProjection()
    act(() => {
      void result.current.startProjection('media', [
        [
          'file:show',
          {
            itemId: 'image',
            blobId: 'image',
            mimeType: 'image/png',
            fileName: 'image',
            currentIndex: 0,
            playlist: []
          }
        ]
      ])
    })
    act(() => mockAdapter._trigger('__system:ready', { generation: 1 }))
    expect(useMediaProjectionStore.getState().projectionRenderStatus?.status).toBe('preparing')
    act(() =>
      result.current.send('file:show', {
        itemId: 'transport',
        blobId: 'transport',
        mimeType,
        fileName: 'transport',
        currentIndex: 0,
        playlist: []
      })
    )
    expect(useMediaProjectionStore.getState().projectionRenderStatus).toBeNull()
    const show = result.current.getProjectionSnapshot()!.media.show!
    act(() =>
      mockAdapter._trigger('file:render-status', {
        itemId: show.itemId,
        blobId: show.blobId,
        contentRevision: show.contentRevision!,
        status: 'ready'
      })
    )
    expect(useMediaProjectionStore.getState().projectionRenderStatus).toBeNull()
  }
)
