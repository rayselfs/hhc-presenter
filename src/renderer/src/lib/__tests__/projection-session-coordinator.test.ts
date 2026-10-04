import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectionPayload } from '@shared/projection-messages'
import { createProjectionSessionCoordinator } from '../projection-session-coordinator'

const timerTick: ProjectionPayload<'timer:tick'> = {
  mode: 'timer',
  remainingSeconds: 60,
  phase: 'main',
  mainDisplay: '01:00',
  subDisplay: null,
  progress: 0.5,
  overtimeSeconds: 0,
  overtimeMessage: null,
  reminderColor: null
}

const chapter: ProjectionPayload<'bible:chapter'> = {
  bookNumber: 43,
  chapter: 3,
  chapterVerses: [{ number: 16, text: 'For God so loved the world' }],
  currentVerse: 16,
  versionLocale: 'en'
}

const fileShow: ProjectionPayload<'file:show'> = {
  itemId: 'video-1',
  blobId: 'blob-1',
  fileName: 'video.mp4',
  mimeType: 'video/mp4',
  playlist: [{ id: 'video-1', name: 'video.mp4', mimeType: 'video/mp4' }],
  currentIndex: 0
}

const playback: ProjectionPayload<'file:playback-state'> = {
  itemId: 'video-1',
  phase: 'playing',
  currentTime: 24,
  duration: 120,
  isPlaying: true,
  isEnded: false,
  playbackRate: 1.5,
  seekable: true,
  volume: 0.6
}

