import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Select } from '@heroui/react/select'
import { ListBox } from '@heroui/react/list-box'
import { Label } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings'
import { useBibleStore } from '@renderer/stores/bible'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useBibleSearchStore } from '@renderer/stores/bible-search'
import { isElectron } from '@renderer/lib/env'
import { ChineseSpeechSession } from '@renderer/lib/chinese-speech-session'
import { locateSpokenScripture, type SpokenCandidate } from '@renderer/lib/spoken-scripture'
import { locateSpokenReference, type SpokenReferenceContext } from '@renderer/lib/spoken-reference'
import { traditionalTranscript } from '@renderer/lib/scripture-normalize'
import {
  browserSpeechAvailability,
  installBrowserSpeech,
  WebSpeechAdapter
} from '@renderer/lib/speech-adapter/providers/web-speech-adapter'
import type { SpeechModelStatus } from '@shared/local-speech'
import captureUrl from '@renderer/lib/chinese-pcm.worklet.js?url&no-inline'

interface Capture {
  id: string
  stream?: MediaStream
  context?: AudioContext
  node?: AudioWorkletNode
  controller?: ChineseSpeechSession
  candidates?: SpokenCandidate[]
  referenceContext?: SpokenReferenceContext
  finishing?: boolean
  browser?: WebSpeechAdapter
}

