import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { useBibleStore } from '@renderer/stores/bible'
import { useBibleSearchStore } from '@renderer/stores/bible-search'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import {
  ChineseSpeechSession,
  type ChineseSpeechCompletion
} from '@renderer/lib/chinese-speech-session'
import captureUrl from '@renderer/lib/chinese-pcm.worklet.js?url&no-inline'

interface ActiveSession {
  id: string
  controller: ChineseSpeechSession | null
  stream: MediaStream | null
  context: AudioContext | null
  node: AudioWorkletNode | null
}

interface Trace extends ChineseSpeechCompletion {
  paintedAt: number
  totalMs: number
  scrollCorrected: boolean
  outcome: 'located' | 'rejected' | 'not-visible'
}

export function ChineseSpeechPilot(): React.JSX.Element {
  const version = useBibleSettingsStore((state) => state.selectedVersionId)
  const active = useRef<ActiveSession | null>(null)
  const navigating = useRef(false)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [traces, setTraces] = useState<Trace[]>([])

  const stop = useCallback(() => {
    const session = active.current
    active.current = null
    session?.controller?.stop()
    session?.stream?.getTracks().forEach((track) => track.stop())
    session?.node?.disconnect()
    if (session?.context) void session.context.close().catch(() => {})
    if (session) void window.api.speech.chineseStop(session.id).catch(() => {})
    setStatus('idle')
  }, [])

  useEffect(() => {
    const unsubscribe = useBibleSettingsStore.subscribe((next, previous) => {
      if (next.selectedVersionId !== previous.selectedVersionId) stop()
    })
    const unsubscribePassage = useBibleStore.subscribe((next, previous) => {
      if (!navigating.current && next.currentPassage !== previous.currentPassage) stop()
    })
    const unsubscribeSearch = useBibleSearchStore.subscribe((next, previous) => {
      if (!navigating.current && next.query !== previous.query) stop()
    })
    return () => {
      unsubscribe()
      unsubscribePassage()
      unsubscribeSearch()
      stop()
    }
  }, [stop])

  const start = async (): Promise<void> => {
    if (active.current || !version) return
    const session: ActiveSession = {
      id: crypto.randomUUID(),
      controller: null,
      stream: null,
      context: null,
      node: null
    }
    active.current = session
    setError('')
    setStatus('preparing')
    const current = (): boolean =>
      active.current === session && useBibleSettingsStore.getState().selectedVersionId === version
    const fail = (reason: Error): void => {
      if (!current()) return
      stop()
      setError(
        reason.message === 'utterance-too-long'
          ? '這段語句超過 30 秒，已停止收音。請分句重試，或說完後按「完成一句」。'
          : reason.message === 'no-speech'
            ? '尚未收到語音。'
            : '本機辨識未完成，請重新開始。'
      )
    }
    try {
      await window.api.speech.chinesePrepare(session.id)
      if (!current()) return
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      session.stream = stream
      for (const track of stream.getTracks())
        track.addEventListener('ended', () => fail(new Error('microphone-ended')))
      const context = new AudioContext({ sampleRate: 16000 })
      session.context = context
      if (context.sampleRate !== 16000) throw new Error('Unsupported capture sample rate')
      await context.audioWorklet.addModule(captureUrl)
      if (!current()) return
      session.controller = new ChineseSpeechSession(
        (pcm) => window.api.speech.chineseTranscribe(session.id, pcm),
        (completion) => {
          if (!current()) return
          const target = completion.result.reference
          const books = useBibleStore.getState().content.get(version)
          const verse =
            target &&
            books
              ?.find((book) => book.number === target[0])
              ?.chapters.find((chapter) => chapter.number === target[1])
              ?.verses.find((value) => value.number === target[2])
          if (target && verse) {
            navigating.current = true
            try {
              useBibleStore
                .getState()
                .navigateTo({ bookNumber: target[0], chapter: target[1], verse: target[2] })
            } finally {
              navigating.current = false
            }
          }
          const deadline = performance.now() + 2000
          let scrollCorrected = false
          const record = (): void => {
            if (!current()) return
            const element =
              target && verse
                ? document.querySelector<HTMLElement>(
                    `[data-bible-passage="${target.join(':')}"] [data-verse-number="${target[2]}"]`
                  )
                : null
            const rect = element?.getBoundingClientRect()
            const container = element?.closest<HTMLElement>('[data-bible-passage]')
            const parent = container?.getBoundingClientRect()
            const visible =
              !!rect &&
              !!parent &&
              rect.height > 0 &&
              rect.top >= parent.top &&
              rect.bottom <= parent.bottom
            if (target && verse && !visible && performance.now() < deadline) {
              if (container && rect && parent && !scrollCorrected) {
                // Correct a missed asynchronous preview scroll; leave one pixel for scroll rounding.
                container.scrollTo({
                  top: Math.max(0, container.scrollTop + rect.top - parent.top - 1),
                  behavior: 'instant'
                })
                scrollCorrected = true
              }
              requestAnimationFrame(record)
              return
            }
            const paintedAt = performance.now()
            const trace: Trace = {
              ...completion,
              paintedAt,
              scrollCorrected,
              totalMs: paintedAt - completion.lastSampleAt,
              outcome: target && verse ? (visible ? 'located' : 'not-visible') : 'rejected'
            }
            setTraces((previous) => [trace, ...previous].slice(0, 100))
            if (completion.manual) stop()
          }
          requestAnimationFrame(() => requestAnimationFrame(record))
        },
        fail
      )
      const node = new AudioWorkletNode(context, 'chinese-pcm-capture')
      session.node = node
      node.port.onmessage = (
        event: MessageEvent<{ pcm: ArrayBuffer; frame: number } | { finished: true }>
      ) => {
        if (!current()) return
        if ('finished' in event.data) {
          session.stream?.getTracks().forEach((track) => track.stop())
          node.disconnect()
          session.controller?.finish()
          return
        }
        const stamp = context.getOutputTimestamp()
        const firstAt =
          stamp.performanceTime && stamp.contextTime
            ? stamp.performanceTime + (event.data.frame / 16000 - stamp.contextTime) * 1000
            : performance.now() - (context.currentTime - event.data.frame / 16000) * 1000
        session.controller?.push(new Float32Array(event.data.pcm), firstAt)
      }
      node.onprocessorerror = () => fail(new Error('capture-failed'))
      context.createMediaStreamSource(stream).connect(node)
      node.connect(context.destination)
      await context.resume()
      if (current()) setStatus('listening')
    } catch (reason) {
      fail(reason instanceof Error ? reason : new Error('start-failed'))
    }
  }

  return (
    <section className="flex h-full flex-col gap-3 p-3" aria-label="中文本機語音實測">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onPress={() => {
            void start()
          }}
          isDisabled={status !== 'idle' || !version}
        >
          {status === 'preparing' ? '正在準備…' : '開始中文聆聽'}
        </Button>
        <Button
          variant="secondary"
          isDisabled={status !== 'listening'}
          onPress={() => {
            sessionFinish()
          }}
        >
          完成一句
        </Button>
        <Button variant="danger" isDisabled={status === 'idle'} onPress={stop}>
          停止
        </Button>
      </div>
      <p role="status" data-speech-status={status} className="text-sm text-muted">
        {status === 'listening'
          ? '正在聆聽。說完稍停，或按「完成一句」。'
          : '中文本機流程實測；只定位預覽，不自動投影。'}
      </p>
      <p className="text-xs text-muted">
        有持續背景聲時請按「完成一句」。真人環境的自動分句仍待驗證。
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="min-h-0 overflow-auto">
        {traces.map((trace) => (
          <div
            key={trace.paintedAt}
            data-speech-trace={JSON.stringify(trace)}
            className="border-b py-2 text-sm"
          >
            <p>
              {trace.outcome === 'located'
                ? `已定位 ${trace.result.reference?.join(':')}`
                : trace.outcome === 'rejected'
                  ? '未找到可安全定位的經文'
                  : '預覽尚未顯示完整經文'}
            </p>
            <p className="text-muted">
              {(trace.totalMs / 1000).toFixed(2)} 秒 · {trace.manual ? '手動結束' : '自動分句'}
            </p>
          </div>
        ))}
      </div>
    </section>
  )

  function sessionFinish(): void {
    const session = active.current
    if (!session) return
    setStatus('finishing')
    session.node?.port.postMessage('finish')
  }
}
