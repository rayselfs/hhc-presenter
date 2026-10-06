import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockResolveVideoPlaybackPath, mockCapturePreview } = vi.hoisted(() => ({
  mockResolveVideoPlaybackPath: vi.fn(),
  mockCapturePreview: vi.fn()
}))

vi.mock('../../vlc-live-preview', () => ({ createVlcLivePreview: () => mockCapturePreview }))

vi.mock('../../ipc/video-remux', () => ({
  resolveVideoPlaybackPath: mockResolveVideoPlaybackPath,
  lockVideoPlaybackSource: vi.fn(() => vi.fn())
}))

const mockMainWindow = { id: 1 }
const mockProjectionWindow = new EventEmitter() as EventEmitter & {
  id: number
  webContents: EventEmitter
  isDestroyed: () => boolean
}
mockProjectionWindow.id = 2
mockProjectionWindow.webContents = new EventEmitter()
mockProjectionWindow.isDestroyed = () => false

const mockWindowManager = {
  getMainWindow: vi.fn(() => mockMainWindow),
  getProjectionWindow: vi.fn(() => mockProjectionWindow),
  getProjectionState: vi.fn(() => ({
    exists: true,
    lifecycle: { generation: 4, status: 'ready', reason: 'created' }
  })),
  sendToMain: vi.fn()
}
const mockSetPlayerWindowVisible = vi.fn()
const mockVlcPlayers: Array<{
  destroy: ReturnType<typeof vi.fn>
  getLength: ReturnType<typeof vi.fn>
  getState: ReturnType<typeof vi.fn>
  getTime: ReturnType<typeof vi.fn>
  getVolume: ReturnType<typeof vi.fn>
  isPlaying: ReturnType<typeof vi.fn>
  isSeekable: ReturnType<typeof vi.fn>
  notifyLayoutChange: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  playerId: number
  setSource: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
  setTime: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  replayFromStart: ReturnType<typeof vi.fn>
  shouldReplayFromStart: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => boolean
}> = []
let mockEmbedImplementation: () => Promise<void> = () => Promise.resolve()
let mockConstructError: Error | null = null
let mockDestroyImplementation: () => void = () => undefined
let mockSetSourceImplementation: (...args: unknown[]) => void = () => undefined

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const VLC_WINDOW_EVENTS = [
  'enter-full-screen',
  'leave-full-screen',
  'close',
  'minimize',
  'restore',
  'hide',
  'focus',
  'blur',
  'show',
  'move'
]

const VLC_WEB_CONTENTS_EVENTS = ['paint', 'devtools-opened', 'did-finish-load']

vi.mock('electron', () => {
  const handleHandlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    BrowserWindow: {
      fromWebContents: vi.fn(() => mockMainWindow)
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handleHandlers.set(channel, handler)
      }),
      _getHandler: (channel: string) => handleHandlers.get(channel),
      _clearHandlers: () => handleHandlers.clear()
    }
  }
})

vi.mock('electron-vlc-player', () => ({
  probeDefaultVlcDir: vi.fn(() => '/vlc'),
  getBinding: vi.fn(() => ({
    setPlayerWindowVisible: mockSetPlayerWindowVisible
  })),
  initLibVlc: vi.fn(),
  VlcPlayer: class MockVlcPlayer extends EventEmitter {
    window: typeof mockProjectionWindow
    playerId = 7

    constructor(options: { window: typeof mockProjectionWindow }) {
      super()
      if (mockConstructError) throw mockConstructError
      this.window = options.window
      mockVlcPlayers.push(this)
      for (const event of VLC_WINDOW_EVENTS) this.window.on(event, () => {})
      for (const event of VLC_WEB_CONTENTS_EVENTS) this.window.webContents.on(event, () => {})
    }

    embed = vi.fn(() => mockEmbedImplementation())
    isEmbedded = vi.fn(() => true)
    setSource = vi.fn((...args: unknown[]) => mockSetSourceImplementation(...args))
    destroy = vi.fn(() => mockDestroyImplementation())
    notifyLayoutChange = vi.fn()
    getTime = vi.fn(() => 0)
    getLength = vi.fn(() => 1000)
    getVolume = vi.fn(() => 100)
    isPlaying = vi.fn(() => false)
    isSeekable = vi.fn(() => true)
    getState = vi.fn(() => 0)
    play = vi.fn()
    replayFromStart = vi.fn()
    shouldReplayFromStart = vi.fn(() => false)
    pause = vi.fn()
    setTime = vi.fn()
    setVolume = vi.fn()
  }
}))

vi.mock('../../video-engine-runtime', () => ({
  resolveVlcRuntime: vi.fn(() => ({ status: 'ready', path: '/vlc' }))
}))

vi.mock('../../ipc/native-fs', () => ({
  getNativeFilePath: vi.fn(() => '/media/source')
}))

import { ipcMain, BrowserWindow } from 'electron'
import * as electronVlcPlayer from 'electron-vlc-player'
import { registerProjectionVlcHandlers } from '../../ipc/projection-vlc'
import { resolveVlcRuntime } from '../../video-engine-runtime'
import type { VlcPlayerRuntimeResult } from '../../vlc-player-runtime'
import type { WindowManager } from '../../windowManager'

