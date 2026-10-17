import * as sdk from 'microsoft-cognitiveservices-speech-sdk'
import { parseVerseReference } from '../../verse-parser'
import { matchBookName } from '../../bible-book-matcher'
import { getBiblePhrases } from '../bible-phrases'
import type {
  SpeechAdapter,
  SpeechAdapterConfig,
  SpeechAdapterEventType,
  SpeechAdapterEventListener,
  SpeechAdapterEventMap,
  SpeechRecognizedResult
} from '../speech-adapter.interface'

export class AzureSpeechAdapter implements SpeechAdapter {
  private recognizer: sdk.SpeechRecognizer | null = null
  private isActive = false
  private disposed = false
  private cancelStart: (() => void) | null = null
  private listeners: Map<
    SpeechAdapterEventType,
    Set<SpeechAdapterEventListener<SpeechAdapterEventType>>
  > = new Map()
  private config: SpeechAdapterConfig
  private onlineHandler: (() => void) | null = null
  private offlineHandler: (() => void) | null = null
  private incompleteBuffer = ''
  private bufferTimer: ReturnType<typeof setTimeout> | null = null
  private readonly BUFFER_TIMEOUT = 5000

  private static readonly WATCHDOG_INTERVAL = 30_000
  private static readonly DEFAULT_IDLE_TIMEOUT_MS = 3 * 60 * 1000
  private static readonly DEFAULT_MAX_SESSION_MS = 60 * 60 * 1000
  private static readonly MAX_CONSECUTIVE_ERRORS = 3
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private lastActivityTime = 0
  private sessionStartTime = 0
  private consecutiveErrors = 0
  private idleTimeoutMs: number
  private maxSessionMs: number
  private beforeUnloadHandler: (() => void) | null = null

  constructor(config: SpeechAdapterConfig) {
    this.config = config
    this.idleTimeoutMs = config.idleTimeoutMs ?? AzureSpeechAdapter.DEFAULT_IDLE_TIMEOUT_MS
    this.maxSessionMs = config.maxSessionMs ?? AzureSpeechAdapter.DEFAULT_MAX_SESSION_MS
    this.setupNetworkListeners()
    this.setupBeforeUnloadHandler()
  }

  private setupBeforeUnloadHandler(): void {
    this.beforeUnloadHandler = () => {
      if (this.cancelStart) {
        this.dispose()
        return
      }
      if (this.isActive && this.recognizer) {
        this.recognizer.stopContinuousRecognitionAsync(
          () => {},
          () => {}
        )
        this.recognizer.close()
        this.isActive = false
      }
    }
    window.addEventListener('beforeunload', this.beforeUnloadHandler)
  }

  private recordActivity(): void {
    this.lastActivityTime = Date.now()
    this.consecutiveErrors = 0
  }

