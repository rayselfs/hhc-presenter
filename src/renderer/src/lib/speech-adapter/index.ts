import type { SpeechAdapter } from './speech-adapter.interface'
import type { SpeechSettings, SpeechProvider } from '@renderer/stores/settings'

export async function createSpeechAdapter(
  provider: SpeechProvider,
  settings: SpeechSettings,
  opts?: { maxSessionMs?: number }
): Promise<SpeechAdapter> {
  if (provider !== 'webSpeech') throw new Error('Use the managed local speech session')
  const { WebSpeechAdapter } = await import('./providers/web-speech-adapter')
  return new WebSpeechAdapter({
    language: settings.recognitionLanguage === 'en' ? 'en-US' : 'zh-TW',
    maxSessionMs: opts?.maxSessionMs
  })
}
export type { SpeechAdapter, SpeechRecognizedResult } from './speech-adapter.interface'
