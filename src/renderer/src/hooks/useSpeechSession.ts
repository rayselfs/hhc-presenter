import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  SpeechAdapter,
  SpeechAdapterEventMap
} from '@renderer/lib/speech-adapter/speech-adapter.interface'
import { useBibleSpeechStore } from '@renderer/stores/bible-speech'

interface SpeechSessionOptions {
  createAdapter: () => Promise<SpeechAdapter | null>
  requiresOnline: boolean
  maxSessionMs: number
  onRecognized: (text: string) => void
  onRawRecognized: (result: SpeechAdapterEventMap['rawRecognized']) => void
}

interface Session {
  adapter: SpeechAdapter | null
  requiresOnline: boolean
  elapsed: ReturnType<typeof setInterval> | null
  deadline: ReturnType<typeof setTimeout> | null
}

export function useSpeechSession(options: SpeechSessionOptions): {
  isStarting: boolean
  isRecognizing: boolean
  isOnline: boolean
  error: string | null
  setError: (error: string | null) => void
  start: () => Promise<void>
  stop: () => void
} {
  const [status, setStatus] = useState<'idle' | 'starting' | 'active'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])
  const current = useRef<Session | null>(null)
  const mounted = useRef(true)

  const stop = useCallback((): void => {
    const session = current.current
    current.current = null
    if (session?.elapsed) clearInterval(session.elapsed)
    if (session?.deadline) clearTimeout(session.deadline)
    if (session?.adapter) {
      void session.adapter.stop().catch(() => {})
      session.adapter.dispose()
    }
    if (mounted.current) setStatus('idle')
  }, [])

  useEffect(() => {
    mounted.current = true
    const online = (): void => setIsOnline(true)
    const offline = (): void => {
      setIsOnline(false)
      if (current.current?.requiresOnline) {
        stop()
        setError('network-offline')
      }
    }
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      mounted.current = false
      stop()
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [stop])

  const start = useCallback(async (): Promise<void> => {
    if (!mounted.current || current.current) return
    const config = optionsRef.current
    if (config.requiresOnline && !navigator.onLine) {
      setError('network-offline')
      return
    }
    const session: Session = {
      adapter: null,
      requiresOnline: config.requiresOnline,
      elapsed: null,
      deadline: null
    }
    current.current = session
    const isCurrent = (): boolean => mounted.current && current.current === session
    setStatus('starting')
    setError(null)
    let adapter: SpeechAdapter | null = null
    try {
      adapter = await config.createAdapter()
      if (!isCurrent()) {
        adapter?.dispose()
        return
      }
      if (!adapter) {
        stop()
        setError('config-required')
        return
      }
      session.adapter = adapter
      const finish = (message: string | null): void => {
        if (!isCurrent()) return
        stop()
        setError(message)
      }
      adapter.on('recognized', (result) => {
        if (isCurrent() && result.text) optionsRef.current.onRecognized(result.text)
      })
      adapter.on('rawRecognized', (result) => {
        if (isCurrent()) optionsRef.current.onRawRecognized(result)
      })
      adapter.on('error', () => finish('start-failed'))
      adapter.on('sessionStopped', () => finish(null))
      adapter.on('canceled', () => finish('start-failed'))
      adapter.on('idleTimeout', () => finish('idle-timeout'))
      adapter.on('maxDurationReached', () => finish('max-duration'))
      await adapter.start()
      if (!isCurrent()) {
        adapter.dispose()
        return
      }
      session.elapsed = setInterval(() => {
        if (isCurrent()) useBibleSpeechStore.getState().incrementElapsedSeconds()
      }, 1000)
      session.deadline = setTimeout(() => finish('max-duration'), config.maxSessionMs)
      setStatus('active')
    } catch {
      if (isCurrent()) {
        stop()
        setError('start-failed')
      } else {
        adapter?.dispose()
      }
    }
  }, [stop])

  return {
    isStarting: status === 'starting',
    isRecognizing: status === 'active',
    isOnline,
    error,
    setError,
    start,
    stop
  }
}
