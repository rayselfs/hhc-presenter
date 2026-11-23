import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useBibleStore } from '@renderer/stores/bible'
import { useSettingsStore } from '@renderer/stores/settings'
import { OpenAITranscription } from '@renderer/lib/openai-transcription'
import { VerseCandidates } from '@renderer/lib/verse-candidates'
import { hasSpeechKey } from '@renderer/lib/openai-key'

type Candidate = NonNullable<ReturnType<VerseCandidates['accept']>>
export default function SpeechRecognitionCard(): React.JSX.Element {
  const { t } = useTranslation()
  const version = useBibleSettingsStore((s) => s.selectedVersionId)
  const limit = useBibleSettingsStore((s) => s.speechMaxSessionSec)
  const speech = useSettingsStore((s) => s.speech)
  const session = useRef<OpenAITranscription | null>(null)
  const [status, setStatus] = useState<'idle' | 'preparing' | 'listening' | 'finishing'>('idle')
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const refreshDevices = useCallback(async () => {
    const all = await navigator.mediaDevices?.enumerateDevices()
    if (all) setDevices(all.filter((device) => device.kind === 'audioinput' && device.deviceId))
  }, [])
  const stop = useCallback(() => {
    const active = session.current
    session.current = null
    active?.close()
    setStatus('idle')
  }, [])
  useEffect(() => {
    setCandidates([])
    setError('')
    return stop
  }, [version, speech, stop])
  useEffect(() => {
    const refresh = (): void => {
      void refreshDevices().catch(() => {})
    }
    const offline = (): void => {
      if (session.current) {
        stop()
        setError(t('localSpeech.failed'))
      }
    }
    const keyChanged = (): void => {
      stop()
      setError('')
    }
    refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    window.addEventListener('offline', offline)
    window.addEventListener('speech-key-changed', keyChanged)
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
      window.removeEventListener('offline', offline)
      window.removeEventListener('speech-key-changed', keyChanged)
    }
  }, [refreshDevices, stop, t])
  useEffect(() => {
    if (status !== 'listening' || limit <= 0) return
    const timer = setTimeout(() => {
      stop()
      setError(t('localSpeech.deadlineReached'))
    }, limit * 1000)
    return () => clearTimeout(timer)
  }, [status, limit, stop, t])
  const start = async (): Promise<void> => {
    if (session.current || !version) return
    setError('')
    const resolver = new VerseCandidates()
    const active = new OpenAITranscription({
      language: speech.recognitionLanguage,
      deviceId: speech.microphoneId,
      onText: (text) => {
        if (
          session.current !== active ||
          useBibleSettingsStore.getState().selectedVersionId !== version
        )
          return
        const result = resolver.accept(text, useBibleStore.getState().content.get(version) ?? [])
        if (result) setCandidates((prev) => [result, ...prev].slice(0, 100))
      },
      onDisconnect: () => {
        if (session.current === active) {
          stop()
          setError(t('localSpeech.failed'))
        }
      }
    })
    session.current = active
    setStatus('preparing')
    try {
      if (!(await hasSpeechKey())) throw new Error('credential')
      if (session.current !== active) return
      await active.start()
      if (session.current !== active) return
      setStatus('listening')
      void refreshDevices().catch(() => {})
    } catch (reason) {
      if (session.current === active) {
        stop()
        const message = reason instanceof Error ? reason.message : ''
        const http = /^(token|connection) HTTP ([1-5][0-9]{2})$/.exec(message)
        if (http)
          setError(
            t(http[1] === 'token' ? 'localSpeech.tokenHttp' : 'localSpeech.connectionHttp', {
              status: http[2]
            })
          )
        else if (
          reason instanceof DOMException &&
          ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(
            reason.name
          )
        )
          setError(t('localSpeech.microphoneFailed'))
        else if (message === 'credential') setError(t('localSpeech.missingKey'))
        else if (message === 'tokenFailed' || message === 'insufficientQuota')
          setError(t(`localSpeech.${message}`))
        else setError(t('localSpeech.failed'))
      }
    }
  }
  const finish = async (): Promise<void> => {
    const active = session.current
    if (status !== 'listening' || !active) {
      stop()
      return
    }
    setStatus('finishing')
    try {
      await active.finish()
    } finally {
      if (session.current === active) stop()
    }
  }
  return (
    <section className="flex h-full flex-col gap-2 overflow-hidden p-2">
      <label>
        {t('localSpeech.microphone')}{' '}
        <select
          disabled={status !== 'idle'}
          value={speech.microphoneId}
          onChange={(e) =>
            useSettingsStore.getState().setSpeech({ ...speech, microphoneId: e.target.value })
          }
        >
          <option value="">{t('localSpeech.defaultMicrophone')}</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || t('localSpeech.microphone')}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="rounded bg-accent p-2 text-accent-foreground"
        disabled={!version || status === 'finishing'}
        onClick={() => void (status === 'idle' ? start() : finish())}
      >
        {t(status === 'idle' ? 'localSpeech.start' : 'localSpeech.stop')}
      </button>
      <span role="status">{error ? error : t(`localSpeech.${status}`)}</span>
      <div className="min-h-0 overflow-auto">
        {candidates.map((c, i) => (
          <button
            type="button"
            key={candidates.length - i + '-' + c.bookNumber + '-' + c.verse}
            className="block w-full rounded p-2 text-left hover:bg-accent-soft"
            onClick={() =>
              useBibleStore.getState().navigateTo({
                bookNumber: c.bookNumber,
                chapter: c.chapter,
                verse: c.verse,
                endVerse: c.endVerse
              })
            }
          >
            <strong>
              {c.bookName} {c.chapter}:{c.verse}
              {c.endVerse !== c.verse && '–' + c.endVerse}
            </strong>
            <p>{c.text}</p>
          </button>
        ))}
      </div>
    </section>
  )
}
