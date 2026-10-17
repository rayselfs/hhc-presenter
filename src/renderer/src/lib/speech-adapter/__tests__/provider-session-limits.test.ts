import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { GcpSpeechAdapter } from '../providers/gcp-speech-adapter'
import { WebSpeechAdapter } from '../providers/web-speech-adapter'

vi.mock('@renderer/lib/speech-key-storage', () => ({
  loadSpeechKey: vi.fn(async () => 'synthetic-key')
}))
vi.mock('../bible-phrases', () => ({ getBiblePhrases: () => [] }))

class Recorder {
  static latest: Recorder
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  start = vi.fn(() => {
    this.state = 'recording'
  })
  stop = vi.fn(() => {
    this.state = 'inactive'
  })
  constructor() {
    Recorder.latest = this
  }
}
class Recognition {
  static latest: Recognition
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onresult: ((event: unknown) => void) | null = null
  start = vi.fn(() => this.onstart?.())
  stop = vi.fn(() => this.onend?.())
  constructor() {
    Recognition.latest = this
  }
}
const stopTrack = vi.fn()
const getUserMedia = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  stopTrack.mockReset()
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] })
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('MediaRecorder', Recorder)
  vi.stubGlobal('SpeechRecognition', Recognition)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('stops GCP recording at the configured limit and emits the existing duration events', async () => {
  const adapter = new GcpSpeechAdapter({ language: 'cmn-Hant-TW', maxSessionMs: 1000 })
  const limit = vi.fn(),
    stopped = vi.fn()
  adapter.on('maxDurationReached', limit)
  adapter.on('sessionStopped', stopped)
  await adapter.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(adapter.isRecognizing()).toBe(false)
  expect(limit).toHaveBeenCalledOnce()
  expect(stopped).toHaveBeenCalledOnce()
  expect(stopTrack).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(5000)
  expect(fetch).not.toHaveBeenCalled()
  adapter.dispose()
})

it('stops Web Speech at the configured session limit', async () => {
  const adapter = new WebSpeechAdapter({ language: 'zh-TW', maxSessionMs: 1000 })
  const limit = vi.fn(),
    stopped = vi.fn()
  adapter.on('maxDurationReached', limit)
  adapter.on('sessionStopped', stopped)
  await adapter.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(adapter.isRecognizing()).toBe(false)
  expect(limit).toHaveBeenCalledOnce()
  expect(stopped).toHaveBeenCalledOnce()
  expect(Recognition.latest.stop).toHaveBeenCalledOnce()
  adapter.dispose()
})

it('releases a late microphone grant after disposal without starting a session', async () => {
  let grant!: (stream: { getTracks: () => { stop: typeof stopTrack }[] }) => void
  getUserMedia.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve
      })
  )
  const adapter = new GcpSpeechAdapter({ language: 'cmn-Hant-TW' })
  const started = vi.fn()
  adapter.on('sessionStarted', started)
  const opening = adapter.start().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  adapter.dispose()
  grant({ getTracks: () => [{ stop: stopTrack }] })
  expect(await opening).toMatchObject({ name: 'AbortError' })
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(started).not.toHaveBeenCalled()
  expect(adapter.isRecognizing()).toBe(false)
})

it('does not issue a GCP request when blob encoding completes after stop', async () => {
  let encode!: (buffer: ArrayBuffer) => void
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        encode = resolve
      })
  )
  const adapter = new GcpSpeechAdapter({ language: 'cmn-Hant-TW' })
  await adapter.start()
  Recorder.latest.ondataavailable?.({ data: new Blob(['audio']) })
  await vi.advanceTimersByTimeAsync(2000)
  await adapter.stop()
  encode(new ArrayBuffer(2))
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch).not.toHaveBeenCalled()
  adapter.dispose()
})

