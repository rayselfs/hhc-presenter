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
  processLocally: boolean
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

interface LocalRecognitionConstructor {
  new (): IWebSpeechRecognition
  available?: (options: { langs: string[]; processLocally: true }) => Promise<string>
  install?: (options: { langs: string[]; processLocally: true }) => Promise<boolean>
}
function localConstructor(): LocalRecognitionConstructor | null {
  const win = window as unknown as Record<string, unknown>
  const value = win.SpeechRecognition ?? win.webkitSpeechRecognition
  return typeof value === 'function' ? (value as unknown as LocalRecognitionConstructor) : null
}
export async function browserSpeechAvailability(language: string): Promise<string> {
  const constructor = localConstructor()
  if (!constructor?.available) return 'unsupported'
  try {
    return await constructor.available({ langs: [language], processLocally: true })
  } catch {
    return 'unsupported'
  }
}
export async function installBrowserSpeech(language: string): Promise<boolean> {
  const constructor = localConstructor()
  if (!constructor?.install) return false
  return constructor.install({ langs: [language], processLocally: true })
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
    const Constructor = localConstructor()
    if (!Constructor?.available) throw new Error('on-device-unavailable')
    const recognition = new Constructor()
    if (!('processLocally' in recognition)) throw new Error('on-device-unavailable')
    this.recognition = recognition
    try {
      if ((await browserSpeechAvailability(this.config.language)) !== 'available')
        throw new Error('language-pack-unavailable')
      if (this.disposed || this.recognition !== recognition) throw new Error('session-stopped')
    } catch (error) {
      if (this.recognition === recognition) this.cleanup()
      throw error
    }
    this.recognition.processLocally = true
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
      if (this.config.maxSessionMs && this.config.maxSessionMs > 0)
        this.maxDurationTimer = setTimeout(() => {
          if (this.recognition !== recognition) return
          this.cleanup()
          this.emit('maxDurationReached', undefined)
        }, this.config.maxSessionMs)
      this.emit('sessionStarted', undefined)
    }

    try {
      recognition.start()
    } catch (error) {
      if (this.recognition === recognition) this.cleanup()
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
    } catch {
      // A pending browser permission request may not have started a native session yet.
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
