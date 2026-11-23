export type SpeechLanguage = 'zh' | 'en'

export async function createSpeechToken(key: string, language: SpeechLanguage): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 60 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            transcription: {
              model: 'gpt-live-transcribe',
              languages: [language === 'zh' ? 'zh-tw' : 'en'],
              prompt: 'Church sermon with spoken Bible book, chapter and verse references.'
            },
            turn_detection: null
          }
        }
      }
    })
  })
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403 ? 'credential' : 'unavailable'
    )
  const payload: unknown = await response.json()
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('value' in payload) ||
    typeof payload.value !== 'string' ||
    !payload.value
  )
    throw new Error('unavailable')
  return payload.value
}
