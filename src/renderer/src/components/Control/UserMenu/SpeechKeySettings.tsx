import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Input } from '@heroui/react/input'
import { CheckCircle2, KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { hasSpeechKey, saveSpeechKey, forgetSpeechKey } from '@renderer/lib/openai-key'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { isElectron } from '@renderer/lib/env'

export function SpeechKeySettings({
  onOpenBible
}: {
  onOpenBible?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [configured, setConfigured] = useState(false)
  const [editing, setEditing] = useState(false)
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
      setEditing(false)
      window.dispatchEvent(new Event('speech-key-changed'))
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3 rounded-2xl border border-separator bg-surface-secondary p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <KeyRound aria-hidden="true" className="size-4 text-muted" />
        OpenAI API key
      </h3>
      <p className="text-sm leading-relaxed text-muted">
        {t(isElectron() ? 'localSpeech.desktopKey' : 'localSpeech.tabKey')}
      </p>
      {configured && !editing ? (
        <>
          <p role="status" className="flex items-start gap-2 text-sm">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
            {t('localSpeech.keySaved')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="#/bible"
              className="rounded-full bg-accent px-3 py-2 text-sm font-medium text-accent-foreground"
              onClick={() => {
                useBibleSettingsStore.getState().setSpeechEnabled(true)
                onOpenBible?.()
              }}
            >
              {t('localSpeech.openBible')}
            </a>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() => setEditing(true)}
            >
              {t('localSpeech.replaceKey')}
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={busy}
              onPress={() => void update(true)}
            >
              {t('localSpeech.forgetKey')}
            </Button>
          </div>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (value.trim() && !busy) void update(false)
          }}
        >
          <Input
            aria-label="OpenAI API key"
            type="password"
            placeholder="sk-…"
            className="w-full"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" isDisabled={busy || !value.trim()}>
              {t(busy ? 'localSpeech.savingKey' : 'localSpeech.saveKey')}
            </Button>
            {editing && (
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={busy}
                onPress={() => {
                  setEditing(false)
                  setValue('')
                  setError(false)
                }}
              >
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </form>
      )}
      {error && (
        <p className="text-sm text-danger" role="alert">
          {t('localSpeech.keyFailed')}
        </p>
      )}
    </section>
  )
}
