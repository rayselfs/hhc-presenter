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
  const snapshot = document.createElement('canvas')
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
        // Both attempts must use the same source frame, including during slide transitions.
        const sourceScale = Math.min(1, 1920 / width)
        snapshot.width = Math.max(1, Math.round(width * sourceScale))
        snapshot.height = Math.max(1, Math.round(height * sourceScale))
        const sourceContext = snapshot.getContext('2d', { willReadFrequently: true })
        if (!sourceContext) throw new Error('Canvas unavailable')
        sourceContext.drawImage(
          video,
          video.videoWidth * roi.x,
          video.videoHeight * roi.y,
          width,
          height,
          0,
          0,
          snapshot.width,
          snapshot.height
        )
        const scale = Math.min(1, 960 / snapshot.width)
        canvas.width = Math.max(1, Math.round(snapshot.width * scale))
        canvas.height = Math.max(1, Math.round(snapshot.height * scale))
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Canvas unavailable')
        context.drawImage(snapshot, 0, 0, canvas.width, canvas.height)
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        const size = canvas.width + 'x' + canvas.height
        // Exact pixel equality only: small word changes must never be skipped by a diff threshold.
        let lines: string[]
        if (previousLines && size === previousSize && samePixels(image.data, previousPixels)) {
          lines = previousLines
        } else {
          const blocks = await engine!.recognize(image)
          let uncertain = false
          try {
            lines = readLyricsLines(blocks)
          } catch (error) {
            if (snapshot.width <= canvas.width) throw error
            uncertain = true
            lines = []
          }
          if (
            !lines.length &&
            snapshot.width > canvas.width &&
            active() &&
            roi === options.getCrop() &&
            sourceLive()
          ) {
            const detailed = sourceContext.getImageData(0, 0, snapshot.width, snapshot.height)
            lines = readLyricsLines(await engine!.recognize(detailed))
            // Missing text on retry cannot turn an uncertain detected word into a blank cue.
            if (uncertain && !lines.length) throw new Error('Uncertain text block')
          }
        }
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
        else options.onStatus('recognizing')
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
