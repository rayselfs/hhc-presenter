import type { LyricsEngine } from './engine'
import { readLyricsLines } from './lines'
import { photoLyricsFrame } from './photo-frame'

function isSolidFrame(pixels: Uint8ClampedArray): boolean {
  for (let i = 4; i < pixels.length; i += 4) {
    if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2])
      return false
  }
  return true
}

// Large bright type on a black slide fragments into overlapping word boxes at detector scale.
// Use a compact dark-on-light frame only when the sampled rows have ample resolution.
export function hasLargeDarkSlideText(image: ImageData): boolean {
  if (image.width < 800) return false
  let dark = 0,
    samples = 0,
    start = -1,
    last = -1,
    bands = 0
  for (let y = 0; y < image.height; y += 2) {
    let foreground = 0
    for (let x = 0; x < image.width; x += 8) {
      const i = (y * image.width + x) * 4
      const value = Math.max(image.data[i], image.data[i + 1], image.data[i + 2])
      if (value < 16) dark++
      if (value > 128) foreground++
      samples++
    }
    if (foreground) {
      if (start < 0) start = y
      last = y
    }
    if (start >= 0 && (y - last >= 8 || y + 2 >= image.height)) {
      if (last - start < 32) return false
      bands++
      start = -1
    }
  }
  return bands > 0 && dark > samples * 0.75
}

export function compactLyricsFrame(
  source: HTMLCanvasElement,
  canvas: HTMLCanvasElement
): ImageData {
  canvas.width = 640
  canvas.height = Math.max(1, Math.round((source.height * 640) / source.width))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 255 - Math.max(image.data[i], image.data[i + 1], image.data[i + 2])
    image.data[i] = image.data[i + 1] = image.data[i + 2] = value
  }
  return image
}

export async function recognizeLyricsFrame(
  engine: LyricsEngine,
  image: ImageData,
  source: HTMLCanvasElement,
  compact: HTMLCanvasElement,
  isCurrent: () => boolean
): Promise<string[]> {
  const solid = isSolidFrame(image.data)
  const primary = solid
    ? image
    : hasLargeDarkSlideText(image)
      ? compactLyricsFrame(source, compact)
      : (photoLyricsFrame(image) ?? image)
  let uncertain = false
  const read = async (frame: ImageData): Promise<string[]> => {
    const blocks = await engine.recognize(frame)
    try {
      return readLyricsLines(blocks, frame)
    } catch {
      uncertain = true
      return []
    }
  }
  let lines = solid ? [] : await read(primary)
  if (!lines.length && primary !== image && isCurrent()) lines = await read(image)
  if (!lines.length && source.width > image.width && isCurrent()) {
    const context = source.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas unavailable')
    const detailed = context.getImageData(0, 0, source.width, source.height)
    if (!isSolidFrame(detailed.data)) lines = await read(detailed)
  }
  if (uncertain && !lines.length) throw new Error('Uncertain text block')
  return lines
}