describe('ProjectionSessionCoordinator', () => {
  const send = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    send.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces timer and bible final-state payloads', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    const nextTick = { ...timerTick, remainingSeconds: 59, mainDisplay: '00:59' }

    coordinator.startSession('timer', [['timer:tick', timerTick]])
    coordinator.project('timer:tick', nextTick)
    coordinator.project('settings:timezone', { timezone: 'Asia/Taipei' })
    coordinator.startSession('bible', [['bible:chapter', chapter]])
    coordinator.project('bible:settings', { fontSize: 88 })

    expect(coordinator.getSnapshot()).toMatchObject({
      owner: 'bible',
      timer: {
        tick: null,
        timezone: null
      },
      bible: {
        chapter,
        settings: { fontSize: 88 }
      }
    })
  })

  it('keeps requested media controls pending without confirming durable replay state', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 3, status: 'opening', reason: 'created' })
    coordinator.project('file:control', { action: 'seek', itemId: 'video-1', value: 8 })
    coordinator.project('file:control', { action: 'seek', itemId: 'video-1', value: 12 })
    coordinator.project('file:control', {
      action: 'volume',
      itemId: 'video-1',
      value: 0.4
    })
    coordinator.project('file:control', { action: 'play', itemId: 'video-1' })

    expect(coordinator.getSnapshot()?.media.state).toMatchObject({
      itemId: 'video-1',
      positionSeconds: 0,
      volume: 1,
      isPlaying: false
    })

    coordinator.ready(3)
    expect(send).toHaveBeenLastCalledWith('__system:replay', {
      generation: 3,
      snapshot: coordinator.getSnapshot(),
      pendingFileControls: {
        itemId: 'video-1',
        seekSeconds: 12,
        volume: 0.4,
        transport: 'play'
      }
    })
  })

  it('retains sent controls through recovery until matching playback confirms them', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 3, status: 'opening', reason: 'created' })
    coordinator.ready(3)
    send.mockClear()

    coordinator.project('file:control', { action: 'seek', itemId: 'video-1', value: 30 })
    coordinator.project('file:control', { action: 'volume', itemId: 'video-1', value: 0.4 })
    coordinator.project('file:control', { action: 'pause', itemId: 'video-1' })
    coordinator.recordPlayback(3, {
      ...playback,
      currentTime: 24,
      isPlaying: false,
      volume: 0.6
    })
    coordinator.beginGeneration({ generation: 3, status: 'recovering', reason: 'renderer-crash' })
    coordinator.ready(3)

    expect(send).toHaveBeenLastCalledWith('__system:replay', {
      generation: 3,
      snapshot: coordinator.getSnapshot(),
      pendingFileControls: {
        itemId: 'video-1',
        seekSeconds: 30,
        volume: 0.4
      }
    })
  })

  it('clears confirmed controls and rejects pending seek when VLC is not seekable', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 3, status: 'opening', reason: 'created' })
    coordinator.project('file:control', { action: 'seek', itemId: 'video-1', value: 30 })
    coordinator.project('file:control', { action: 'volume', itemId: 'video-1', value: 0.4 })
    coordinator.project('file:control', { action: 'play', itemId: 'video-1' })

    coordinator.recordPlayback(3, {
      ...playback,
      currentTime: 30.5,
      isPlaying: true,
      seekable: false,
      volume: 0.4
    })
    coordinator.ready(3)

    expect(send).toHaveBeenLastCalledWith('__system:replay', {
      generation: 3,
      snapshot: coordinator.getSnapshot()
    })
    expect(coordinator.getSnapshot()?.media.state).toMatchObject({
      positionSeconds: 30.5,
      isPlaying: true,
      seekable: false,
      volume: 0.4
    })
  })

  it('reduces PDF, zoom, and pan controls into final replay state', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])

    coordinator.project('file:control', { action: 'pdfPage', value: 5 })
    coordinator.project('file:control', { action: 'pdfScroll', value: 5.25 })
    coordinator.project('file:control', { action: 'pdfViewMode', value: 'continuous' })
    coordinator.project('file:control', { action: 'zoom', value: 1.5 })
    coordinator.project('file:control', { action: 'pan', value: { x: 12, y: -8 } })

    expect(coordinator.getSnapshot()?.media.state).toMatchObject({
      pdfPage: 5,
      pdfScroll: 5.25,
      pdfViewMode: 'continuous',
      zoom: 1.5,
      pan: { x: 12, y: -8 }
    })
  })

  it('resets media replay state when a new item is shown', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.project('file:control', { action: 'seek', value: 12 })

    coordinator.project('file:show', {
      ...fileShow,
      itemId: 'video-2',
      blobId: 'blob-2',
      fileName: 'second.mp4'
    })

    expect(coordinator.getSnapshot()?.media.state).toEqual({
      itemId: 'video-2',
      positionSeconds: 0,
      durationSeconds: 0,
      isPlaying: false,
      isEnded: false,
      volume: 1,
      playbackRate: 1,
      pdfPage: 1,
      pdfScroll: 0,
      pdfViewMode: 'single',
      zoom: 1,
      pan: { x: 0, y: 0 }
    })
  })

  it('preserves playback state when an authoritative source renews for the same item', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 3, status: 'opening', reason: 'created' })
    coordinator.recordPlayback(3, playback)
    coordinator.project('file:control', { action: 'volume', value: 0.4 })

    coordinator.project('file:show', {
      ...fileShow,
      streamUrl: 'https://www.alive.org.tw/api/assets/content?ticket=renewed'
    })

    expect(coordinator.getSnapshot()?.media.state).toMatchObject({
      itemId: 'video-1',
      positionSeconds: 24,
      isPlaying: true,
      volume: 0.6,
      playbackRate: 1.5
    })
  })

  it('ignores playback reports for the wrong item or generation', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 3, status: 'opening', reason: 'created' })
    coordinator.recordPlayback(2, playback)
    coordinator.recordPlayback(3, { ...playback, itemId: 'other' })

    expect(coordinator.getSnapshot()?.media.state?.positionSeconds).toBe(0)
  })

  it('records matching playback reports as final media state', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 3, status: 'opening', reason: 'created' })

    coordinator.recordPlayback(3, playback)

    expect(coordinator.getSnapshot()?.media.state).toMatchObject({
      positionSeconds: 24,
      durationSeconds: 120,
      isPlaying: true,
      isEnded: false
    })
  })

  it('never writes file:end into the replay snapshot', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    const before = coordinator.getSnapshot()

    coordinator.sendOneShot('file:end', null)

    expect(coordinator.getSnapshot()).toEqual(before)
    expect(send).not.toHaveBeenCalled()
  })

  it('clears the snapshot on explicit session end', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('timer', [['timer:tick', timerTick]])

    coordinator.endSession()

    expect(coordinator.getSnapshot()).toBeNull()
    expect(coordinator.getRecoveryState()).toEqual({
      status: 'closed',
      generation: 0,
      failure: null
    })
  })

  it('replays once for matching ready and ignores an old ready', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('timer', [['timer:tick', timerTick]])
    coordinator.beginGeneration({ generation: 7, status: 'opening', reason: 'reload' })

    coordinator.ready(6)
    expect(send).not.toHaveBeenCalled()

    coordinator.ready(7)
    coordinator.ready(7)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('__system:replay', {
      generation: 7,
      snapshot: coordinator.getSnapshot()
    })
  })

  it('replays again when the same browser generation explicitly reloads', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('timer', [['timer:tick', timerTick]])
    coordinator.beginGeneration({ generation: 7, status: 'opening', reason: 'created' })
    coordinator.ready(7)
    send.mockClear()

    coordinator.beginGeneration({ generation: 7, status: 'opening', reason: 'reload' })
    coordinator.ready(7)

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('__system:replay', {
      generation: 7,
      snapshot: coordinator.getSnapshot()
    })
  })

  it('replays intentional blackout without replacing the retained content', () => {
    const coordinator = createProjectionSessionCoordinator(send)

    expect(coordinator).toHaveProperty('blackout')

    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.blackout(true)
    coordinator.beginGeneration({ generation: 8, status: 'opening', reason: 'reload' })
    coordinator.ready(8)

    expect(coordinator.getSnapshot()).toMatchObject({
      owner: 'media',
      isBlackout: true,
      media: { show: fileShow }
    })
    expect(send).toHaveBeenLastCalledWith('__system:replay', {
      generation: 8,
      snapshot: coordinator.getSnapshot()
    })
  })

  it('replays the latest media state when restoring blackout', () => {
    const coordinator = createProjectionSessionCoordinator(send)

    expect(coordinator).toHaveProperty('blackout')

    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 8, status: 'opening', reason: 'created' })
    coordinator.ready(8)
    send.mockClear()

    coordinator.blackout(true)
    expect(send.mock.calls).toEqual([['__system:blackout', { enabled: true }]])

    coordinator.recordPlayback(8, { ...playback, currentTime: 42 })
    send.mockClear()

    coordinator.blackout(false)

    expect(coordinator.getSnapshot()).toMatchObject({
      owner: 'media',
      isBlackout: false,
      media: { show: fileShow }
    })
    expect(send.mock.calls).toEqual([
      ['__system:blackout', { enabled: false }],
      [
        '__system:replay',
        {
          generation: 8,
          snapshot: expect.objectContaining({
            isBlackout: false,
            media: expect.objectContaining({
              state: expect.objectContaining({
                positionSeconds: 42,
                isPlaying: true
              })
            })
          })
        }
      ]
    ])
  })

  it('replays the latest media state when restoring blank output', () => {
    const coordinator = createProjectionSessionCoordinator(send)

    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 7, status: 'opening', reason: 'created' })
    coordinator.ready(7)
    send.mockClear()

    coordinator.blank(true)
    expect(send.mock.calls).toEqual([['__system:blank', { showDefault: true }]])

    coordinator.recordPlayback(7, { ...playback, currentTime: 42 })
    send.mockClear()

    coordinator.blank(false)

    expect(coordinator.getSnapshot()).toMatchObject({
      showDefault: false,
      media: { show: fileShow }
    })
    expect(send.mock.calls).toEqual([
      ['__system:blank', { showDefault: false }],
      [
        '__system:replay',
        {
          generation: 7,
          snapshot: expect.objectContaining({
            showDefault: false,
            media: expect.objectContaining({
              state: expect.objectContaining({
                positionSeconds: 42,
                isPlaying: true
              })
            })
          })
        }
      ]
    ])
  })

  it('does not replay a restore transition before the generation is ready', () => {
    const coordinator = createProjectionSessionCoordinator(send)

    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 9, status: 'opening', reason: 'created' })

    coordinator.blackout(true)
    coordinator.blackout(false)

    expect(send.mock.calls).toEqual([])

    coordinator.ready(9)

    expect(send.mock.calls).toEqual([
      [
        '__system:replay',
        {
          generation: 9,
          snapshot: coordinator.getSnapshot()
        }
      ]
    ])
  })

  it('sends incremental and one-shot messages only while ready', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.beginGeneration({ generation: 2, status: 'opening', reason: 'created' })
    coordinator.project('file:control', { action: 'pause', itemId: 'video-1' })
    coordinator.sendOneShot('file:end', null)
    expect(send).not.toHaveBeenCalled()

    coordinator.ready(2)
    send.mockClear()
    coordinator.project('file:control', { action: 'play', itemId: 'video-1' })
    coordinator.sendOneShot('file:end', null)

    expect(send.mock.calls).toEqual([
      ['file:control', { action: 'play', itemId: 'video-1' }],
      ['file:end', null]
    ])
  })

  it('times out only the captured generation and retains the snapshot', async () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('bible', [['bible:chapter', chapter]])
    coordinator.beginGeneration({ generation: 2, status: 'opening', reason: 'created' })
    const resultPromise = coordinator.waitForReady(2)

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      generation: 2,
      reason: 'ready-timeout'
    })
    expect(coordinator.getSnapshot()?.bible.chapter).toEqual(chapter)
    expect(coordinator.getRecoveryState()).toEqual({
      status: 'failed',
      generation: 2,
      failure: { generation: 2, reason: 'ready-timeout' }
    })
  })

  it('retargets one pending operation to a replacement generation', async () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('timer', [['timer:tick', timerTick]])
    coordinator.beginGeneration({ generation: 2, status: 'opening', reason: 'created' })
    const resultPromise = coordinator.waitForReady(2)

    await vi.advanceTimersByTimeAsync(3000)
    coordinator.beginGeneration({ generation: 3, status: 'opening', reason: 'reload' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(coordinator.getRecoveryState().status).toBe('opening')

    coordinator.ready(3)
    await expect(resultPromise).resolves.toEqual({ ok: true, generation: 3 })
  })

  it('ignores stale failure and supports retry with a newer generation', async () => {
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.startSession('timer', [['timer:tick', timerTick]])
    coordinator.beginGeneration({ generation: 4, status: 'recovering', reason: 'renderer-crash' })

    coordinator.fail(3, 'renderer-crash')
    expect(coordinator.getRecoveryState().status).toBe('recovering')

    coordinator.fail(4, 'renderer-crash')
    expect(coordinator.getRecoveryState().status).toBe('failed')

    coordinator.beginGeneration({ generation: 5, status: 'opening', reason: 'created' })
    const resultPromise = coordinator.waitForReady(5)
    coordinator.ready(5)
    await expect(resultPromise).resolves.toEqual({ ok: true, generation: 5 })
    expect(coordinator.getRecoveryState()).toEqual({
      status: 'ready',
      generation: 5,
      failure: null
    })
  })

  it('notifies subscribers for observable state changes and stops after unsubscribe', () => {
    const coordinator = createProjectionSessionCoordinator(send)
    const listener = vi.fn()
    const unsubscribe = coordinator.subscribe(listener)

    coordinator.startSession('timer', [['timer:tick', timerTick]])
    coordinator.beginGeneration({ generation: 1, status: 'opening', reason: 'created' })
    const callsBeforeUnsubscribe = listener.mock.calls.length
    unsubscribe()
    coordinator.ready(1)

    expect(callsBeforeUnsubscribe).toBeGreaterThan(0)
    expect(listener).toHaveBeenCalledTimes(callsBeforeUnsubscribe)
  })

  it('disposal cancels readiness and prevents further notifications', async () => {
    const coordinator = createProjectionSessionCoordinator(send)
    const listener = vi.fn()
    coordinator.subscribe(listener)
    coordinator.startSession('timer', [['timer:tick', timerTick]])
    coordinator.beginGeneration({ generation: 1, status: 'opening', reason: 'created' })
    const resultPromise = coordinator.waitForReady(1)
    const callsBeforeDispose = listener.mock.calls.length

    coordinator.dispose()
    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      generation: 1,
      reason: 'ready-timeout'
    })
    expect(listener).toHaveBeenCalledTimes(callsBeforeDispose)
    expect(send).not.toHaveBeenCalled()
  })
})

