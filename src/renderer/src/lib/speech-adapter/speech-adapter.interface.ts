export interface SpeechRecognizedResult {
  text: string
  bookNumber: number
  chapter: number
  verse: number
  confidence: 'exact' | 'pinyin' | 'fuzzy'
}

export type SpeechAdapterEventType =
  | 'recognizing'
  | 'recognized'
  | 'rawRecognized'
  | 'sessionStarted'
  | 'sessionStopped'
  | 'canceled'
  | 'error'
  | 'idleTimeout'
  | 'maxDurationReached'

export interface SpeechAdapterEventMap {
  recognizing: { text: string }
  recognized: SpeechRecognizedResult
  rawRecognized: { text: string; confidence: number | null }
  sessionStarted: undefined
  sessionStopped: undefined
  canceled: { reason: string }
  error: { error: Error; message: string }
  idleTimeout: undefined
  maxDurationReached: undefined
}

export type SpeechAdapterEventListener<T extends SpeechAdapterEventType> = (
  data: SpeechAdapterEventMap[T]
) => void

export interface SpeechAdapter {
  start(): Promise<void>
  stop(): Promise<void>
  isRecognizing(): boolean
  on<T extends SpeechAdapterEventType>(
    event: T,
    listener: SpeechAdapterEventListener<T>
  ): () => void
  dispose(): void
}
