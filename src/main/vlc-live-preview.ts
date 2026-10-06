import { app } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { VlcPlayer } from 'electron-vlc-player'

export interface VlcLiveFrame {
  imageDataUrl: string
  capturedAt: number
  captureDurationMs: number
}

// A monitor of the actual player, bounded to 640x360 and at most four captures/second.
export function createVlcLivePreview(
  player: Pick<VlcPlayer, 'takeSnapshot' | 'getVideoSize'>,
  isCurrent: () => boolean
): () => Promise<VlcLiveFrame | null> {
  let inFlight: Promise<VlcLiveFrame | null> | null = null
  let nextCaptureAt = 0
  let lastFrame: VlcLiveFrame | null = null

  async function capture(): Promise<VlcLiveFrame | null> {
    const directory = join(app.getPath('temp'), 'hhc-presenter-vlc-preview')
    const path = join(directory, `${process.pid}-${randomUUID()}.png`)
    await fs.mkdir(directory, { recursive: true })
    const started = performance.now()
    try {
      if (!isCurrent()) return null
      const size = player.getVideoSize()
      if (
        !Number.isFinite(size.width) ||
        !Number.isFinite(size.height) ||
        size.width <= 0 ||
        size.height <= 0
      )
        return null
      const scale = Math.min(1, 640 / size.width, 360 / size.height)
      if (
        !player.takeSnapshot(
          path,
          0,
          Math.max(1, Math.round(size.width * scale)),
          Math.max(1, Math.round(size.height * scale))
        )
      )
        throw new Error('Live preview capture failed')
      if (!isCurrent()) return null
      const stat = await fs.stat(path)
      if (stat.size <= 0 || stat.size > 2 * 1024 * 1024)
        throw new Error('Invalid live preview frame')
      const bytes = await fs.readFile(path)
      if (!isCurrent()) return null
      const captureDurationMs = Math.round(performance.now() - started)
      lastFrame = {
        imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
        capturedAt: Date.now(),
        captureDurationMs
      }
      return lastFrame
    } finally {
      // Slow native captures back off rather than queueing work on the main process.
      nextCaptureAt = Date.now() + Math.max(250, (performance.now() - started) * 3)
      await fs.rm(path, { force: true })
    }
  }

  return () => {
    if (!isCurrent()) return Promise.resolve(null)
    if (inFlight) return inFlight
    if (Date.now() < nextCaptureAt) return Promise.resolve(lastFrame)
    inFlight = capture().finally(() => {
      inFlight = null
    })
    return inFlight
  }
}
