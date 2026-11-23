import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasSpeechKey, saveSpeechKey, forgetSpeechKey } from '@renderer/lib/openai-key'
import { isElectron } from '@renderer/lib/env'

export function SpeechKeySettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    void hasSpeechKey()
      .then((v) => {
        if (live) setConfigured(v)
      })
      .catch(() => {
        if (live) setError(true)
      })
    return () => {
      live = false
    }
  }, [])
  async function update(remove: boolean): Promise<void> {
    setBusy(true)
    setError(false)
    try {
      if (remove) await forgetSpeechKey()
      else await saveSpeechKey(value)
      setValue('')
      setConfigured(!remove)
      window.dispatchEvent(new Event('speech-key-changed'))
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <label className="block">
        OpenAI API key{' '}
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <p>{t(isElectron() ? 'localSpeech.desktopKey' : 'localSpeech.tabKey')}</p>
      <button type="button" disabled={busy || !value.trim()} onClick={() => void update(false)}>
        {t('localSpeech.saveKey')}
      </button>
      {configured && (
        <button type="button" disabled={busy} onClick={() => void update(true)}>
          {t('localSpeech.forgetKey')}
        </button>
      )}
      {error && <p role="alert">{t('localSpeech.keyFailed')}</p>}
    </div>
  )
}