export default function LocalSpeechCard(): React.JSX.Element {
  const { t } = useTranslation()
  const speech = useSettingsStore((s) => s.speech)
  const setSpeech = useSettingsStore((s) => s.setSpeech)
  const sessionLimit = useBibleSettingsStore((s) => s.speechMaxSessionSec)
  const version = useBibleSettingsStore((s) => s.selectedVersionId)
  const versionLocale = useBibleStore((s) => s.versions.find((v) => v.id === version)?.locale)
  const indexReady = useBibleSearchStore((s) => s.isIndexReady)
  const [model, setModel] = useState<SpeechModelStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [browserAvailability, setBrowserAvailability] = useState('checking')
  const [state, setState] = useState<'idle' | 'preparing' | 'ready' | 'listening' | 'finishing'>(
    'idle'
  )
  const [error, setError] = useState('')
  const [transcript, setTranscript] = useState('')
  const [candidates, setCandidates] = useState<SpokenCandidate[]>([])
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [level, setLevel] = useState(0)
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  const active = useRef<Capture | null>(null)
  const navigating = useRef(false)
  const revision = useRef(0)
  const preparation = useRef<string | null>(null)
  const previous = useRef<ReturnType<typeof useBibleStore.getState>['currentPassage']>(null)
  const desktop = isElectron()
  const language = speech.recognitionLanguage
  const locale = language === 'en' ? 'en-US' : 'zh-TW'

  const stop = useCallback(() => {
    revision.current++
    const capture = active.current
    active.current = null
    capture?.controller?.stop()
    capture?.browser?.dispose()
    capture?.node?.disconnect()
    capture?.stream?.getTracks().forEach((track) => track.stop())
    if (capture?.context) void capture.context.close().catch(() => {})
    const session = capture?.id ?? preparation.current
    preparation.current = null
    if (desktop && session) void window.api.speech.stop(session).catch(() => {})
    setState('idle')
    setLevel(0)
  }, [desktop])

  useEffect(() => {
    if (state !== 'listening' || !Number.isFinite(sessionLimit) || sessionLimit <= 0) return
    const timer = setTimeout(
      () => {
        stop()
        setError(t('localSpeech.deadlineReached'))
      },
      Math.min(sessionLimit, 86400) * 1000
    )
    return () => clearTimeout(timer)
  }, [state, sessionLimit, stop, t])

  const refresh = useCallback(async () => {
    if (desktop) setModel(await window.api.speech.modelStatus(language))
    else setBrowserAvailability(await browserSpeechAvailability(locale))
  }, [desktop, language, locale])

  useEffect(() => {
    let live = true
    setModel(null)
    setBrowserAvailability('checking')
    setError('')
    setTranscript('')
    setCandidates([])
    const update = async (): Promise<void> => {
      try {
        if (desktop) {
          const value = await window.api.speech.modelStatus(language)
          if (live) setModel(value)
        } else {
          const value = await browserSpeechAvailability(locale)
          if (live) setBrowserAvailability(value)
        }
      } catch {
        if (live) setError(t('localSpeech.failed'))
      }
    }
    void update()
    const timer = setInterval(() => {
      void update()
    }, 750)
    return () => {
      live = false
      clearInterval(timer)
      stop()
    }
  }, [desktop, language, locale, speech.microphoneId, stop, t])

  const prepare = useCallback(async (): Promise<void> => {
    if (!desktop || active.current) return
    const generation = ++revision.current
    const id = crypto.randomUUID()
    preparation.current = id
    setState('preparing')
    setError('')
    try {
      await window.api.speech.prepare(id, language)
      if (revision.current === generation) setState('ready')
    } catch {
      if (revision.current === generation) {
        setState('idle')
        setError(t('localSpeech.failed'))
      }
    }
  }, [desktop, language, t])

  useEffect(() => {
    if (model?.phase === 'installed' && model.runtimeAvailable) void prepare()
    // Prepare once when the installation becomes verified, not on every progress poll.
  }, [model?.phase, model?.runtimeAvailable, prepare])

  const pauseFollowing = useCallback(() => {
    followingRef.current = false
    setFollowing(false)
    revision.current++
    // Manual edits cancel the current utterance; stale results cannot overwrite the operator.
    stop()
  }, [stop])

  useEffect(() => {
    const passage = useBibleStore.subscribe((next, old) => {
      if (!navigating.current && next.currentPassage !== old.currentPassage) pauseFollowing()
    })
    const query = useBibleSearchStore.subscribe((next, old) => {
      if (next.query !== old.query) pauseFollowing()
    })
    const translation = useBibleSettingsStore.subscribe((next, old) => {
      if (next.selectedVersionId !== old.selectedVersionId) stop()
    })
    const unsubscribeInterrupted = desktop ? window.api.speech.onInterrupted?.(stop) : undefined
    const hidden = (): void => {
      if (document.hidden) stop()
    }
    document.addEventListener('visibilitychange', hidden)
    navigator.mediaDevices?.addEventListener('devicechange', stop)
    window.addEventListener('bible:pause-speech', pauseFollowing)
    return () => {
      passage()
      query()
      translation()
      stop()
      unsubscribeInterrupted?.()
      document.removeEventListener('visibilitychange', hidden)
      navigator.mediaDevices?.removeEventListener('devicechange', stop)
      window.removeEventListener('bible:pause-speech', pauseFollowing)
    }
  }, [stop, pauseFollowing, desktop])

  const navigate = (reference: [number, number, number]): void => {
    previous.current = useBibleStore.getState().currentPassage
    navigating.current = true
    try {
      useBibleStore
        .getState()
        .navigateTo({ bookNumber: reference[0], chapter: reference[1], verse: reference[2] })
    } finally {
      navigating.current = false
    }
  }

  const start = async (): Promise<void> => {
    if (active.current || !version || !indexReady) return
    const capture: Capture = { id: preparation.current ?? crypto.randomUUID() }
    preparation.current = null
    active.current = capture
    const generation = ++revision.current
    const current = (): boolean =>
      active.current === capture &&
      revision.current === generation &&
      useBibleSettingsStore.getState().selectedVersionId === version
    followingRef.current = true
    setFollowing(true)
    setState('preparing')
    setError('')
    const fail = (reason?: unknown): void => {
      if (current()) {
        stop()
        setError(
          t(
            reason instanceof Error && reason.message === 'utterance-too-long'
              ? 'localSpeech.tooLong'
              : reason instanceof DOMException && reason.name === 'NotAllowedError'
                ? 'localSpeech.microphoneDenied'
                : 'localSpeech.failed'
          )
        )
      }
    }
    let lookup = 0
    const locate = async (text: string): Promise<[number, number, number] | null> => {
      const books = useBibleStore.getState().content.get(version)
      if (!current() || !books) return null
      const token = ++lookup
      setTranscript(language === 'zh' ? traditionalTranscript(text) : text)
      const result = await locateSpokenScripture(text, books, language, capture.referenceContext)
      if (!current() || token !== lookup) return null
      capture.candidates = result.candidates
      if (!desktop) setCandidates(result.candidates)
      return result.reference
    }
    try {
      if (!desktop) {
        const adapter = new WebSpeechAdapter({ language: locale })
        capture.browser = adapter
        adapter.on('recognizing', ({ text }) => {
          if (current()) setTranscript(language === 'zh' ? traditionalTranscript(text) : text)
        })
        let utterance = 0
        adapter.on('recognized', ({ text }) => {
          const token = ++utterance
          void locate(text)
            .then((target) => {
              if (current() && token === utterance && followingRef.current && target) {
                if (
                  locateSpokenReference(text, useBibleStore.getState().content.get(version) ?? [])
                )
                  capture.referenceContext = { reference: target, acceptedAt: performance.now() }
                navigate(target)
              }
            })
            .catch(fail)
        })
        adapter.on('error', fail)
        adapter.on('sessionStopped', () => {
          if (current()) stop()
        })
        adapter.on('sessionStarted', () => {
          if (current()) setState('listening')
        })
        await adapter.start()
        return
      }
      await window.api.speech.prepare(capture.id, language)
      if (!current()) return
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          deviceId: speech.microphoneId ? { exact: speech.microphoneId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      capture.stream = stream
      for (const track of stream.getTracks())
        track.addEventListener('ended', () => {
          if (active.current === capture && !capture.finishing) fail()
        })
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === 'audioinput'
        )
      )
      if (!current()) return
      const context = new AudioContext({ sampleRate: 16000 })
      capture.context = context
      if (context.sampleRate !== 16000) throw new Error('capture-rate')
      await context.audioWorklet.addModule(captureUrl)
      if (!current()) return
      capture.controller = new ChineseSpeechSession(
        async (pcm) => {
          const decoded = await window.api.speech.transcribe(capture.id, pcm)
          const started = performance.now()
          const reference = await locate(decoded.text)
          return { ...decoded, reference, locateMs: performance.now() - started }
        },
        (completion) => {
          if (!current()) return
          setCandidates(capture.candidates ?? [])
          if (followingRef.current && completion.result.reference) {
            if (
              locateSpokenReference(
                completion.result.text,
                useBibleStore.getState().content.get(version) ?? []
              )
            )
              capture.referenceContext = {
                reference: completion.result.reference,
                acceptedAt: performance.now()
              }
            navigate(completion.result.reference)
          }
          if (completion.manual) stop()
        },
        fail
      )
      const node = new AudioWorkletNode(context, 'chinese-pcm-capture')
      capture.node = node
      node.port.onmessage = (
        event: MessageEvent<{ pcm: ArrayBuffer; frame: number } | { finished: true }>
      ) => {
        if (!current()) return
        if ('finished' in event.data) {
          capture.stream?.getTracks().forEach((track) => track.stop())
          node.disconnect()
          capture.controller?.finish()
          return
        }
        const pcm = new Float32Array(event.data.pcm)
        setLevel(
          Math.min(
            1,
            Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length) * 10
          )
        )
        const stamp = context.getOutputTimestamp()
        const at =
          stamp.performanceTime !== undefined && stamp.contextTime !== undefined
            ? stamp.performanceTime + (event.data.frame / 16000 - stamp.contextTime) * 1000
            : performance.now() - (context.currentTime - event.data.frame / 16000) * 1000
        capture.controller?.push(pcm, at)
      }
      node.onprocessorerror = fail
      context.createMediaStreamSource(stream).connect(node)
      node.connect(context.destination)
      await context.resume()
      if (current()) setState('listening')
    } catch (reason) {
      fail(reason)
    }
  }

  const install = async (): Promise<void> => {
    if (installing) return
    setInstalling(true)
    setError('')
    try {
      if (desktop) await window.api.speech.installModel(language)
      else if (!(await installBrowserSpeech(locale))) throw new Error('install-failed')
      await refresh()
    } catch {
      setError(t('localSpeech.installFailed'))
      await refresh().catch(() => {})
    } finally {
      setInstalling(false)
    }
  }
  const busyInstall = model?.phase === 'downloading' || model?.phase === 'verifying'
  const installed = desktop
    ? model?.phase === 'installed' && model.runtimeAvailable
    : browserAvailability === 'available'
  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-3" aria-label={t('localSpeech.title')}>
      <Select
        value={language}
        onChange={(key) => {
          if (key === 'zh' || key === 'en') setSpeech({ ...speech, recognitionLanguage: key })
        }}
        aria-label={t('localSpeech.language')}
      >
        <Label>{t('localSpeech.language')}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id="zh" textValue="中文">
              中文
            </ListBox.Item>
            <ListBox.Item id="en" textValue="English">
              English
            </ListBox.Item>
          </ListBox>
        </Select.Popover>
      </Select>
      <p className="text-xs text-muted">{t('localSpeech.private')}</p>
      {desktop && model && !model.runtimeAvailable && (
        <p role="alert">{t('localSpeech.runtimeUnavailable')}</p>
      )}
      {!desktop && ['unsupported', 'unavailable'].includes(browserAvailability) && (
        <p role="status">{t('localSpeech.browserUnavailable')}</p>
      )}
      {!installed &&
        (desktop
          ? model?.runtimeAvailable
          : ['downloadable', 'downloading'].includes(browserAvailability)) && (
          <>
            <Button
              isDisabled={busyInstall || installing || browserAvailability === 'downloading'}
              onPress={() => {
                void install()
              }}
            >
              {t('localSpeech.install')}
            </Button>
            {model && (
              <p>
                {(model.received / 1024 / 1024).toFixed(0)} /{' '}
                {(model.total / 1024 / 1024).toFixed(0)} MB
              </p>
            )}
          </>
        )}
      {busyInstall && (
        <>
          <progress
            value={model.received}
            max={model.total}
            aria-label={t('localSpeech.install')}
          />
          <Button
            variant="secondary"
            onPress={() => {
              void window.api.speech.cancelInstall().catch(() => setError(t('localSpeech.failed')))
            }}
          >
            {t('localSpeech.cancel')}
          </Button>
        </>
      )}
      {desktop && (
        <Select
          value={speech.microphoneId || 'default'}
          onChange={(key) =>
            setSpeech({ ...speech, microphoneId: key === 'default' ? '' : String(key) })
          }
          aria-label={t('localSpeech.microphone')}
        >
          <Label>{t('localSpeech.microphone')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="default" textValue={t('localSpeech.defaultMicrophone')}>
                {t('localSpeech.defaultMicrophone')}
              </ListBox.Item>
              {speech.microphoneId && !devices.some((d) => d.deviceId === speech.microphoneId) && (
                <ListBox.Item id={speech.microphoneId} textValue={t('localSpeech.savedMicrophone')}>
                  {t('localSpeech.savedMicrophone')}
                </ListBox.Item>
              )}
              {devices
                .filter((d) => d.deviceId !== 'default')
                .map((d, i) => (
                  <ListBox.Item
                    id={d.deviceId}
                    key={d.deviceId}
                    textValue={d.label || `Microphone ${i + 1}`}
                  >
                    {d.label || `Microphone ${i + 1}`}
                  </ListBox.Item>
                ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      <p role="status" data-speech-status={state}>
        {t(`localSpeech.${state}`)}
      </p>
      {!indexReady && <p>{t('localSpeech.indexRequired')}</p>}
      {versionLocale && !versionLocale.toLowerCase().startsWith(language) && (
        <p>{t('localSpeech.translationMismatch')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          isDisabled={!installed || !indexReady || !['idle', 'ready'].includes(state)}
          onPress={() => {
            void start()
          }}
        >
          {t('localSpeech.start')}
        </Button>
        {desktop && (
          <Button
            variant="secondary"
            isDisabled={state !== 'listening'}
            onPress={() => {
              if (active.current) active.current.finishing = true
              setState('finishing')
              active.current?.node?.port.postMessage('finish')
            }}
          >
            {t('localSpeech.finish')}
          </Button>
        )}
        <Button
          variant="danger"
          isDisabled={!active.current && state !== 'preparing'}
          onPress={stop}
        >
          {t('localSpeech.stop')}
        </Button>
      </div>
      <meter min={0} max={1} value={level} aria-label={t('localSpeech.level')} />
      <p className="text-xs text-muted">{t('localSpeech.noiseHelp')}</p>
      {!following && (
        <Button
          variant="secondary"
          onPress={() => {
            void start()
          }}
        >
          {t('localSpeech.resume')}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {model?.error && (
        <p role="alert">
          {t(`localSpeech.errors.${model.error}`, { defaultValue: t('localSpeech.installFailed') })}
        </p>
      )}
      <p aria-live="polite" className="text-sm">
        {transcript}
      </p>
      <div className="min-h-0 overflow-auto">
        {candidates.map((candidate) => (
          <Button
            key={candidate.reference.join(':')}
            variant="secondary"
            className="mb-2 h-auto w-full whitespace-normal text-left"
            onPress={() => {
              pauseFollowing()
              navigate(candidate.reference)
            }}
          >
            {candidate.label ?? candidate.reference.join(':')} · {candidate.text}
          </Button>
        ))}
      </div>
      {previous.current && (
        <Button
          variant="ghost"
          onPress={() => {
            const target = previous.current
            pauseFollowing()
            if (target) navigate([target.bookNumber, target.chapter, target.verse])
          }}
        >
          {t('localSpeech.back')}
        </Button>
      )}
      {desktop && installed && state !== 'listening' && (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onPress={() => {
              stop()
              void install()
            }}
          >
            {t('localSpeech.repair')}
          </Button>
          <Button
            variant="ghost"
            onPress={() => {
              stop()
              void window.api.speech
                .removeModel(language)
                .then(refresh)
                .catch(() => setError(t('localSpeech.failed')))
            }}
          >
            {t('localSpeech.remove')}
          </Button>
        </div>
      )}
    </section>
  )
}
