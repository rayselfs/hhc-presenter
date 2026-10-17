import { loadSpeechKey } from '@renderer/lib/speech-key-storage'
import { getBiblePhrases } from '../bible-phrases'
import type {
  SpeechAdapter,
  SpeechAdapterEventType,
  SpeechAdapterEventListener,
  SpeechAdapterEventMap
} from '../speech-adapter.interface'

export interface GcpSpeechAdapterConfig {
  language: 'cmn-Hant-TW' | 'cmn-Hans-CN'
  maxSessionMs?: number
  idleTimeoutMs?: number
}

export class GcpSpeechAdapter implements SpeechAdapter {
  private mediaRecorder: MediaRecorder | null = null
  private active = false
  private disposed = false
  private generation = 0
  private opening: Promise<void> | null = null
  private requestController: AbortController | null = null
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null
  private batchIntervalId: ReturnType<typeof setInterval> | null = null
  private listeners: Map<
    SpeechAdapterEventType,
    Set<SpeechAdapterEventListener<SpeechAdapterEventType>>
  > = new Map()
  private config: GcpSpeechAdapterConfig
  private chunks: Blob[] = []
  private stream: MediaStream | null = null

  constructor(config: GcpSpeechAdapterConfig) {
    this.config = config
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Speech adapter is disposed'))
    if (this.opening) return this.opening
    if (this.active) return Promise.resolve()
    const pending = this.openSession(++this.generation)
    this.opening = pending
    const clear = (): void => {
      if (this.opening === pending) this.opening = null
    }
    void pending.then(clear, clear)
    return pending
  }

  private async openSession(generation: number): Promise<void> {
    const apiKey = await loadSpeechKey('gcp')
    if (generation !== this.generation)
      throw new DOMException('Speech start cancelled', 'AbortError')
    if (!apiKey) throw new Error('GCP API key not configured')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop())
      throw new DOMException('Speech start cancelled', 'AbortError')
    }
    this.stream = stream
    try {
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      this.mediaRecorder = recorder
      this.requestController = new AbortController()
      recorder.ondataavailable = (event) => {
        if (this.active && generation === this.generation && event.data.size > 0)
          this.chunks.push(event.data)
      }
      recorder.onerror = () => this.failSession(generation, new Error('Audio recording failed'))
      recorder.start(100)
      this.active = true
      this.batchIntervalId = setInterval(() => {
        void this.flushBatch(apiKey, generation).catch((error: unknown) =>
          this.failSession(generation, error)
        )
      }, 2000)
      this.maxDurationTimer = setTimeout(
        () => {
          if (generation !== this.generation) return
          this.cleanup()
          this.emit('maxDurationReached', undefined)
        },
        this.config.maxSessionMs ?? 60 * 60 * 1000
      )
      this.emit('sessionStarted', undefined)
    } catch (error) {
      this.cleanup()
      throw error
    }
  }

  private failSession(generation: number, value: unknown): void {
    if (generation !== this.generation) return
    const error = value instanceof Error ? value : new Error(String(value))
    this.cleanup()
    this.emit('error', { error, message: error.message })
  }

  private async flushBatch(apiKey: string, generation: number): Promise<void> {
    if (!this.active || generation !== this.generation || this.chunks.length === 0) return
    const signal = this.requestController!.signal
    const blob = new Blob(this.chunks, { type: 'audio/webm;codecs=opus' })
    this.chunks = []

    const arrayBuffer = await blob.arrayBuffer()
    if (generation !== this.generation) return
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))

    const phrases = getBiblePhrases(this.config.language === 'cmn-Hant-TW' ? 'zh-TW' : 'zh-CN')

    const body = {
      config: {
        encoding: 'WEBM_OPUS',
        languageCode: this.config.language,
        speechContexts: phrases.length > 0 ? [{ phrases: phrases.slice(0, 100) }] : undefined
      },
      audio: { content: base64 }
    }

    const response = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      }
    )
    if (generation !== this.generation) return
    if (!response.ok) throw new Error(`Speech recognition request failed: ${response.status}`)
    const data = await response.json()
    if (generation !== this.generation) return
    const transcript: string | undefined = data?.results?.[0]?.alternatives?.[0]?.transcript
    if (transcript) {
      this.emit('rawRecognized', { text: transcript, confidence: null })
      if (generation !== this.generation) return
      this.emit('recognized', {
        text: transcript,
        bookNumber: 0,
        chapter: 0,
        verse: 0,
        confidence: 'fuzzy'
      })
    }
  }

  private cleanup(): void {
    this.generation += 1
    this.opening = null
    this.requestController?.abort()
    this.requestController = null
    if (this.batchIntervalId) clearInterval(this.batchIntervalId)
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer)
    this.batchIntervalId = null
    this.maxDurationTimer = null
    this.chunks = []
    const recorder = this.mediaRecorder
    const stream = this.stream
    const wasActive = this.active
    this.mediaRecorder = null
    this.stream = null
    this.active = false
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onerror = null
    }
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop()
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      if (wasActive) this.emit('sessionStopped', undefined)
    }
  }

  async stop(): Promise<void> {
    this.cleanup()
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
    this.listeners.clear()
    this.cleanup()
  }

  private emit<T extends SpeechAdapterEventType>(event: T, data: SpeechAdapterEventMap[T]): void {
    this.listeners.get(event)?.forEach((listener) => {
      listener(data)
    })
  }
}
