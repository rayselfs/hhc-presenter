import { promises as fs, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, expect, it, vi } from 'vitest'

const root = `/tmp/hhc-vlc-live-preview-${process.pid}`
vi.mock('electron', () => ({ app: { getPath: () => root } }))
import { createVlcLivePreview } from '../vlc-live-preview'

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

it('captures the existing decoded player at bounded resolution, coalesces overlap and removes frame files', async () => {
  const player = {
    getVideoSize: vi.fn(() => ({ width: 1920, height: 1080 })),
    takeSnapshot: vi.fn((path: string) => {
      writeFileSync(path, 'png-frame')
      return true
    })
  }
  const capture = createVlcLivePreview(player, () => true)
  const first = capture()
  expect(capture()).toBe(first)
  const frame = await first
  expect(frame?.imageDataUrl).toBe(
    `data:image/png;base64,${Buffer.from('png-frame').toString('base64')}`
  )
  expect(frame?.captureDurationMs).toBeGreaterThanOrEqual(0)
  expect(player.takeSnapshot).toHaveBeenCalledWith(expect.any(String), 0, 640, 360)
  expect(await fs.readdir(join(root, 'hhc-presenter-vlc-preview'))).toEqual([])
  expect(await capture()).toBe(frame)
  expect(player.takeSnapshot).toHaveBeenCalledOnce()
})

it('discards a frame and cleans up when its projection session ends during capture', async () => {
  let current = true
  const player = {
    getVideoSize: () => ({ width: 640, height: 360 }),
    takeSnapshot: vi.fn((path: string) => {
      writeFileSync(path, 'stale')
      current = false
      return true
    })
  }
  const capture = createVlcLivePreview(player, () => current)
  expect(await capture()).toBeNull()
  expect(await capture()).toBeNull()
  expect(player.takeSnapshot).toHaveBeenCalledOnce()
  expect(await fs.readdir(join(root, 'hhc-presenter-vlc-preview'))).toEqual([])
})

it('does not retain failed snapshots or block a later retry', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
  const player = {
    getVideoSize: () => ({ width: 1080, height: 1920 }),
    takeSnapshot: vi.fn((path: string) => {
      writeFileSync(path, 'partial')
      return false
    })
  }
  const capture = createVlcLivePreview(player, () => true)
  await expect(capture()).rejects.toThrow('capture failed')
  expect(await fs.readdir(join(root, 'hhc-presenter-vlc-preview'))).toEqual([])
  clock.mockReturnValue(60_000)
  player.takeSnapshot.mockImplementation((path) => {
    writeFileSync(path, 'ready')
    return true
  })
  await expect(capture()).resolves.toMatchObject({ capturedAt: 60_000 })
  expect(player.takeSnapshot).toHaveBeenLastCalledWith(expect.any(String), 0, 203, 360)
})
