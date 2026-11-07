import { createLyricsEngine, type LyricsEngine } from './engine'
import { createLyricsGate, readLyricsLines, samePixels } from './lines'
import type { LyricsCrop } from '@shared/lyrics'
type RecognitionOptions = {
  stream: MediaStream
  getCrop(): LyricsCrop
  onStatus(status: 'loading' | 'recognizing'): void
  onLines(lines: string[]): void
  onError(error: 'load' | 'recognize' | 'source'): void
}
export function startLyricsRecognition(options: RecognitionOptions): () => void {
  const abort = new AbortController()
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  const gate = createLyricsGate()
  video.muted = true
  video.playsInline = true
  video.srcObject = options.stream
  let engine: LyricsEngine | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let previousPixels: Uint8ClampedArray | null = null
  let previousCrop: LyricsCrop | null = null
  let previousSize = ''
  let previousLines: string[] | null = null
  const active = (): boolean => !abort.signal.aborted
  const unavailable = (): void => {
    if (active()) {
      gate.reset()
      previousPixels = null
      previousLines = null
      options.onError('source')
    }
  }
  const track = options.stream.getVideoTracks()[0]
  const sourceLive = (): boolean => !!track && track.readyState === 'live' && !track.muted
  track?.addEventListener('ended', unavailable)
  track?.addEventListener('mute', unavailable)
  const run = async (): Promise<void> => {
    if (!active()) return
    try {
      if (!sourceLive() || video.readyState < 2) {
        unavailable()
      } else {
        const roi = options.getCrop()
        if (roi !== previousCrop) {
          gate.reset()
          previousPixels = null
          previousLines = null
          previousCrop = roi
        }
        const width = video.videoWidth * roi.width,
          height = video.videoHeight * roi.height
        const scale = Math.min(1, 960 / width)
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Canvas unavailable')
        context.drawImage(
          video,
          video.videoWidth * roi.x,
          video.videoHeight * roi.y,
          width,
          height,
          0,
          0,
          canvas.width,
          canvas.height
        )
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        const size = canvas.width + 'x' + canvas.height
        // Exact pixel equality only: small word changes must never be skipped by a diff threshold.
        const lines =
          previousLines && size === previousSize && samePixels(image.data, previousPixels)
            ? previousLines
            : readLyricsLines(await engine!.recognize(image))
        if (!active()) return
        if (roi !== options.getCrop()) {
          timer = setTimeout(() => void run(), 100)
          return
        }
        if (!sourceLive()) {
          unavailable()
          timer = setTimeout(() => void run(), 100)
          return
        }
        previousPixels = image.data
        previousSize = size
        previousLines = lines
        const accepted = gate.observe(lines)
        if (accepted) options.onLines(accepted)
      }
    } catch (error) {
      if (!active()) return
      gate.reset()
      previousPixels = null
      previousLines = null
      options.onError('recognize')
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
    if (active()) timer = setTimeout(() => void run(), 100)
  }
  options.onStatus('loading')
  void (async () => {
    try {
      await video.play()
      engine = await createLyricsEngine(abort.signal)
      if (!active()) {
        engine.dispose()
        return
      }
      options.onStatus('recognizing')
      await run()
    } catch (error) {
      if (active()) {
        console.error('[lyrics] Initialization failed', error)
        options.onError('load')
      }
    }
  })()
  return () => {
    abort.abort()
    if (timer) clearTimeout(timer)
    engine?.dispose()
    video.pause()
    video.srcObject = null
    track?.removeEventListener('ended', unavailable)
    track?.removeEventListener('mute', unavailable)
  }
}