it('caches passive timer updates without sending them over an active camera', () => {
  const send = vi.fn()
  const coordinator = createProjectionSessionCoordinator(send)
  coordinator.startSession('camera', [])
  coordinator.beginGeneration({ generation: 1, status: 'opening', reason: 'created' })
  coordinator.ready(1)
  send.mockClear()
  coordinator.project('timer:tick', {
    mode: 'clock',
    remainingSeconds: 0,
    phase: 'main',
    mainDisplay: '00:00',
    subDisplay: '',
    progress: 0,
    overtimeSeconds: 0,
    overtimeMessage: null,
    reminderColor: null
  })
  expect(send).not.toHaveBeenCalled()
  expect(coordinator.getSnapshot()?.timer.tick?.mode).toBe('clock')
  coordinator.dispose()
})

describe('late video promotion', () => {
  function setup(): {
    coordinator: ReturnType<typeof createProjectionSessionCoordinator>
    send: ReturnType<typeof vi.fn>
    error: ProjectionPayload<'file:playback-error'>
  } {
    const send = vi.fn()
    const coordinator = createProjectionSessionCoordinator(send)
    coordinator.beginGeneration({ generation: 1, status: 'opening', reason: 'created' })
    coordinator.startSession('media', [['file:show', fileShow]])
    coordinator.ready(1)
    const error = {
      itemId: fileShow.itemId,
      blobId: fileShow.blobId,
      contentRevision: coordinator.getSnapshot()!.media.show!.contentRevision!,
      errorCode: 3 as const,
      currentTime: 24,
      duration: 120,
      transport: 'pause' as const,
      volume: 0.6
    }
    coordinator.recordPlayback(1, {
      ...playback,
      phase: 'paused',
      currentTime: error.currentTime,
      isPlaying: false,
      volume: error.volume
    })
    return { coordinator, send, error }
  }
  it('promotes through replay while retaining newer pending controls', () => {
    const { coordinator, send, error } = setup()
    coordinator.project('file:control', { action: 'seek', itemId: 'video-1', value: 80 })
    coordinator.project('file:control', { action: 'play', itemId: 'video-1' })
    coordinator.project('file:control', { action: 'volume', itemId: 'video-1', value: 0.2 })
    expect(coordinator.promoteVideo(1, error)).toBe(true)
    expect(send).toHaveBeenLastCalledWith(
      '__system:replay',
      expect.objectContaining({
        snapshot: expect.objectContaining({
          media: expect.objectContaining({
            show: expect.objectContaining({ playbackMode: 'vlc-embedded' }),
            state: expect.objectContaining({ positionSeconds: 24, isPlaying: false, volume: 0.6 })
          })
        }),
        pendingFileControls: { itemId: 'video-1', seekSeconds: 80, transport: 'play', volume: 0.2 }
      })
    )
    expect(coordinator.promoteVideo(1, error)).toBe(false)
    coordinator.replay(1)
    expect(coordinator.getSnapshot()?.media.show?.playbackMode).toBe('vlc-embedded')
  })
  it.each(['restart', 'owner-aba', 'session', 'generation', 'item'] as const)(
    'rejects obsolete %s report',
    (change) => {
      const { coordinator, error } = setup()
      if (change === 'restart') coordinator.project('file:show', fileShow)
      if (change === 'owner-aba') {
        coordinator.claim('timer')
        coordinator.claim('media')
      }
      if (change === 'session') coordinator.startSession('media', [['file:show', fileShow]])
      if (change === 'generation')
        coordinator.beginGeneration({ generation: 2, status: 'opening', reason: 'reload' })
      if (change === 'item') coordinator.project('file:show', { ...fileShow, itemId: 'other' })
      expect(coordinator.promoteVideo(1, error)).toBe(false)
    }
  )
})
