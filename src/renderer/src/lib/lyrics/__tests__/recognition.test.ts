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
    const stop = startLyricsRecognition({
      stream,
      crop: { x: 0, y: 0, width: 1, height: 1 },
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