type ExtendedIpcMain = typeof ipcMain & {
  _getHandler: (c: string) => (...args: unknown[]) => unknown
  _clearHandlers: () => void
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  return (ipcMain as ExtendedIpcMain)._getHandler(channel)
}

function makeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

function readyRuntime(): VlcPlayerRuntimeResult {
  return {
    status: 'ready',
    runtime: electronVlcPlayer
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(ipcMain as ExtendedIpcMain)._clearHandlers()
  mockProjectionWindow.removeAllListeners()
  mockProjectionWindow.webContents.removeAllListeners()
  mockVlcPlayers.length = 0
  mockEmbedImplementation = () => Promise.resolve()
  mockConstructError = null
  mockDestroyImplementation = () => undefined
  mockSetSourceImplementation = () => undefined
  mockResolveVideoPlaybackPath.mockImplementation(
    async (sourceFileId: string) => `/native-files/${sourceFileId}`
  )
  vi.mocked(resolveVlcRuntime).mockReturnValue({ status: 'ready', path: '/vlc' })
  mockWindowManager.getProjectionState.mockReturnValue({
    exists: true,
    lifecycle: { generation: 4, status: 'ready', reason: 'created' }
  })
  registerProjectionVlcHandlers(mockWindowManager as unknown as WindowManager)
})

