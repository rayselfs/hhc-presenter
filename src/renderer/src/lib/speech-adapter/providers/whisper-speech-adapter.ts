import type {
  SpeechAdapter,
  SpeechAdapterEventType,
  SpeechAdapterEventListener,
  SpeechAdapterEventMap
} from '../speech-adapter.interface'
import type { WhisperWorkerIncoming, WhisperWorkerOutgoing } from '@renderer/workers/whisper.worker'

export interface WhisperSpeechAdapterConfig {
  maxSessionMs?: number
  idleTimeoutMs?: number
}

export class WhisperSpeechAdapter implements SpeechAdapter {
  private worker: Worker | null = null
  private mediaRecorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private active = false
  private generation = 0
  private disposed = false
  private starting: Promise<void> | null = null
  private batchIntervalId: ReturnType<typeof setInterval> | null = null
  private chunks: Blob[] = []
  private listeners: Map<
    SpeechAdapterEventType,
    Set<SpeechAdapterEventListener<SpeechAdapterEventType>>
  > = new Map()
  private config: WhisperSpeechAdapterConfig
  private maxSessionTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: WhisperSpeechAdapterConfig = {}) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('Speech adapter is disposed')
    if (this.active) return
    if (this.starting) return this.starting
    const generation = ++this.generation
    const pending = this.startSession(generation)
    this.starting = pending
    try {
      await pending
    } finally {
      if (this.starting === pending) this.starting = null
    }
  }

  private async startSession(generation: number): Promise<void> {
    try {
      const worker = new Worker(new URL('../../../workers/whisper.worker.ts', import.meta.url), {
        type: 'module'
      })
      this.worker = worker
      worker.onmessage = (event: MessageEvent<WhisperWorkerOutgoing>) => {
        if (generation !== this.generation || this.worker !== worker || !this.active) return
        const msg = event.data
        if (msg.type === 'result' && msg.text) {
          this.emit('rawRecognized', { text: msg.text, confidence: null })
          if (generation !== this.generation || this.worker !== worker || !this.active) return
          this.emit('recognized', {
            text: msg.text,
            bookNumber: 0,
            chapter: 0,
            verse: 0,
            confidence: 'fuzzy'
          })
        } else if (msg.type === 'error') {
          this.emit('error', { error: new Error(msg.message), message: msg.message })
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (generation !== this.generation || this.disposed) {
        stream.getTracks().forEach((track) => track.stop())
        throw new DOMException('Speech start was cancelled', 'AbortError')
      }
      this.stream = stream
      const recorder = new MediaRecorder(stream)
      this.mediaRecorder = recorder
      recorder.ondataavailable = (event) => {
        if (generation === this.generation && this.active && event.data.size > 0)
          this.chunks.push(event.data)
      }
      this.active = true
      recorder.start(100)
      if (this.config.maxSessionMs) {
        this.maxSessionTimer = setTimeout(() => {
          this.emit('maxDurationReached', undefined)
          this.stop().catch(() => {})
        }, this.config.maxSessionMs)
      }
      this.batchIntervalId = setInterval(() => {
        this.flushBatch().catch(() => {})
      }, 2000)
      this.emit('sessionStarted', undefined)
    } catch (error) {
      if (generation === this.generation) this.releaseResources()
      throw error
    }
  }

  private async flushBatch(): Promise<void> {
    const worker = this.worker
    const generation = this.generation
    if (!this.active || this.chunks.length === 0 || !worker) return
    const isCurrent = (): boolean =>
      this.active && generation === this.generation && this.worker === worker
    const blob = new Blob(this.chunks, { type: 'audio/webm' })
    this.chunks = []

    const arrayBuffer = await blob.arrayBuffer()
    if (!isCurrent()) return
    const audioContext = new AudioContext()
    try {
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
      if (!isCurrent()) return
      worker.postMessage({
        type: 'transcribe',
        audio: audioBuffer.getChannelData(0)
      } satisfies WhisperWorkerIncoming)
    } finally {
      await audioContext.close()
    }
  }

  private releaseResources(): void {
    this.generation += 1
    this.starting = null
    this.active = false
    this.chunks = []
    if (this.maxSessionTimer) {
      clearTimeout(this.maxSessionTimer)
      this.maxSessionTimer = null
    }
    if (this.batchIntervalId) {
      clearInterval(this.batchIntervalId)
      this.batchIntervalId = null
    }
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null
      if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop()
      this.mediaRecorder = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }
    if (this.worker) {
      this.worker.onmessage = null
      this.worker.terminate()
      this.worker = null
    }
  }

  async stop(): Promise<void> {
    this.releaseResources()
    this.emit('sessionStopped', undefined)
  }

  isRecognizing(): boolean {
    return this.active
  }

  on<T extends SpeechAdapterEventType>(
    event: T,
    listener: SpeechAdapterEventListener<T>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(listener as SpeechAdapterEventListener<SpeechAdapterEventType>)
    return () => {
      this.listeners
        .get(event)
        ?.delete(listener as SpeechAdapterEventListener<SpeechAdapterEventType>)
    }
  }

  dispose(): void {
    this.disposed = true
    this.releaseResources()
    this.listeners.clear()
  }

  private emit<T extends SpeechAdapterEventType>(event: T, data: SpeechAdapterEventMap[T]): void {
    this.listeners.get(event)?.forEach((listener) => {
      listener(data)
    })
  }
}
