export type RecognitionLanguage = 'zh' | 'en'
export type SpeechInstallPhase = 'absent' | 'downloading' | 'verifying' | 'installed' | 'error'
export interface SpeechModelStatus {
  language: RecognitionLanguage
  phase: SpeechInstallPhase
  received: number
  total: number
  jobId: string | null
  error: string | null
  runtimeAvailable: boolean
}
export interface LocalTranscript {
  text: string
  asrMs: number
}
export const SPEECH_MODELS = {
  zh: {
    id: 'turbo-q5-0-v1',
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  },
  en: {
    id: 'small-v1',
    filename: 'ggml-small.bin',
    bytes: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
  }
} as const
export const SPEECH_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1'
export function isRecognitionLanguage(value: unknown): value is RecognitionLanguage {
  return value === 'zh' || value === 'en'
}
export function isLocalTranscript(value: unknown): value is LocalTranscript {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.text === 'string' &&
    row.text.length <= 16000 &&
    typeof row.asrMs === 'number' &&
    Number.isFinite(row.asrMs) &&
    row.asrMs >= 0
  )
}
