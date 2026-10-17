import type {
  SpeechAdapter,
  SpeechAdapterEventType,
  SpeechAdapterEventListener,
  SpeechAdapterEventMap
} from '../speech-adapter.interface'

interface WebSpeechRecognitionAlternative {
  readonly confidence: number
  readonly transcript: string
}
interface WebSpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: WebSpeechRecognitionAlternative
}
interface WebSpeechRecognitionResultList {
  readonly length: number
  item(index: number): WebSpeechRecognitionResult
  readonly [index: number]: WebSpeechRecognitionResult
}
interface WebSpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: WebSpeechRecognitionResultList
}
interface WebSpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}
interface IWebSpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: WebSpeechRecognitionEvent) => void) | null
  onerror: ((event: WebSpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
  start(): void
  stop(): void
}

export interface WebSpeechAdapterConfig {
  language: string
  maxSessionMs?: number
  idleTimeoutMs?: number
}

export class WebSpeechAdapter implements SpeechAdapter {
  private recognition: IWebSpeechRecognition | null = null
  private active = false
  private disposed = false
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null
  private listeners: Map<
    SpeechAdapterEventType,
    Set<SpeechAdapterEventListener<SpeechAdapterEventType>>
  > = new Map()
  private config: WebSpeechAdapterConfig

  constructor(config: WebSpeechAdapterConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('Speech adapter is disposed')
    if (this.recognition) return
    const win = window as unknown as Record<string, unknown>
    const SpeechRecognitionCtor = win['SpeechRecognition'] || win['webkitSpeechRecognition']
    if (!SpeechRecognitionCtor) {
      throw new Error('Web Speech API not supported in this browser')
    }

    this.recognition = new (SpeechRecognitionCtor as new () => IWebSpeechRecognition)()
    const recognition = this.recognition
    this.recognition.continuous = true
    this.recognition.interimResults = true
    this.recognition.lang = this.config.language

    this.recognition.onresult = (event: WebSpeechRecognitionEvent) => {
      if (this.recognition !== recognition) return
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (this.recognition !== recognition) return
        const result = event.results[i]
        const text = result[0].transcript
        if (result.isFinal) {
          this.emit('recognized', {
            text,
            bookNumber: 0,
            chapter: 0,
            verse: 0,
            confidence: 'fuzzy'
          })
          if (this.recognition === recognition)
            this.emit('rawRecognized', { text, confidence: result[0].confidence })
        } else {
          this.emit('recognizing', { text })
        }
      }
    }

    this.recognition.onerror = (event: WebSpeechRecognitionErrorEvent) => {
      if (this.recognition !== recognition) return
      this.cleanup()
      this.emit('error', { error: new Error(event.error), message: event.error })
    }

    this.recognition.onend = () => {
      if (this.recognition === recognition) this.cleanup(false)
    }

    this.recognition.onstart = () => {
      if (this.recognition !== recognition) return
      this.active = true
      this.maxDurationTimer = setTimeout(
        () => {
          if (this.recognition !== recognition) return
          this.cleanup()
          this.emit('maxDurationReached', undefined)
        },
        this.config.maxSessionMs ?? 60 * 60 * 1000
      )
      this.emit('sessionStarted', undefined)
    }

    try {
      recognition.start()
    } catch (error) {
      this.cleanup()
      throw error
    }
  }

  private cleanup(stop = true): void {
    const recognition = this.recognition
    this.recognition = null
    this.active = false
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer)
    this.maxDurationTimer = null
    if (!recognition) return
    recognition.onstart = null
    recognition.onend = null
    recognition.onresult = null
    recognition.onerror = null
    try {
      if (stop) recognition.stop()
    } finally {
      this.emit('sessionStopped', undefined)
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
