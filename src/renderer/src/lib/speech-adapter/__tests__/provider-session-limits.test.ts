import { afterEach, expect, it, vi } from 'vitest'
import { WebSpeechAdapter } from '../providers/web-speech-adapter'
class Recognition {
  static latest: Recognition
  static available = vi.fn(async () => 'available')
  processLocally = false
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn(() => this.onstart?.())
  stop = vi.fn(() => this.onend?.())
  constructor() {
    Recognition.latest = this
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Recognition.available.mockResolvedValue('available')
})
it('sets local-only processing and respects an explicit session deadline', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('SpeechRecognition', Recognition)
  const adapter = new WebSpeechAdapter({ language: 'en-US', maxSessionMs: 1000 })
  const expired = vi.fn()
  adapter.on('maxDurationReached', expired)
  await adapter.start()
  expect(Recognition.latest.processLocally).toBe(true)
  expect(Recognition.available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true })
  await vi.advanceTimersByTimeAsync(1000)
  expect(expired).toHaveBeenCalledOnce()
  expect(adapter.isRecognizing()).toBe(false)
  adapter.dispose()
})
it('does not fall back to remote recognition for an unavailable language', async () => {
  vi.stubGlobal('SpeechRecognition', Recognition)
  Recognition.available.mockResolvedValue('unavailable')
  const adapter = new WebSpeechAdapter({ language: 'zh-TW' })
  await expect(adapter.start()).rejects.toThrow('language-pack-unavailable')
  expect(Recognition.latest.start).not.toHaveBeenCalled()
  adapter.dispose()
})
it('cancels a pending capability check before microphone startup', async () => {
  vi.stubGlobal('SpeechRecognition', Recognition)
  let complete!: (value: string) => void
  Recognition.available.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const adapter = new WebSpeechAdapter({ language: 'en-US' })
  const pending = adapter.start()
  adapter.dispose()
  complete('available')
  await expect(pending).rejects.toThrow('session-stopped')
  expect(Recognition.latest.start).not.toHaveBeenCalled()
})
it('does not let an expired check stop a newer listening session', async () => {
  vi.stubGlobal('SpeechRecognition', Recognition)
  let complete!: (value: string) => void
  Recognition.available.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const adapter = new WebSpeechAdapter({ language: 'en-US' })
  const old = adapter.start()
  await adapter.stop()
  await adapter.start()
  const current = Recognition.latest
  complete('available')
  await expect(old).rejects.toThrow('session-stopped')
  expect(adapter.isRecognizing()).toBe(true)
  expect(current.stop).not.toHaveBeenCalled()
  adapter.dispose()
})
it('remains stopped when the browser refuses stop on a not-yet-started session', async () => {
  vi.stubGlobal('SpeechRecognition', Recognition)
  const adapter = new WebSpeechAdapter({ language: 'en-US' })
  await adapter.start()
  Recognition.latest.stop.mockImplementation(() => {
    throw new DOMException('not started', 'InvalidStateError')
  })
  await expect(adapter.stop()).resolves.toBeUndefined()
  expect(adapter.isRecognizing()).toBe(false)
  adapter.dispose()
})
