import { StrictMode } from 'react'
import { WhisperSpeechAdapter } from '@renderer/lib/speech-adapter/providers/whisper-speech-adapter'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSpeechSession } from '../useSpeechSession'
import { useBibleSpeechStore } from '@renderer/stores/bible-speech'
import type {
  SpeechAdapter,
  SpeechAdapterEventType,
  SpeechAdapterEventMap,
  SpeechAdapterEventListener
} from '@renderer/lib/speech-adapter/speech-adapter.interface'

class Adapter implements SpeechAdapter {
  start = vi.fn(async (): Promise<void> => {})
  stop = vi.fn(async (): Promise<void> => {})
  dispose = vi.fn()
  isRecognizing = (): boolean => false
  listeners = new Map<SpeechAdapterEventType, Set<(data: unknown) => void>>()
  on<T extends SpeechAdapterEventType>(
    event: T,
    listener: SpeechAdapterEventListener<T>
  ): () => void {
    const receive = (data: unknown): void => listener(data as SpeechAdapterEventMap[T])
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(receive)
    this.listeners.set(event, listeners)
    return () => listeners.delete(receive)
  }
  emit<T extends SpeechAdapterEventType>(event: T, data: SpeechAdapterEventMap[T]): void {
    this.listeners.get(event)?.forEach((receive) => receive(data))
  }
}
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const recognized = {
  text: 'John 3:16',
  bookNumber: 43,
  chapter: 3,
  verse: 16,
  confidence: 'exact'
} as const
function options(adapter = new Adapter()): Parameters<typeof useSpeechSession>[0] {
  return {
    createAdapter: vi.fn(async () => adapter),
    requiresOnline: true,
    maxSessionMs: 60_000,
    onRecognized: vi.fn(),
    onRawRecognized: vi.fn()
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { onLine: true })
  useBibleSpeechStore.getState().resetElapsedSeconds()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('claims pending startup synchronously and prevents double creation', async () => {
  const pending = deferred<SpeechAdapter | null>()
  const config = { ...options(), createAdapter: vi.fn(() => pending.promise) }
  const hook = renderHook(() => useSpeechSession(config))
  let first!: Promise<void>
  act(() => {
    first = hook.result.current.start()
    void hook.result.current.start()
  })
  expect(config.createAdapter).toHaveBeenCalledOnce()
  expect(hook.result.current.isStarting).toBe(true)
  const adapter = new Adapter()
  await act(async () => {
    pending.resolve(adapter)
    await first
  })
  expect(adapter.start).toHaveBeenCalledOnce()
  expect(hook.result.current.isRecognizing).toBe(true)
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['stop', 'unmount'] as const)(
  'disposes a late factory result after %s without starting it',
  async (action) => {
    const pending = deferred<SpeechAdapter | null>()
    const hook = renderHook(() =>
      useSpeechSession({ ...options(), createAdapter: () => pending.promise })
    )
    let starting!: Promise<void>
    act(() => {
      starting = hook.result.current.start()
    })
    if (action === 'stop') act(() => hook.result.current.stop())
    else hook.unmount()
    const adapter = new Adapter()
    await act(async () => {
      pending.resolve(adapter)
      await starting
    })
    expect(adapter.start).not.toHaveBeenCalled()
    expect(adapter.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    if (action === 'stop') hook.unmount()
  }
)

it.each(['resolve', 'reject'] as const)(
  'cleans pending adapter startup after stop and late %s',
  async (completion) => {
    const adapter = new Adapter()
    const pending = deferred<void>()
    adapter.start.mockReturnValue(pending.promise)
    const config = options(adapter)
    const hook = renderHook(() => useSpeechSession(config))
    let starting!: Promise<void>
    await act(async () => {
      starting = hook.result.current.start()
      await Promise.resolve()
    })
    act(() => hook.result.current.stop())
    expect(adapter.dispose).toHaveBeenCalledOnce()
    await act(async () => {
      if (completion === 'resolve') pending.resolve()
      else pending.reject(new Error('Late failure'))
      await starting
    })
    act(() => adapter.emit('recognized', recognized))
    expect(config.onRecognized).not.toHaveBeenCalled()
    expect(adapter.dispose).toHaveBeenCalledTimes(2)
    expect(hook.result.current).toMatchObject({
      isStarting: false,
      isRecognizing: false,
      error: null
    })
    expect(vi.getTimerCount()).toBe(0)
    hook.unmount()
  }
)

it('does not let an old startup failure stop or overwrite a new session', async () => {
  const old = new Adapter()
  const pending = deferred<void>()
  old.start.mockReturnValue(pending.promise)
  const next = new Adapter()
  const factory = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next)
  const hook = renderHook(() => useSpeechSession({ ...options(), createAdapter: factory }))
  let first!: Promise<void>
  await act(async () => {
    first = hook.result.current.start()
    await Promise.resolve()
  })
  act(() => hook.result.current.stop())
  await act(async () => {
    await hook.result.current.start()
  })
  await act(async () => {
    pending.reject(new Error('Old failure'))
    await first
  })
  act(() => old.emit('sessionStopped', undefined))
  expect(next.dispose).not.toHaveBeenCalled()
  expect(hook.result.current).toMatchObject({ isRecognizing: true, error: null })
  hook.unmount()
})

it.each(['sessionStopped', 'canceled', 'idleTimeout', 'maxDurationReached', 'error'] as const)(
  'releases session resources on %s',
  async (event) => {
    const adapter = new Adapter()
    const hook = renderHook(() => useSpeechSession(options(adapter)))
    await act(async () => {
      await hook.result.current.start()
    })
    act(() => {
      if (event === 'error') adapter.emit(event, { error: new Error('Failed'), message: 'Failed' })
      else if (event === 'canceled') adapter.emit(event, { reason: 'Canceled' })
      else adapter.emit(event, undefined)
    })
    expect(adapter.dispose).toHaveBeenCalledOnce()
    expect(hook.result.current.isRecognizing).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    hook.unmount()
  }
)

it.each([true, false])(
  'caps duration and stops elapsed increments (requiresOnline=%s)',
  async (requiresOnline) => {
    const adapter = new Adapter()
    const hook = renderHook(() =>
      useSpeechSession({ ...options(adapter), requiresOnline, maxSessionMs: 2500 })
    )
    await act(async () => {
      await hook.result.current.start()
    })
    act(() => vi.advanceTimersByTime(2500))
    expect(useBibleSpeechStore.getState().elapsedSeconds).toBe(2)
    expect(hook.result.current.error).toBe('max-duration')
    expect(adapter.dispose).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(10_000))
    expect(useBibleSpeechStore.getState().elapsedSeconds).toBe(2)
    hook.unmount()
  }
)

it.each([true, false])(
  'handles offline by captured provider policy (requiresOnline=%s)',
  async (requiresOnline) => {
    const adapter = new Adapter()
    const hook = renderHook(() => useSpeechSession({ ...options(adapter), requiresOnline }))
    await act(async () => {
      await hook.result.current.start()
    })
    act(() => window.dispatchEvent(new Event('offline')))
    expect(hook.result.current.isOnline).toBe(false)
    expect(hook.result.current.isRecognizing).toBe(!requiresOnline)
    expect(adapter.dispose).toHaveBeenCalledTimes(requiresOnline ? 1 : 0)
    hook.unmount()
  }
)

it('reports configuration/factory/start failure and allows a fresh retry', async () => {
  const failed = new Adapter()
  failed.start.mockRejectedValue(new Error('Permission denied'))
  const ready = new Adapter()
  const factory = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('Key unavailable'))
    .mockResolvedValueOnce(failed)
    .mockResolvedValueOnce(ready)
  const hook = renderHook(() => useSpeechSession({ ...options(), createAdapter: factory }))
  await act(async () => {
    await hook.result.current.start()
  })
  expect(hook.result.current.error).toBe('config-required')
  await act(async () => {
    await hook.result.current.start()
  })
  expect(hook.result.current.error).toBe('start-failed')
  await act(async () => {
    await hook.result.current.start()
  })
  expect(hook.result.current.error).toBe('start-failed')
  expect(failed.dispose).toHaveBeenCalledOnce()
  await act(async () => {
    await hook.result.current.start()
  })
  expect(hook.result.current).toMatchObject({ isRecognizing: true, error: null })
  hook.unmount()
})