  private startWatchdog(): void {
    this.lastActivityTime = Date.now()
    this.sessionStartTime = Date.now()
    this.consecutiveErrors = 0
    this.stopWatchdog()
    this.watchdogTimer = setInterval(() => {
      const now = Date.now()
      if (now - this.sessionStartTime >= this.maxSessionMs) {
        this.emit('maxDurationReached', undefined)
        this.stop().catch(() => {})
        return
      }
      if (now - this.lastActivityTime >= this.idleTimeoutMs) {
        this.emit('idleTimeout', undefined)
        this.stop().catch(() => {})
      }
    }, AzureSpeechAdapter.WATCHDOG_INTERVAL)
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private handleCancellationError(errorDetails: string): void {
    this.consecutiveErrors++
    const message =
      this.consecutiveErrors >= AzureSpeechAdapter.MAX_CONSECUTIVE_ERRORS
        ? `Recognition stopped after ${this.consecutiveErrors} consecutive errors: ${errorDetails}`
        : errorDetails
    this.emit('error', { error: new Error(message), message })
    if (this.consecutiveErrors >= AzureSpeechAdapter.MAX_CONSECUTIVE_ERRORS) {
      this.stopWatchdog()
    }
  }

  private setupNetworkListeners(): void {
    this.onlineHandler = () => {
      if (!this.isActive && this.recognizer) {
        this.emit('error', {
          error: new Error('Network connection restored'),
          message: 'Network connection restored. Please restart recognition.'
        })
      }
    }

    this.offlineHandler = () => {
      if (this.isActive || this.cancelStart) {
        this.stop().catch(() => {})
        this.emit('error', {
          error: new Error('Network connection lost'),
          message: 'Network connection lost. Recognition stopped.'
        })
      }
    }

    window.addEventListener('online', this.onlineHandler)
    window.addEventListener('offline', this.offlineHandler)
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('Recognition adapter disposed')
    if (this.isActive || this.cancelStart) {
      throw new Error('Recognition already active')
    }

    if (!navigator.onLine) {
      throw new Error('No network connection')
    }

    let recognizer: sdk.SpeechRecognizer | null = null
    try {
      this.recognizer?.close()
      this.recognizer = null
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        this.config.subscriptionKey,
        this.config.region
      )

      const language = this.config.language || this.detectLanguage()
      speechConfig.speechRecognitionLanguage = language
      speechConfig.outputFormat = sdk.OutputFormat.Detailed
      speechConfig.setProfanity(sdk.ProfanityOption.Raw)

      speechConfig.setServiceProperty(
        'InitialSilenceTimeoutMs',
        '5000',
        sdk.ServicePropertyChannel.UriQueryParameter
      )
      speechConfig.setServiceProperty(
        'EndSilenceTimeoutMs',
        '600',
        sdk.ServicePropertyChannel.UriQueryParameter
      )

      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput()
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig)
      this.recognizer = recognizer
      const isCurrent = (): boolean => !this.disposed && this.recognizer === recognizer

      const connection = sdk.Connection.fromRecognizer(this.recognizer)
      connection.openConnection()

      const phraseList = sdk.PhraseListGrammar.fromRecognizer(this.recognizer)
      for (const phrase of getBiblePhrases(language)) {
        phraseList.addPhrase(phrase)
      }

      this.recognizer.recognizing = (_s, e) => {
        if (!isCurrent()) return
        if (e.result.reason === sdk.ResultReason.RecognizingSpeech) {
          this.recordActivity()
          this.emit('recognizing', { text: e.result.text })
        }
      }

      this.recognizer.recognized = (_s, e) => {
        if (!isCurrent()) return
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
          const text = e.result.text
          const confidence = this.extractConfidence(e.result)

          if (text && text.trim().length > 0) {
            this.recordActivity()
          }

          this.emit('rawRecognized', { text, confidence })
          if (!isCurrent()) return

          if (!text || text.trim().length === 0) {
            return
          }

          if (confidence !== null && confidence < 0.4) {
            return
          }

          this.handleRecognizedText(text)
        }
      }

      this.recognizer.sessionStarted = () => {
        if (!isCurrent()) return
        this.emit('sessionStarted', undefined)
      }

      this.recognizer.sessionStopped = () => {
        if (!isCurrent()) return
        this.isActive = false
        this.emit('sessionStopped', undefined)
        if (isCurrent() && this.cancelStart) void this.stop()
      }

      this.recognizer.canceled = (_s, e) => {
        if (!isCurrent()) return
        this.isActive = false
        const reason = sdk.CancellationReason[e.reason]
        this.emit('canceled', { reason })
        if (!isCurrent()) return

        if (e.reason === sdk.CancellationReason.Error) {
          this.handleCancellationError(e.errorDetails)
        }
        if (isCurrent() && this.cancelStart) void this.stop()
      }

