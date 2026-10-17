import { generatePptxFirstSlideThumbnail } from './pptx-renderer-service'
import { renderCoverThumbnail } from './thumbnail-worker-client'

declare const scheduler: { yield?: () => Promise<void> } | undefined

const THUMBNAIL_MAX_SIZE = 256
const JPEG_QUALITY = 0.8

export const yieldToMain = (): Promise<void> =>
  typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function'
    ? scheduler.yield()
    : new Promise<void>((resolve) => setTimeout(resolve, 0))

function createCanvas(width = THUMBNAIL_MAX_SIZE, height = THUMBNAIL_MAX_SIZE): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function isCanvasSecurityError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SecurityError'
}

function drawContainFit(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  background: string | null = null
): string | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null

  const scale = Math.min(THUMBNAIL_MAX_SIZE / sourceWidth, THUMBNAIL_MAX_SIZE / sourceHeight)
  const canvasWidth = Math.round(sourceWidth * scale)
  const canvasHeight = Math.round(sourceHeight * scale)

  const canvas = createCanvas(canvasWidth, canvasHeight)
  const context = canvas.getContext('2d')
  if (!context) return null

  if (background) {
    context.fillStyle = background
    context.fillRect(0, 0, canvasWidth, canvasHeight)
  } else {
    context.clearRect(0, 0, canvasWidth, canvasHeight)
  }

  context.drawImage(source, 0, 0, canvasWidth, canvasHeight)

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener(eventName, handleEvent)
      video.removeEventListener('error', handleError)
    }
    const handleEvent = (): void => {
      cleanup()
      resolve()
    }
    const handleError = (): void => {
      cleanup()
      reject(new Error(`Video ${eventName} failed`))
    }

    video.addEventListener(eventName, handleEvent, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })
}

async function generateVideoThumbnail(file: File): Promise<string | null> {
  const video = document.createElement('video')
  const objectUrl = URL.createObjectURL(file)

  try {
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.src = objectUrl

    await waitForVideoEvent(video, 'loadedmetadata')

    const targetTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration : 0.1)
    video.currentTime = targetTime
    await waitForVideoEvent(video, 'seeked')

    const dataUrl = drawContainFit(video, video.videoWidth, video.videoHeight)
    await yieldToMain()
    return dataUrl
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}

export async function generateThumbnail(
  file: File,
  canonicalMimeType = file.type
): Promise<string | Blob | null> {
  try {
    if (canonicalMimeType.startsWith('image/') || canonicalMimeType === 'application/pdf') {
      return await renderCoverThumbnail(file, canonicalMimeType)
    }
    if (canonicalMimeType.startsWith('video/')) return await generateVideoThumbnail(file)
    if (
      canonicalMimeType ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ) {
      return await generatePptxFirstSlideThumbnail(file)
    }
    return null
  } catch (error) {
    if (isCanvasSecurityError(error)) return null
    throw error
  }
}
