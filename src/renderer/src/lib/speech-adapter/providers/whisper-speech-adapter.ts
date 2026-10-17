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
    this.worker = new Worker(new URL('../../../workers/whisper.worker.ts', import.meta.url), {
      type: 'module'
    })

    this.worker.onmessage = (event: MessageEvent<WhisperWorkerOutgoing>) => {
      const msg = event.data
      if (msg.type === 'result' && msg.text) {
        this.emit('rawRecognized', { text: msg.text, confidence: null })
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

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.mediaRecorder = new MediaRecorder(this.stream)

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }

    this.active = true
    this.emit('sessionStarted', undefined)

    if (this.config.maxSessionMs) {
      this.maxSessionTimer = setTimeout(() => {
        this.emit('maxDurationReached', undefined)
        this.stop().catch(() => {})
      }, this.config.maxSessionMs)
    }

    this.batchIntervalId = setInterval(() => {
      this.flushBatch().catch(() => {})
    }, 2000)
    this.mediaRecorder.start(100)
  }

  private async flushBatch(): Promise<void> {
    if (this.chunks.length === 0 || !this.worker) return
    const blob = new Blob(this.chunks, { type: 'audio/webm' })
    this.chunks = []

    const arrayBuffer = await blob.arrayBuffer()
    const audioContext = new AudioContext()
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    const float32 = audioBuffer.getChannelData(0)
    audioContext.close()

    this.worker.postMessage({
      type: 'transcribe',
      audio: float32
    } satisfies WhisperWorkerIncoming)
  }

  async stop(): Promise<void> {
    if (this.maxSessionTimer) {
      clearTimeout(this.maxSessionTimer)
      this.maxSessionTimer = null
    }
    if (this.batchIntervalId) {
      clearInterval(this.batchIntervalId)
      this.batchIntervalId = null
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        t.stop()
      })
      this.stream = null
    }
    this.active = false
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
    if (this.maxSessionTimer) {
      clearTimeout(this.maxSessionTimer)
      this.maxSessionTimer = null
    }
    if (this.batchIntervalId) {
      clearInterval(this.batchIntervalId)
      this.batchIntervalId = null
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        t.stop()
      })
      this.stream = null
    }
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    this.listeners.clear()
    this.active = false
  }

  private emit<T extends SpeechAdapterEventType>(event: T, data: SpeechAdapterEventMap[T]): void {
    this.listeners.get(event)?.forEach((listener) => {
      listener(data)
    })
  }
}
