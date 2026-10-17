import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WhisperSpeechAdapter } from '../providers/whisper-speech-adapter'

class TestWorker {
  static instances: TestWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    TestWorker.instances.push(this)
  }
}

class TestRecorder {
  static instances: TestRecorder[] = []
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  start = vi.fn(() => {
    this.state = 'recording'
  })
  stop = vi.fn(() => {
    this.state = 'inactive'
  })
  constructor() {
    TestRecorder.instances.push(this)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise((done) => {
      resolve = done
    }),
    resolve: (value) => resolve(value)
  }
}

function microphone(): { stream: MediaStream; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn()
  return { stream: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop }
}

const getUserMedia = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  getUserMedia.mockReset()
  TestWorker.instances = []
  TestRecorder.instances = []
  vi.stubGlobal('Worker', TestWorker)
  vi.stubGlobal('MediaRecorder', TestRecorder)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Whisper session lifetime', () => {
  it.each(['stop', 'dispose'] as const)(
    'releases microphone permission arriving after %s',
    async (action) => {
      const pending = deferred<MediaStream>()
      getUserMedia.mockReturnValue(pending.promise)
      const adapter = new WhisperSpeechAdapter({ maxSessionMs: 10000 })
      const started = vi.fn()
      adapter.on('sessionStarted', started)
      const start = adapter.start()
      await adapter[action]()
      const mic = microphone()
      pending.resolve(mic.stream)
      await expect(start).rejects.toMatchObject({ name: 'AbortError' })
      expect(mic.stop).toHaveBeenCalledOnce()
      expect(started).not.toHaveBeenCalled()
      expect(adapter.isRecognizing()).toBe(false)
      expect(TestRecorder.instances).toHaveLength(0)
      expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      adapter.dispose()
    }
  )

  it('shares a pending start and releases a worker after permission rejection', async () => {
    const failure = new Error('Permission denied')
    getUserMedia.mockRejectedValue(failure)
    const adapter = new WhisperSpeechAdapter()
    const first = adapter.start()
    const second = adapter.start()
    await expect(first).rejects.toBe(failure)
    await expect(second).rejects.toBe(failure)
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce()
    const mic = microphone()
    getUserMedia.mockResolvedValue(mic.stream)
    await adapter.start()
    expect(adapter.isRecognizing()).toBe(true)
    adapter.dispose()
    expect(mic.stop).toHaveBeenCalledOnce()
  })

  it('ignores old worker callbacks after stop and restart', async () => {
    getUserMedia.mockImplementation(async () => microphone().stream)
    const adapter = new WhisperSpeechAdapter()
    const recognized = vi.fn()
    adapter.on('recognized', recognized)
    await adapter.start()
    const oldCallback = TestWorker.instances[0].onmessage!
    await adapter.stop()
    await adapter.start()
    oldCallback({ data: { type: 'result', text: 'old' } } as MessageEvent)
    expect(recognized).not.toHaveBeenCalled()
    TestWorker.instances[1].onmessage!({
      data: { type: 'result', text: 'current' }
    } as MessageEvent)
    expect(recognized).toHaveBeenCalledOnce()
    adapter.dispose()
  })

  it('does not emit a recognized result after a raw-result listener stops the session', async () => {
    getUserMedia.mockResolvedValue(microphone().stream)
    const adapter = new WhisperSpeechAdapter()
    const recognized = vi.fn()
    adapter.on('rawRecognized', () => {
      void adapter.stop()
    })
    adapter.on('recognized', recognized)
    await adapter.start()
    TestWorker.instances[0].onmessage!({ data: { type: 'result', text: 'stale' } } as MessageEvent)
    expect(recognized).not.toHaveBeenCalled()
    adapter.dispose()
  })

  it.each([false, true])(
    'closes audio decoding and fences stopped sessions: %s',
    async (stopDuringDecode) => {
      getUserMedia.mockResolvedValue(microphone().stream)
      vi.spyOn(Blob.prototype, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(1))
      const decoded = deferred<AudioBuffer>()
      const close = vi.fn().mockResolvedValue(undefined)
      const decode = vi.fn(() => decoded.promise)
      vi.stubGlobal(
        'AudioContext',
        class {
          decodeAudioData = decode
          close = close
        }
      )
      const adapter = new WhisperSpeechAdapter()
      await adapter.start()
      const worker = TestWorker.instances[0]
      TestRecorder.instances[0].ondataavailable!({ data: new Blob(['audio']) })
      await vi.advanceTimersByTimeAsync(2000)
      expect(decode).toHaveBeenCalledOnce()
      if (stopDuringDecode) await adapter.stop()
      const samples = new Float32Array([1, 2])
      decoded.resolve({ getChannelData: () => samples } as unknown as AudioBuffer)
      await vi.advanceTimersByTimeAsync(0)
      expect(close).toHaveBeenCalledOnce()
      expect(worker.postMessage).toHaveBeenCalledTimes(stopDuringDecode ? 0 : 1)
      if (!stopDuringDecode)
        expect(worker.postMessage).toHaveBeenCalledWith({ type: 'transcribe', audio: samples })
      adapter.dispose()
    }
  )

  it('emits the duration limit before stopping and permits reentrant disposal', async () => {
    const mic = microphone()
    getUserMedia.mockResolvedValue(mic.stream)
    const adapter = new WhisperSpeechAdapter({ maxSessionMs: 50 })
    const events: string[] = []
    adapter.on('maxDurationReached', () => {
      events.push('limit')
      adapter.dispose()
    })
    adapter.on('sessionStopped', () => events.push('stopped'))
    await adapter.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(events).toEqual(['limit'])
    expect(adapter.isRecognizing()).toBe(false)
    expect(mic.stop).toHaveBeenCalledOnce()
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