it('aborts GCP requests and ignores late transcripts after a restart', async () => {
  let finish!: (response: Response) => void
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const adapter = new GcpSpeechAdapter({ language: 'cmn-Hant-TW' })
  const recognized = vi.fn()
  adapter.on('recognized', recognized)
  await adapter.start()
  Recorder.latest.ondataavailable?.({ data: new Blob(['audio']) })
  await vi.advanceTimersByTimeAsync(2000)
  expect(fetch).toHaveBeenCalledOnce()
  const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
  await adapter.stop()
  await adapter.start()
  finish({
    ok: true,
    json: async () => ({ results: [{ alternatives: [{ transcript: 'stale' }] }] })
  } as Response)
  await vi.advanceTimersByTimeAsync(0)
  expect(signal?.aborted).toBe(true)
  expect(recognized).not.toHaveBeenCalled()
  expect(adapter.isRecognizing()).toBe(true)
  adapter.dispose()
})

it('reports GCP HTTP failure and stops further paid requests', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as Response)
  const adapter = new GcpSpeechAdapter({ language: 'cmn-Hant-TW' })
  const error = vi.fn(),
    stopped = vi.fn()
  adapter.on('error', error)
  adapter.on('sessionStopped', stopped)
  await adapter.start()
  const deliver = Recorder.latest.ondataavailable!
  deliver({ data: new Blob(['audio']) })
  await vi.advanceTimersByTimeAsync(2000)
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('403') })
  )
  expect(stopped).toHaveBeenCalledOnce()
  expect(adapter.isRecognizing()).toBe(false)
  deliver({ data: new Blob(['late']) })
  await vi.advanceTimersByTimeAsync(4000)
  expect(fetch).toHaveBeenCalledOnce()
  adapter.dispose()
})

it('ignores old Web Speech callbacks after restart and cancels the old deadline', async () => {
  const adapter = new WebSpeechAdapter({ language: 'zh-TW', maxSessionMs: 1000 })
  const started = vi.fn(),
    recognized = vi.fn(),
    limit = vi.fn()
  adapter.on('sessionStarted', started)
  adapter.on('recognized', recognized)
  adapter.on('maxDurationReached', limit)
  await adapter.start()
  const oldStart = Recognition.latest.onstart!
  const oldResult = Recognition.latest.onresult!
  const oldEnd = Recognition.latest.onend!
  await vi.advanceTimersByTimeAsync(500)
  await adapter.stop()
  await adapter.start()
  oldStart()
  oldEnd()
  oldResult({
    resultIndex: 0,
    results: [{ 0: { transcript: 'stale', confidence: 1 }, isFinal: true, length: 1 }]
  })
  await vi.advanceTimersByTimeAsync(500)
  expect(started).toHaveBeenCalledTimes(2)
  expect(recognized).not.toHaveBeenCalled()
  expect(limit).not.toHaveBeenCalled()
  expect(adapter.isRecognizing()).toBe(true)
  await vi.advanceTimersByTimeAsync(500)
  expect(limit).toHaveBeenCalledOnce()
  adapter.dispose()
})

it('reports recorder failures and releases microphone and timers', async () => {
  const adapter = new GcpSpeechAdapter({ language: 'cmn-Hant-TW', maxSessionMs: 1000 })
  const error = vi.fn(),
    limit = vi.fn()
  adapter.on('error', error)
  adapter.on('maxDurationReached', limit)
  await adapter.start()
  Recorder.latest.onerror?.(new Event('error'))
  expect(error).toHaveBeenCalledOnce()
  expect(adapter.isRecognizing()).toBe(false)
  expect(stopTrack).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(3000)
  expect(limit).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  adapter.dispose()
})

it('does not revive Web Speech when a pending native start arrives after disposal', async () => {
  class PendingRecognition extends Recognition {
    start = vi.fn()
  }
  vi.stubGlobal('SpeechRecognition', PendingRecognition)
  const adapter = new WebSpeechAdapter({ language: 'zh-TW', maxSessionMs: 1000 })
  const started = vi.fn(),
    limit = vi.fn()
  adapter.on('sessionStarted', started)
  adapter.on('maxDurationReached', limit)
  await adapter.start()
  const pending = Recognition.latest
  const lateStart = pending.onstart!
  adapter.dispose()
  lateStart()
  await vi.advanceTimersByTimeAsync(2000)
  expect(pending.stop).toHaveBeenCalledOnce()
  expect(adapter.isRecognizing()).toBe(false)
  expect(started).not.toHaveBeenCalled()
  expect(limit).not.toHaveBeenCalled()
})
