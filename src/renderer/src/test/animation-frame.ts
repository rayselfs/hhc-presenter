import { vi } from 'vitest'

export function mockAnimationFrame(): () => void {
  let nextFrameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const frameId = ++nextFrameId
    frames.set(frameId, callback)
    return frameId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
    frames.delete(frameId)
  })

  return () => {
    const pendingFrames = [...frames.values()]
    frames.clear()
    pendingFrames.forEach((callback) => callback(0))
  }
}