describe('projection-vlc listener cleanup', () => {
  it('allows live frame reads only from the main window and rejects stale completions', async () => {
    const preview = getHandler('projection-vlc:preview')
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    await expect(preview(makeEvent(), 'item-1')).rejects.toThrow('Unauthorized')
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    await expect(preview(makeEvent(), '../path')).rejects.toThrow('Invalid')
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'live-item',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    expect(await preview(makeEvent(), 'live-item')).toBeNull()
    mockVlcPlayers[0].emit('playing')
    mockVlcPlayers[0].emit('paused')
    expect(await preview(makeEvent(), 'other-item')).toBeNull()
    const frame = deferred<{
      imageDataUrl: string
      capturedAt: number
      captureDurationMs: number
    }>()
    mockCapturePreview.mockReturnValueOnce(frame.promise)
    const pending = preview(makeEvent(), 'live-item')
    await getHandler('projection-vlc:stop')(makeEvent(), { force: true })
    frame.resolve({
      imageDataUrl: 'data:image/png;base64,eA==',
      capturedAt: 1,
      captureDurationMs: 1
    })
    expect(await pending).toBeNull()
  })

  it('owns and queues controls while resolving a Matroska derivative', async () => {
    const derivative = deferred<string>()
    mockResolveVideoPlaybackPath.mockReturnValueOnce(derivative.promise)
    const start = getHandler('projection-vlc:start')
    const starting = start(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      playbackVariant: 'matroska-remux'
    }) as Promise<void>
    await vi.waitFor(() => expect(mockResolveVideoPlaybackPath).toHaveBeenCalledOnce())

    getHandler('projection-vlc:control')(makeEvent(), {
      action: 'volume',
      itemId: 'item-1',
      value: 0.4
    })
    getHandler('projection-vlc:control')(makeEvent(), { action: 'pause', itemId: 'item-1' })
    expect(mockVlcPlayers).toHaveLength(0)

    derivative.resolve('/cache/item-1.mkv')
    await starting
    expect(mockResolveVideoPlaybackPath).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      'matroska-remux',
      expect.any(Function)
    )
    expect(mockVlcPlayers[0].setSource).toHaveBeenCalledWith('/cache/item-1.mkv', {
      autoplay: false
    })
    expect(mockVlcPlayers[0].setVolume).toHaveBeenCalledWith(0)
  })

  it.each(['paused', 'playing'] as const)(
    'keeps recovery silent until seek and final %s transport are confirmed',
    async (initialPlaybackState) => {
      await getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'silent-start',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        initialPositionSeconds: 12,
        initialVolume: 0.7,
        initialPlaybackState
      })
      const player = mockVlcPlayers[0]
      expect(player.setVolume.mock.calls).toEqual([[0]])
      expect(player.setVolume.mock.invocationCallOrder[0]).toBeLessThan(
        player.play.mock.invocationCallOrder[0]
      )
      getHandler('projection-vlc:control')(makeEvent(), {
        itemId: 'silent-start',
        action: 'volume',
        value: 0.4
      })
      player.emit('playing')
      expect(player.setTime).toHaveBeenCalledWith(12_000)
      player.getTime.mockReturnValue(12_000)
      player.emit('timeChanged')
      expect(player.setVolume.mock.calls.every(([volume]) => volume === 0)).toBe(true)
      player.emit(initialPlaybackState === 'playing' ? 'playing' : 'paused')
      expect(player.setVolume).toHaveBeenLastCalledWith(40)
    }
  )

  it('cancels presentation during preparation and ignores later cache progress/completion', async () => {
    const derivative = deferred<string>()
    mockResolveVideoPlaybackPath.mockReturnValueOnce(derivative.promise)
    const starting = getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'cancelled',
      attemptId: 'cancelled-attempt',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      playbackVariant: 'matroska-remux'
    }) as Promise<void>
    await vi.waitFor(() => expect(mockResolveVideoPlaybackPath).toHaveBeenCalledOnce())
    const publishPhase = mockResolveVideoPlaybackPath.mock.calls[0][2] as (phase: 'remux') => void
    publishPhase('remux')
    expect(mockWindowManager.sendToMain).toHaveBeenLastCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({ phase: 'preparing', preparationPhase: 'remux' })
    )
    await getHandler('projection-vlc:stop')(makeEvent(), {
      itemId: 'cancelled',
      attemptId: 'cancelled-attempt'
    })
    mockWindowManager.sendToMain.mockClear()
    publishPhase('remux')
    derivative.resolve('/cache/finished-in-background.mkv')
    await starting
    expect(mockVlcPlayers).toHaveLength(0)
    expect(mockWindowManager.sendToMain).not.toHaveBeenCalled()
  })

  it('publishes a stable recoverable remux failure without embedding VLC', async () => {
    mockResolveVideoPlaybackPath.mockRejectedValueOnce(new Error('insufficient-storage'))

    await expect(
      getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        playbackVariant: 'matroska-remux'
      })
    ).rejects.toThrow('VLC startup failed')

    expect(mockVlcPlayers).toHaveLength(0)
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection-vlc:failure',
      expect.objectContaining({ itemId: 'item-1', code: 'insufficient-storage', recoverable: true })
    )
  })

  it('publishes a VLC started acknowledgement only after startup succeeds', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })

    expect(mockWindowManager.sendToMain).not.toHaveBeenCalledWith(
      'projection-vlc:started',
      4,
      'item-1'
    )
    mockVlcPlayers[0].emit('playing')
    expect(mockWindowManager.sendToMain).not.toHaveBeenCalledWith(
      'projection-vlc:started',
      4,
      'item-1'
    )
    mockVlcPlayers[0].emit('paused')
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:started', 4, 'item-1')
  })

  it('publishes preparing and retains play until owner-confirmed playing', async () => {
    const playbackPath = deferred<string>()
    mockResolveVideoPlaybackPath.mockReturnValueOnce(playbackPath.promise)
    const startPromise = Promise.resolve(
      getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        attemptId: 'attempt-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
    )

    await vi.waitFor(() =>
      expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
        'projection:message',
        4,
        'file:playback-state',
        expect.objectContaining({ itemId: 'item-1', phase: 'preparing', isPlaying: false })
      )
    )
    getHandler('projection-vlc:control')(makeEvent(), { action: 'play', itemId: 'item-1' })
    playbackPath.resolve('/native-files/prepared.mkv')
    await startPromise
    mockVlcPlayers[0].emit('playing')

    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({ phase: 'playing', isPlaying: true })
    )
  })

  it('publishes sanitized typed failures without returning native diagnostics', async () => {
    const nativeError = new Error(
      'Failed to open /Users/operator/secret.mp4?token=secret from https://media.example/source'
    )
    mockEmbedImplementation = () => Promise.reject(nativeError)

    const startPromise = Promise.resolve(
      getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
    )

    await expect(startPromise).rejects.toThrow('VLC startup failed')
    await expect(startPromise).rejects.not.toThrow('/Users/operator')
    await expect(startPromise).rejects.not.toThrow('secret')
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'media-open-failed',
      recoverable: true,
      message: 'VLC could not open this media.'
    })
    const published = JSON.stringify(mockWindowManager.sendToMain.mock.calls)
    expect(published).not.toContain('/Users/operator')
    expect(published).not.toContain('secret')
    expect(published).not.toContain('https://')
  })

  it('publishes a media-open failure when VLC player construction fails', async () => {
    const nativeError = new Error('Native constructor failed at /private/vlc')
    mockConstructError = nativeError

    const startPromise = Promise.resolve(
      getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
    )

    await expect(startPromise).rejects.toThrow('VLC startup failed')
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'media-open-failed',
      recoverable: true,
      message: 'VLC could not open this media.'
    })
  })

  it('keeps the startup rejection sanitized when failed-player cleanup throws', async () => {
    const nativeError = new Error('Native start failed at /private/vlc')
    mockEmbedImplementation = () => Promise.reject(nativeError)
    mockDestroyImplementation = () => {
      throw new Error('cleanup failed')
    }

    const startPromise = Promise.resolve(
      getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
    )

    await expect(startPromise).rejects.toThrow('VLC startup failed')
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'media-open-failed',
      recoverable: true,
      message: 'VLC could not open this media.'
    })
  })

  it('resets assigned player globals before cleanup so the next start is independent', async () => {
    const nativeError = new Error('setSource failed at /private/vlc')
    mockSetSourceImplementation = () => {
      throw nativeError
    }
    mockDestroyImplementation = () => {
      throw new Error('cleanup failed')
    }
    const request = {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    }

    await expect(
      Promise.resolve(getHandler('projection-vlc:start')(makeEvent(), request))
    ).rejects.toThrow('VLC startup failed')
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'media-open-failed',
      recoverable: true,
      message: 'VLC could not open this media.'
    })
    expect(mockProjectionWindow.listenerCount('resize')).toBe(0)
    expect(mockProjectionWindow.listenerCount('resized')).toBe(0)

    mockSetSourceImplementation = () => undefined
    mockWindowManager.sendToMain.mockClear()
    await expect(
      Promise.resolve(getHandler('projection-vlc:start')(makeEvent(), request))
    ).resolves.toBeUndefined()
    expect(mockVlcPlayers).toHaveLength(2)
    expect(mockVlcPlayers[0].destroy).toHaveBeenCalledOnce()
    mockVlcPlayers[1].emit('playing')
    mockVlcPlayers[1].emit('paused')
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:started', 4, 'item-1')
  })

  it('maps missing runtimes and unavailable bindings without exposing diagnostics', async () => {
    vi.mocked(resolveVlcRuntime).mockReturnValueOnce({
      status: 'missing',
      message: 'Missing /Applications/VLC.app?token=secret'
    })

    await expect(
      Promise.resolve(
        getHandler('projection-vlc:start')(makeEvent(), {
          itemId: 'item-1',
          sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
          container: '#vlc-player'
        })
      )
    ).rejects.toThrow('VLC startup failed')
    expect(mockWindowManager.sendToMain).toHaveBeenLastCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'runtime-missing',
      recoverable: false,
      message: 'VLC runtime is not available.'
    })
    ;(ipcMain as ExtendedIpcMain)._clearHandlers()
    registerProjectionVlcHandlers(
      mockWindowManager as unknown as WindowManager,
      vi.fn(async () => ({
        status: 'error' as const,
        message: 'Binding failed at /private/native.node with token=secret'
      }))
    )
    await expect(
      Promise.resolve(
        getHandler('projection-vlc:start')(makeEvent(), {
          itemId: 'item-2',
          sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
          container: '#vlc-player'
        })
      )
    ).rejects.toThrow('VLC startup failed')
    expect(mockWindowManager.sendToMain).toHaveBeenLastCalledWith('projection-vlc:failure', {
      itemId: 'item-2',
      code: 'binding-unavailable',
      recoverable: false,
      message: 'VLC native playback is unavailable.'
    })
    expect(JSON.stringify(mockWindowManager.sendToMain.mock.calls)).not.toContain('/private')
  })

  it('publishes a sanitized recoverable failure for VLC runtime errors', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    mockWindowManager.sendToMain.mockClear()

    mockVlcPlayers[0].emit('error', new Error('/media/source?token=secret'))

    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'playback-failed',
      recoverable: true,
      message: 'VLC playback stopped unexpectedly.'
    })
    expect(mockVlcPlayers[0].destroy).toHaveBeenCalledOnce()
    expect(JSON.stringify(mockWindowManager.sendToMain.mock.calls)).not.toContain('/media/source')
  })

  it('publishes playback failure when damaged media ends far before its duration', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      durationMs: 183_000
    })
    const current = mockVlcPlayers[0]
    current.getTime.mockReturnValue(90_000)
    mockWindowManager.sendToMain.mockClear()

    current.emit('endReached')

    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'playback-failed',
      recoverable: true,
      message: 'VLC playback stopped unexpectedly.'
    })
  })

  it('does not publish a delayed old-item startup failure after newer media starts', async () => {
    const oldEmbed = deferred<void>()
    let embedCount = 0
    mockEmbedImplementation = () => {
      embedCount += 1
      return embedCount === 1 ? oldEmbed.promise : Promise.resolve()
    }
    const start = getHandler('projection-vlc:start')
    const oldError = new Error('old item failed')
    const oldStart = Promise.resolve(
      start(makeEvent(), {
        itemId: 'item-old',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
    )
    await vi.waitFor(() => expect(mockVlcPlayers).toHaveLength(1))

    await start(makeEvent(), {
      itemId: 'item-new',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440001',
      container: '#vlc-player'
    })
    mockWindowManager.sendToMain.mockClear()
    oldEmbed.reject(oldError)

    await expect(oldStart).rejects.toThrow('VLC startup failed')
    expect(mockWindowManager.sendToMain).not.toHaveBeenCalledWith(
      'projection-vlc:failure',
      expect.objectContaining({ itemId: 'item-old' })
    )
  })

  it('does not publish runtime failures from a replaced VLC player', async () => {
    const start = getHandler('projection-vlc:start')
    await start(makeEvent(), {
      itemId: 'item-old',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    const oldPlayer = mockVlcPlayers[0]
    await start(makeEvent(), {
      itemId: 'item-new',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440001',
      container: '#vlc-player'
    })
    mockWindowManager.sendToMain.mockClear()

    oldPlayer.emit('error', new Error('stale player failed'))

    expect(mockWindowManager.sendToMain).not.toHaveBeenCalledWith(
      'projection-vlc:failure',
      expect.objectContaining({ itemId: 'item-old' })
    )
  })

  it('publishes playback failure even when failed-player state queries throw', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    mockWindowManager.sendToMain.mockClear()
    mockVlcPlayers[0].getTime.mockImplementation(() => {
      throw new Error('native state unavailable')
    })

    expect(() => mockVlcPlayers[0].emit('error')).not.toThrow()
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'playback-failed',
      recoverable: true,
      message: 'VLC playback stopped unexpectedly.'
    })
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({
        itemId: 'item-1',
        phase: 'ended',
        isPlaying: false,
        isEnded: true
      })
    )
  })

  it('reports a missing native binding without failing handler registration', async () => {
    ;(ipcMain as ExtendedIpcMain)._clearHandlers()
    const loadRuntime = vi.fn(async () => ({
      status: 'error' as const,
      message: 'VLC native playback is unavailable.'
    }))

    registerProjectionVlcHandlers(mockWindowManager as unknown as WindowManager, loadRuntime)

    await expect(
      Promise.resolve(getHandler('projection-vlc:get-info')(makeEvent()))
    ).resolves.toEqual({
      status: 'error',
      message: 'VLC native playback is unavailable.'
    })
    expect(loadRuntime).toHaveBeenCalledTimes(1)
    expect(mockVlcPlayers).toHaveLength(0)
  })

  it('removes window listeners added by embedded VlcPlayer instances', async () => {
    const start = getHandler('projection-vlc:start')
    const stop = getHandler('projection-vlc:stop')

    for (let i = 0; i < 3; i++) {
      await start(makeEvent(), {
        itemId: `item-${i}`,
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
      await stop(makeEvent())
    }

    for (const event of VLC_WINDOW_EVENTS) {
      expect(mockProjectionWindow.listenerCount(event)).toBe(0)
    }
    for (const event of VLC_WEB_CONTENTS_EVENTS) {
      expect(mockProjectionWindow.webContents.listenerCount(event)).toBe(0)
    }
  })

  it('hides the native VLC window before destroying the embedded player', async () => {
    const start = getHandler('projection-vlc:start')
    const stop = getHandler('projection-vlc:stop')

    await start(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    await stop(makeEvent())

    expect(mockSetPlayerWindowVisible).toHaveBeenCalledWith(7, false)
  })

  it('destroys a stale VLC player when stop runs while embed is pending', async () => {
    const start = getHandler('projection-vlc:start')
    const stop = getHandler('projection-vlc:stop')
    let resolveEmbed: (() => void) | undefined
    mockEmbedImplementation = () =>
      new Promise<void>((resolve) => {
        resolveEmbed = resolve
      })

    const startPromise = start(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })

    await vi.waitFor(() => expect(mockVlcPlayers).toHaveLength(1))
    await stop(makeEvent())
    resolveEmbed?.()
    await startPromise

    expect(mockSetPlayerWindowVisible).toHaveBeenCalledWith(7, false)
    expect(mockVlcPlayers[0].destroy).toHaveBeenCalled()
    for (const event of VLC_WINDOW_EVENTS) {
      expect(mockProjectionWindow.listenerCount(event)).toBe(0)
    }
  })

  it('syncs VLC native bounds when the projection window resizes', async () => {
    const start = getHandler('projection-vlc:start')
    const stop = getHandler('projection-vlc:stop')

    await start(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })

    mockProjectionWindow.emit('resize')
    mockProjectionWindow.emit('resized')

    expect(mockVlcPlayers[0].notifyLayoutChange).toHaveBeenCalledTimes(2)

    await stop(makeEvent())
    mockProjectionWindow.emit('resize')
    expect(mockVlcPlayers[0].notifyLayoutChange).toHaveBeenCalledTimes(2)
  })

  it('reports VLC playback state with the current projection generation', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    mockVlcPlayers[0].emit('playing')
    mockVlcPlayers[0].emit('paused')

    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({ itemId: 'item-1' })
    )
  })

  it('finishes a queued immediate play on the first playing event', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    const current = mockVlcPlayers[0]
    getHandler('projection-vlc:control')(makeEvent(), {
      action: 'play',
      itemId: 'item-1'
    })
    mockSetPlayerWindowVisible.mockClear()
    mockWindowManager.sendToMain.mockClear()

    current.emit('playing')

    expect(current.play).toHaveBeenCalledOnce()
    expect(mockSetPlayerWindowVisible).toHaveBeenLastCalledWith(7, true)
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({ itemId: 'item-1', isPlaying: true, isEnded: false })
    )
  })

  it('uses the native replay path after media ends', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    const current = mockVlcPlayers[0]
    current.emit('playing')
    current.emit('paused')
    current.emit('endReached')
    current.shouldReplayFromStart.mockReturnValue(true)

    getHandler('projection-vlc:control')(makeEvent(), { action: 'play', itemId: 'item-1' })

    expect(current.shouldReplayFromStart).toHaveBeenCalledOnce()
    expect(current.replayFromStart).toHaveBeenCalledOnce()
    expect(current.play).toHaveBeenCalledOnce()
  })

  it('keeps bootstrap events internal and publishes owner-confirmed capability and volume', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      initialVolume: 0.35,
      initialPlaybackState: 'paused'
    })
    const current = mockVlcPlayers[0]
    current.getVolume.mockReturnValue(35)
    mockWindowManager.sendToMain.mockClear()

    current.emit('playing')
    expect(mockWindowManager.sendToMain).not.toHaveBeenCalled()

    current.emit('paused')
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({
        itemId: 'item-1',
        phase: 'ready',
        isPlaying: false,
        seekable: true,
        volume: 0.35
      })
    )
  })

  it('acknowledges volume immediately from the owned player while paused', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      initialPlaybackState: 'paused'
    })
    const current = mockVlcPlayers[0]
    current.emit('playing')
    current.emit('paused')
    mockWindowManager.sendToMain.mockClear()
    current.getVolume.mockReturnValue(42)

    getHandler('projection-vlc:control')(makeEvent(), {
      action: 'volume',
      itemId: 'item-1',
      value: 0.42
    })

    expect(current.setVolume).toHaveBeenCalledWith(42)
    expect(current.getVolume).toHaveBeenCalled()
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({ volume: 0.42, isPlaying: false })
    )
  })

  it('publishes buffering state only after startup finalization', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      initialPlaybackState: 'paused'
    })
    const current = mockVlcPlayers[0]
    mockWindowManager.sendToMain.mockClear()
    current.emit('buffering')
    expect(mockWindowManager.sendToMain).not.toHaveBeenCalled()

    current.emit('playing')
    current.emit('paused')
    mockWindowManager.sendToMain.mockClear()
    current.emit('buffering')

    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({ itemId: 'item-1', seekable: true })
    )
  })

  it('throttles bursty VLC progress state publications', async () => {
    vi.useFakeTimers()
    try {
      await getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
      const current = mockVlcPlayers[0]
      current.emit('playing')
      current.emit('paused')
      mockWindowManager.sendToMain.mockClear()

      current.emit('timeChanged')
      current.emit('timeChanged')
      current.emit('timeChanged')
      expect(mockWindowManager.sendToMain).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(249)
      current.emit('timeChanged')
      expect(mockWindowManager.sendToMain).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      current.emit('timeChanged')
      expect(mockWindowManager.sendToMain).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not report VLC state without a positive projection generation', async () => {
    mockWindowManager.getProjectionState.mockReturnValue({
      exists: false,
      lifecycle: { generation: 0, status: 'closed', reason: 'user-close' }
    })

    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })

    expect(mockWindowManager.sendToMain).not.toHaveBeenCalled()
  })

  it('retains the latest independent controls while VLC runtime discovery is pending', async () => {
    const runtime = deferred<VlcPlayerRuntimeResult>()
    ;(ipcMain as ExtendedIpcMain)._clearHandlers()
    registerProjectionVlcHandlers(
      mockWindowManager as unknown as WindowManager,
      vi.fn(() => runtime.promise)
    )
    const start = getHandler('projection-vlc:start')
    const control = getHandler('projection-vlc:control')
    const startPromise = Promise.resolve(
      start(makeEvent(), {
        itemId: 'item-1',
        attemptId: 'attempt-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        initialPositionSeconds: 5,
        initialVolume: 0.2,
        initialPlaybackState: 'playing'
      })
    )

    control(makeEvent(), { action: 'volume', itemId: 'item-1', value: 0.7 })
    control(makeEvent(), { action: 'seek', itemId: 'item-1', value: 20 })
    control(makeEvent(), { action: 'pause', itemId: 'item-1' })
    runtime.resolve(readyRuntime())
    await startPromise

    const current = mockVlcPlayers[0]
    expect(current.setVolume).toHaveBeenCalledWith(0)
    expect(current.setTime).not.toHaveBeenCalled()
    expect(current.pause).not.toHaveBeenCalled()

    current.emit('playing')
    expect(current.setTime).toHaveBeenCalledWith(20_000)
    expect(current.pause).not.toHaveBeenCalled()

    current.getTime.mockReturnValue(20_000)
    current.emit('timeChanged')
    expect(current.pause).toHaveBeenCalledOnce()
    expect(mockSetPlayerWindowVisible).not.toHaveBeenCalledWith(7, true)

    current.emit('paused')
    expect(mockSetPlayerWindowVisible).toHaveBeenCalledWith(7, true)
  })

  it('retains controls while VLC embed is pending', async () => {
    const embed = deferred<void>()
    mockEmbedImplementation = () => embed.promise
    const startPromise = Promise.resolve(
      getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        attemptId: 'attempt-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
    )
    await vi.waitFor(() => expect(mockVlcPlayers).toHaveLength(1))

    getHandler('projection-vlc:control')(makeEvent(), {
      action: 'volume',
      itemId: 'item-1',
      value: 0.45
    })
    getHandler('projection-vlc:control')(makeEvent(), {
      action: 'seek',
      itemId: 'item-1',
      value: 12
    })
    getHandler('projection-vlc:control')(makeEvent(), { action: 'play', itemId: 'item-1' })
    embed.resolve()
    await startPromise

    const current = mockVlcPlayers[0]
    expect(current.setVolume).toHaveBeenCalledWith(0)
    expect(current.setTime).not.toHaveBeenCalled()
    current.emit('playing')
    expect(current.setTime).toHaveBeenCalledWith(12_000)
  })

  it('does not let another item mutate pending startup controls', async () => {
    const runtime = deferred<VlcPlayerRuntimeResult>()
    ;(ipcMain as ExtendedIpcMain)._clearHandlers()
    registerProjectionVlcHandlers(
      mockWindowManager as unknown as WindowManager,
      vi.fn(() => runtime.promise)
    )
    const startPromise = Promise.resolve(
      getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        attemptId: 'attempt-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        initialPositionSeconds: 5,
        initialVolume: 0.2,
        initialPlaybackState: 'playing'
      })
    )

    getHandler('projection-vlc:control')(makeEvent(), {
      action: 'volume',
      itemId: 'item-2',
      value: 0.8
    })
    getHandler('projection-vlc:control')(makeEvent(), {
      action: 'seek',
      itemId: 'item-2',
      value: 30
    })
    getHandler('projection-vlc:control')(makeEvent(), { action: 'pause', itemId: 'item-2' })
    runtime.resolve(readyRuntime())
    await startPromise

    const current = mockVlcPlayers[0]
    expect(current.setVolume).toHaveBeenCalledWith(0)
    current.emit('playing')
    expect(current.setTime).toHaveBeenCalledWith(5_000)
    current.getTime.mockReturnValue(5_000)
    current.emit('timeChanged')
    expect(current.pause).not.toHaveBeenCalled()
    expect(current.play).toHaveBeenCalledTimes(2)
  })

  it('finishes seek-to-play startup when native playback is already confirmed', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      initialPositionSeconds: 18,
      initialPlaybackState: 'playing'
    })
    const current = mockVlcPlayers[0]

    current.emit('playing')
    current.getTime.mockReturnValue(18_000)
    current.isPlaying.mockReturnValue(true)
    mockSetPlayerWindowVisible.mockClear()
    mockWindowManager.sendToMain.mockClear()
    current.emit('timeChanged')

    expect(current.play).toHaveBeenCalledOnce()
    expect(mockSetPlayerWindowVisible).toHaveBeenLastCalledWith(7, true)
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      expect.objectContaining({ itemId: 'item-1', isPlaying: true, isEnded: false })
    )
  })

  it('waits for owner-matched readiness before seeking or applying final transport', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      initialPositionSeconds: 18,
      initialPlaybackState: 'paused'
    })
    const current = mockVlcPlayers[0]
    current.isSeekable.mockReturnValue(false)

    expect(mockSetPlayerWindowVisible).toHaveBeenCalledWith(7, false)
    expect(current.play).toHaveBeenCalledOnce()
    expect(current.setTime).not.toHaveBeenCalled()
    expect(current.pause).not.toHaveBeenCalled()

    current.emit('playing')
    expect(current.setTime).not.toHaveBeenCalled()
    expect(current.pause).toHaveBeenCalledOnce()
    expect(mockSetPlayerWindowVisible).not.toHaveBeenCalledWith(7, true)

    current.emit('paused')
    expect(mockSetPlayerWindowVisible).toHaveBeenCalledWith(7, true)
  })

  it('turns a native startup action throw into an owned playback failure', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      initialPositionSeconds: 18,
      initialPlaybackState: 'paused'
    })
    const current = mockVlcPlayers[0]
    current.setTime.mockImplementationOnce(() => {
      throw new Error('native setTime failed at /private/vlc')
    })
    mockWindowManager.sendToMain.mockClear()

    expect(() => current.emit('playing')).not.toThrow()
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
      itemId: 'item-1',
      code: 'playback-failed',
      recoverable: true,
      message: 'VLC playback stopped unexpectedly.'
    })
    expect(current.destroy).toHaveBeenCalledOnce()
  })

  it.each([
    ['play', 'play'],
    ['pause', 'pause'],
    ['seek', 'setTime']
  ] as const)(
    'turns a native %s control throw into an owned playback failure',
    async (action, method) => {
      await getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        attemptId: 'attempt-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        initialPlaybackState: 'paused'
      })
      const current = mockVlcPlayers[0]
      current.emit('playing')
      current.emit('paused')
      current[method].mockImplementationOnce(() => {
        throw new Error(`native ${method} failed at /private/vlc`)
      })
      mockWindowManager.sendToMain.mockClear()

      expect(() =>
        getHandler('projection-vlc:control')(makeEvent(), {
          action,
          itemId: 'item-1',
          ...(action === 'seek' ? { value: 5 } : {})
        })
      ).not.toThrow()
      expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
        itemId: 'item-1',
        code: 'playback-failed',
        recoverable: true,
        message: 'VLC playback stopped unexpectedly.'
      })
      expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
        'projection:message',
        4,
        'file:playback-state',
        expect.objectContaining({ itemId: 'item-1', isPlaying: false, isEnded: true })
      )
      expect(current.destroy).toHaveBeenCalledOnce()
    }
  )

  it('tears down startup that never reaches final VLC confirmation', async () => {
    vi.useFakeTimers()
    try {
      await getHandler('projection-vlc:start')(makeEvent(), {
        itemId: 'item-1',
        attemptId: 'attempt-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player'
      })
      mockWindowManager.sendToMain.mockClear()

      await vi.advanceTimersByTimeAsync(15_000)

      expect(mockVlcPlayers[0].destroy).toHaveBeenCalledOnce()
      expect(mockWindowManager.sendToMain).toHaveBeenCalledWith('projection-vlc:failure', {
        itemId: 'item-1',
        code: 'media-open-failed',
        recoverable: true,
        message: 'VLC could not open this media.'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores every delayed playback event from a replaced owner', async () => {
    const start = getHandler('projection-vlc:start')
    await start(makeEvent(), {
      itemId: 'item-old',
      attemptId: 'attempt-old',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    const oldPlayer = mockVlcPlayers[0]
    await start(makeEvent(), {
      itemId: 'item-new',
      attemptId: 'attempt-new',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440001',
      container: '#vlc-player'
    })
    mockWindowManager.sendToMain.mockClear()

    oldPlayer.emit('playing')
    oldPlayer.emit('stopped')
    oldPlayer.emit('endReached')
    oldPlayer.emit('error')

    expect(mockWindowManager.sendToMain).not.toHaveBeenCalled()
  })

  it('does not let an owner-scoped old stop destroy a replacement attempt', async () => {
    const start = getHandler('projection-vlc:start')
    const stop = getHandler('projection-vlc:stop')
    await start(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-old',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    await start(makeEvent(), {
      itemId: 'item-1',
      attemptId: 'attempt-new',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440001',
      container: '#vlc-player'
    })
    const replacement = mockVlcPlayers[1]

    await stop(makeEvent(), { itemId: 'item-1', attemptId: 'attempt-old' })
    expect(replacement.destroy).not.toHaveBeenCalled()

    await stop(makeEvent(), { force: true })
    expect(replacement.destroy).toHaveBeenCalledOnce()
  })

  it('applies source, volume, confirmed seek, then playing replay state in order', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      initialPositionSeconds: 18,
      initialVolume: 0.35,
      initialPlaybackState: 'playing'
    })
    const current = mockVlcPlayers[0]

    expect(current.setVolume).toHaveBeenCalledWith(0)
    expect(current.play).toHaveBeenCalledOnce()
    expect(current.setTime).not.toHaveBeenCalled()
    expect(current.setSource.mock.invocationCallOrder[0]).toBeLessThan(
      current.setVolume.mock.invocationCallOrder[0]
    )
    expect(current.setVolume.mock.invocationCallOrder[0]).toBeLessThan(
      current.play.mock.invocationCallOrder[0]
    )

    current.emit('playing')
    expect(current.setTime).toHaveBeenCalledWith(18_000)
    current.getTime.mockReturnValue(18_000)
    current.emit('timeChanged')
    expect(current.play).toHaveBeenCalledTimes(2)
    expect(current.setTime.mock.invocationCallOrder[0]).toBeLessThan(
      current.play.mock.invocationCallOrder[1]
    )
  })

  it('does not force an MKV demux seek when replay starts at zero', async () => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player',
      initialPositionSeconds: 0,
      initialPlaybackState: 'paused'
    })

    expect(mockVlcPlayers[0].setTime).not.toHaveBeenCalled()
  })

  it('bootstraps decoding before restoring a paused or ended VLC replay state', async () => {
    const start = getHandler('projection-vlc:start')
    for (const initialPlaybackState of ['paused', 'ended'] as const) {
      await start(makeEvent(), {
        itemId: initialPlaybackState,
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        initialPlaybackState
      })
      const current = mockVlcPlayers.at(-1)!
      expect(current.play).toHaveBeenCalledOnce()
      expect(current.pause).not.toHaveBeenCalled()
      current.emit('playing')
      expect(current.pause).toHaveBeenCalledOnce()
    }
  })

  it.each([
    ['missing payload', null],
    [
      'non-finite position',
      {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        initialPositionSeconds: Number.NaN
      }
    ],
    [
      'out-of-range volume',
      {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        initialVolume: 2
      }
    ],
    [
      'unknown replay state',
      {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        initialPlaybackState: 'buffering'
      }
    ],
    [
      'unknown playback variant',
      {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#vlc-player',
        playbackVariant: 'transcode'
      }
    ],
    [
      'unknown container',
      {
        itemId: 'item-1',
        sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
        container: '#other-player'
      }
    ]
  ])('rejects an invalid start request: %s', async (_label, request) => {
    await expect(
      Promise.resolve().then(() => getHandler('projection-vlc:start')(makeEvent(), request))
    ).rejects.toThrow('Invalid VLC start request')
    expect(mockVlcPlayers).toHaveLength(0)
  })

  it('does not expose a synchronous VLC probe handler', () => {
    expect(getHandler('projection-vlc:probe')).toBeUndefined()
  })

  it.each([
    ['non-finite seek', { action: 'seek', value: Number.NaN }],
    ['negative seek', { action: 'seek', value: -1 }],
    ['out-of-range volume', { action: 'volume', value: Number.POSITIVE_INFINITY }],
    ['unknown action', { action: 'stop-all' }]
  ])('rejects an invalid control request: %s', async (_label, command) => {
    await getHandler('projection-vlc:start')(makeEvent(), {
      itemId: 'item-1',
      sourceFileId: '550e8400-e29b-41d4-a716-446655440000',
      container: '#vlc-player'
    })
    const current = mockVlcPlayers[0]

    expect(() => getHandler('projection-vlc:control')(makeEvent(), command)).toThrow(
      'Invalid VLC control request'
    )
    expect(current.setTime).not.toHaveBeenCalled()
    expect(current.setVolume).toHaveBeenCalledExactlyOnceWith(0)
  })
})
