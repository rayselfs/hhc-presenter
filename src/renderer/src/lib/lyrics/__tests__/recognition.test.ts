import { vi, beforeEach, afterEach, it, expect } from 'vitest'
import { startLyricsRecognition } from '../recognition'
import { createLyricsEngine } from '../engine'
import type { LyricsBlock } from '../lines'
vi.mock('../engine', () => ({ createLyricsEngine: vi.fn() }))
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2)
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(2)
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(8), width: 2, height: 1 })
  } as unknown as CanvasRenderingContext2D)
})
afterEach(() => vi.restoreAllMocks())
function source(): {
  stream: MediaStream
  track: EventTarget & { stop: ReturnType<typeof vi.fn> }
} {
  const track = Object.assign(new EventTarget(), {
    readyState: 'live',
    muted: false,
    stop: vi.fn()
  })
  return { stream: { getVideoTracks: () => [track] } as unknown as MediaStream, track }
}
for (const event of ['dispose', 'mute', 'ended']) {
  it(`drops an in-flight OCR completion after ${event} without stopping the shared capture`, async () => {
    let finish!: (value: LyricsBlock[]) => void
    const recognize = vi.fn(
      () =>
        new Promise<LyricsBlock[]>((resolve) => {
          finish = resolve
        })
    )
    const dispose = vi.fn()
    vi.mocked(createLyricsEngine).mockResolvedValue({ recognize, dispose })
    const { stream, track } = source()
    const onLines = vi.fn(),
      onError = vi.fn()
    const crop = { x: 0, y: 0, width: 1, height: 1 }
    const stop = startLyricsRecognition({
      stream,
      getCrop: () => crop,
      onStatus: vi.fn(),
      onLines,
      onError
    })
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce())
    if (event === 'dispose') stop()
    else {
      Object.assign(track, event === 'mute' ? { muted: true } : { readyState: 'ended' })
      track.dispatchEvent(new Event(event))
    }
    finish([
      {
        text: 'Stale lyrics',
        score: 1,
        poly: [
          [0, 0],
          [2, 0],
          [2, 1],
          [0, 1]
        ]
      }
    ])
    await Promise.resolve()
    await Promise.resolve()
    expect(onLines).not.toHaveBeenCalled()
    if (event !== 'dispose') expect(onError).toHaveBeenCalledWith('source')
    stop()
    expect(dispose).toHaveBeenCalled()
    expect(track.stop).not.toHaveBeenCalled()
  })
}

it('changes crop without reloading the engine and drops the old in-flight result', async () => {
  vi.mocked(createLyricsEngine).mockClear()
  let crop = { x: 0, y: 0, width: 1, height: 0.4 }
  let finish!: (value: LyricsBlock[]) => void
  const recognize = vi.fn(
    () =>
      new Promise<LyricsBlock[]>((resolve) => {
        finish = resolve
      })
  )
  const dispose = vi.fn()
  vi.mocked(createLyricsEngine).mockResolvedValue({ recognize, dispose })
  const onLines = vi.fn()
  const stop = startLyricsRecognition({
    stream: source().stream,
    getCrop: () => crop,
    onStatus: vi.fn(),
    onLines,
    onError: vi.fn()
  })
  await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce())
  crop = { ...crop, height: 0.6 }
  finish([])
  await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2))
  expect(onLines).not.toHaveBeenCalled()
  expect(createLyricsEngine).toHaveBeenCalledOnce()
  expect(dispose).not.toHaveBeenCalled()
  stop()
})

for (const uncertain of [false, true]) {
  it(`retries a ${uncertain ? 'low-confidence' : 'missing'} result once at higher resolution and caches it`, async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1920)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1080)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(8),
        width,
        height
      })
    } as unknown as CanvasRenderingContext2D)
    const block = {
      text: '耶穌 耶穌',
      score: 0.99,
      poly: [
        [0, 0],
        [100, 0],
        [100, 40],
        [0, 40]
      ]
    }
    const recognize = vi
      .fn()
      .mockResolvedValueOnce(uncertain ? [{ ...block, score: 0.5 }] : [])
      .mockResolvedValue([block])
    vi.mocked(createLyricsEngine).mockResolvedValue({ recognize, dispose: vi.fn() })
    const crop = { x: 0, y: 0, width: 1, height: 0.4 }
    const onLines = vi.fn()
    const stop = startLyricsRecognition({
      stream: source().stream,
      getCrop: () => crop,
      onStatus: vi.fn(),
      onLines,
      onError: vi.fn()
    })
    try {
      await vi.advanceTimersByTimeAsync(250)
      expect(recognize.mock.calls.map(([image]) => image.width)).toEqual([960, 1920])
      expect(onLines).toHaveBeenCalledWith(['耶穌 耶穌'])
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
}

it('does not turn uncertain text into blank output when the fallback misses it', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1920)
  const recognize = vi.fn().mockImplementation(async () =>
    recognize.mock.calls.length % 2
      ? [
          {
            text: 'Uncertain',
            score: 0.5,
            poly: [
              [0, 0],
              [2, 0],
              [2, 1],
              [0, 1]
            ]
          }
        ]
      : []
  )
  vi.mocked(createLyricsEngine).mockResolvedValue({ recognize, dispose: vi.fn() })
  const crop = { x: 0, y: 0, width: 1, height: 0.4 }
  const onLines = vi.fn(),
    onError = vi.fn()
  const stop = startLyricsRecognition({
    stream: source().stream,
    getCrop: () => crop,
    onStatus: vi.fn(),
    onLines,
    onError
  })
  try {
    await vi.advanceTimersByTimeAsync(6000)
    expect(onLines).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('recognize')
  } finally {
    stop()
    vi.useRealTimers()
  }
})
