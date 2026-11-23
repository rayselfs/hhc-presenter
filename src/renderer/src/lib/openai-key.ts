import { isElectron } from './env'
import { createSpeechToken, type SpeechLanguage } from '@shared/openai-speech'

let tabKey = ''

export async function hasSpeechKey(): Promise<boolean> {
  return isElectron() ? window.api.speech.configured() : Boolean(tabKey)
}

export async function saveSpeechKey(value: string): Promise<void> {
  const key = value.trim()
  if (!/^sk-[^\s]{8,1000}$/.test(key)) throw new Error('Invalid key')
  if (isElectron()) await window.api.speech.save(key)
  else tabKey = key
}

export async function forgetSpeechKey(): Promise<void> {
  if (isElectron()) await window.api.speech.forget()
  tabKey = ''
}

export async function speechToken(language: SpeechLanguage): Promise<string> {
  if (isElectron()) return window.api.speech.token(language)
  if (!tabKey) throw new Error('credential')
  return createSpeechToken(tabKey, language)
}