      await new Promise<void>((resolve, reject) => {
        this.cancelStart = () =>
          reject(new DOMException('Recognition start canceled', 'AbortError'))
        recognizer!.startContinuousRecognitionAsync(
          () => {
            if (!isCurrent()) return
            this.cancelStart = null
            this.isActive = true
            this.startWatchdog()
            resolve()
          },
          (err) => {
            if (!isCurrent()) return
            this.cancelStart = null
            reject(new Error(`Failed to start recognition: ${err}`))
          }
        )
      })
    } catch (error) {
      if (this.disposed || (recognizer && this.recognizer !== recognizer)) throw error
      this.cancelStart = null
      this.recognizer = null
      recognizer?.close()
      this.emit('error', {
        error: error as Error,
        message: `Failed to initialize recognizer: ${(error as Error).message}`
      })
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.cancelStart) {
      const recognizer = this.recognizer
      this.recognizer = null
      this.cancelStart()
      this.cancelStart = null
      this.clearBuffer()
      this.stopWatchdog()
      recognizer?.close()
      return
    }
    if (!this.recognizer || !this.isActive) {
      return
    }

    this.clearBuffer()
    this.stopWatchdog()

    return new Promise((resolve, reject) => {
      this.recognizer!.stopContinuousRecognitionAsync(
        () => {
          this.isActive = false
          resolve()
        },
        (err) => {
          this.isActive = false
          reject(new Error(err))
        }
      )
    })
  }

  isRecognizing(): boolean {
    return this.isActive
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
      const eventListeners = this.listeners.get(event)
      if (eventListeners) {
        eventListeners.delete(listener as SpeechAdapterEventListener<SpeechAdapterEventType>)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelStart?.()
    this.cancelStart = null
    this.clearBuffer()
    this.stopWatchdog()

    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler)
      this.beforeUnloadHandler = null
    }

    if (this.recognizer) {
      this.recognizer.close()
      this.recognizer = null
    }

    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler)
      this.onlineHandler = null
    }

    if (this.offlineHandler) {
      window.removeEventListener('offline', this.offlineHandler)
      this.offlineHandler = null
    }

    this.listeners.clear()
    this.isActive = false
  }

  private detectLanguage(): string {
    const locale = navigator.language || 'en-US'
    if (locale.startsWith('zh-TW')) return 'zh-TW'
    if (locale.startsWith('zh-CN')) return 'zh-CN'
    if (locale.startsWith('zh')) return 'zh-TW'
    if (locale.startsWith('en')) return 'en-US'
    return 'en-US'
  }

  private extractConfidence(result: sdk.SpeechRecognitionResult): number | null {
    try {
      const json = result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult)
      if (!json) return null
      const parsed = JSON.parse(json)
      const nBest = parsed?.NBest
      if (Array.isArray(nBest) && nBest.length > 0) {
        return nBest[0].Confidence ?? null
      }
      return null
    } catch {
      return null
    }
  }

  private parseAndMatch(text: string): SpeechRecognizedResult | null {
    const parsed = parseVerseReference(text)
    if (!parsed) return null

    const match = matchBookName(parsed.book)
    if (!match) return null

    return {
      text,
      bookNumber: match.bookNumber,
      chapter: parsed.chapter,
      verse: parsed.verse,
      confidence: match.confidence
    }
  }

  private stripPunctuation(text: string): string {
    return text.replace(/[。，、！？.,!?；：…]/g, '')
  }

  private clearBuffer(): void {
    this.incompleteBuffer = ''
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer)
      this.bufferTimer = null
    }
  }

  private handleRecognizedText(text: string): void {
    let parsed = this.parseAndMatch(text)
    if (parsed) {
      this.clearBuffer()
      this.emit('recognized', parsed)
      return
    }

    if (this.incompleteBuffer) {
      const combined = this.stripPunctuation(this.incompleteBuffer) + this.stripPunctuation(text)
      parsed = this.parseAndMatch(combined)
      if (parsed) {
        this.clearBuffer()
        this.emit('recognized', parsed)
        return
      }
    }

    this.clearBuffer()
    this.incompleteBuffer = text
    this.bufferTimer = setTimeout(() => {
      this.incompleteBuffer = ''
      this.bufferTimer = null
    }, this.BUFFER_TIMEOUT)
  }

  private emit<T extends SpeechAdapterEventType>(event: T, data: SpeechAdapterEventMap[T]): void {
    const eventListeners = this.listeners.get(event)
    if (eventListeners) {
      eventListeners.forEach((listener) => {
        listener(data)
      })
    }
  }
}