it('keeps Whisper duration failure visible when its provider timer fires before the owner deadline', async () => {
  const stopTrack = vi.fn()
  vi.stubGlobal('navigator', {
    onLine: false,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) }
  })
  vi.stubGlobal(
    'Worker',
    class {
      onmessage = null
      postMessage = vi.fn()
      terminate = vi.fn()
    }
  )
  vi.stubGlobal(
    'MediaRecorder',
    class {
      state = 'inactive'
      ondataavailable = null
      start(): void {
        this.state = 'recording'
      }
      stop(): void {
        this.state = 'inactive'
      }
    }
  )
  const adapter = new WhisperSpeechAdapter({ maxSessionMs: 1000 })
  const hook = renderHook(() =>
    useSpeechSession({
      ...options(),
      createAdapter: async () => adapter,
      requiresOnline: false,
      maxSessionMs: 2000
    })
  )
  await act(async () => {
    await hook.result.current.start()
  })
  act(() => vi.advanceTimersByTime(1000))
  expect(hook.result.current).toMatchObject({ isRecognizing: false, error: 'max-duration' })
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  hook.unmount()
})

it('retains only the active session resources across StrictMode effect replay', async () => {
  const adapter = new Adapter()
  const hook = renderHook(() => useSpeechSession(options(adapter)), { wrapper: StrictMode })
  await act(async () => {
    await hook.result.current.start()
  })
  expect(adapter.start).toHaveBeenCalledOnce()
  expect(adapter.dispose).not.toHaveBeenCalled()
  expect(hook.result.current.isRecognizing).toBe(true)
  hook.unmount()
  expect(adapter.dispose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
