import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimerRuntime } from '@shared/timer-runtime'
import type {
  TimerRuntimeCommand,
  TimerRuntimeConfiguration,
  TimerRuntimeSnapshot
} from '@shared/types/timer'
import { TimerEngineProvider, useTimerEngine } from '../TimerEngineContext'
import { DEFAULT_SETTINGS, DEFAULT_STATE, useTimerStore } from '@renderer/stores/timer'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { useSettingsStore } from '@renderer/stores/settings'
import * as timerAdapterModule from '@renderer/lib/timer-adapter'

vi.mock('@renderer/lib/timer-adapter')

function createHost() {
  const runtime = new TimerRuntime(() => 0)
  let listener: ((snapshot: TimerRuntimeSnapshot) => void) | undefined
  const publish = (snapshot = runtime.getSnapshot()): void => {
    listener?.(snapshot)
  }
  const unsubscribe = vi.fn()
  const adapter = {
    initialize: vi.fn(async (configuration: TimerRuntimeConfiguration) => {
      const result = runtime.initialize(configuration)
      if (result.status === 'accepted') publish(result.snapshot)
      return result
    }),
    execute: vi.fn(async (command: TimerRuntimeCommand) => {
      const result = runtime.execute(command)
      if (result.status === 'accepted') publish(result.snapshot)
      return result
    }),
    onSnapshot: vi.fn((callback: (snapshot: TimerRuntimeSnapshot) => void) => {
      listener = callback
      return unsubscribe
    }),
    dispose: vi.fn()
  }
  return { runtime, adapter, publish, unsubscribe }
}
let hosts: ReturnType<typeof createHost>[]
beforeEach(() => {
  vi.clearAllMocks()
  hosts = []
  vi.mocked(timerAdapterModule.createTimerAdapter).mockImplementation(() => {
    const host = createHost()
    hosts.push(host)
    return host.adapter
  })
  useTimerStore.setState({ ...DEFAULT_SETTINGS, ...DEFAULT_STATE, hostRevision: -1, presets: [] })
  useStopwatchStore.setState({ status: 'stopped', elapsedMs: 0 })
  useSettingsStore.setState({ reminderMode: 'subtract' })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function TestChild(): React.JSX.Element {
  const adapter = useTimerEngine()
  return <div data-testid="child">{adapter ? 'has-adapter' : 'no-adapter'}</div>
}
function mount() {
  return render(
    <TimerEngineProvider>
      <TestChild />
    </TimerEngineProvider>
  )
}

describe('TimerEngineContext', () => {
  it('creates and exposes the effect-owned adapter on mount', () => {
    mount()
    expect(timerAdapterModule.createTimerAdapter).toHaveBeenCalledOnce()
    expect(screen.getByTestId('child')).toHaveTextContent('has-adapter')
  })
  it('unsubscribes and disposes its adapter on unmount', () => {
    const mounted = mount()
    expect(hosts[0].adapter.dispose).not.toHaveBeenCalled()
    mounted.unmount()
    expect(hosts[0].unsubscribe).toHaveBeenCalledOnce()
    expect(hosts[0].adapter.dispose).toHaveBeenCalledOnce()
  })
  it('creates separate disposable resources during StrictMode replay', async () => {
    const mounted = render(
      <StrictMode>
        <TimerEngineProvider>
          <TestChild />
        </TimerEngineProvider>
      </StrictMode>
    )
    expect(hosts).toHaveLength(2)
    expect(hosts[0].adapter.dispose).toHaveBeenCalledOnce()
    expect(hosts[1].adapter.dispose).not.toHaveBeenCalled()
    await act(async () => {
      await useTimerStore.getState().start()
    })
    expect(hosts[0].adapter.execute).not.toHaveBeenCalled()
    expect(hosts[1].adapter.execute).toHaveBeenCalledExactlyOnceWith({ type: 'start' })
    mounted.unmount()
    expect(hosts[1].adapter.dispose).toHaveBeenCalledOnce()
  })
  it('subscribes once to complete authoritative frames', () => {
    mount()
    expect(hosts[0].adapter.onSnapshot).toHaveBeenCalledOnce()
  })
  it('initializes with persisted configuration and no renderer commands', () => {
    useTimerStore.setState({ mode: 'both', totalDuration: 600 })
    useSettingsStore.setState({ reminderMode: 'add' })
    mount()
    expect(hosts[0].adapter.initialize).toHaveBeenCalledWith({
      settings: { ...DEFAULT_SETTINGS, mode: 'both', totalDuration: 600 },
      reminderMode: 'add'
    })
    expect(hosts[0].adapter.execute).not.toHaveBeenCalled()
  })
  const relays: Array<[string, () => Promise<unknown>, TimerRuntimeCommand]> = [
    ['timer start', () => useTimerStore.getState().start(), { type: 'start' }],
    ['timer pause', () => useTimerStore.getState().pause(), { type: 'pause' }],
    ['timer resume', () => useTimerStore.getState().resume(), { type: 'resume' }],
    ['timer reset', () => useTimerStore.getState().reset(), { type: 'reset' }],
    [
      'timer duration',
      () => useTimerStore.getState().setDuration(600),
      { type: 'setDuration', seconds: 600 }
    ],
    [
      'timer mode',
      () => useTimerStore.getState().setMode('stopwatch'),
      { type: 'setMode', mode: 'stopwatch' }
    ],
    ['stopwatch start', () => useStopwatchStore.getState().start(), { type: 'startStopwatch' }],
    ['stopwatch pause', () => useStopwatchStore.getState().pause(), { type: 'pauseStopwatch' }],
    ['stopwatch resume', () => useStopwatchStore.getState().resume(), { type: 'resumeStopwatch' }],
    ['stopwatch reset', () => useStopwatchStore.getState().reset(), { type: 'resetStopwatch' }]
  ]
  it.each(relays)('relays exactly one explicit %s command', async (_name, action, command) => {
    mount()
    await act(async () => {
      await action()
    })
    expect(hosts[0].adapter.execute).toHaveBeenCalledExactlyOnceWith(command)
  })
  it.each(['running', 'paused'] as const)('resets the countdown from %s', async (status) => {
    mount()
    await act(async () => {
      await useTimerStore.getState().start()
      if (status === 'paused') await useTimerStore.getState().pause()
      hosts[0].adapter.execute.mockClear()
      await useTimerStore.getState().reset()
    })
    expect(hosts[0].adapter.execute).toHaveBeenCalledExactlyOnceWith({ type: 'reset' })
    expect(useTimerStore.getState().status).toBe('stopped')
  })
  it.each(['running', 'paused'] as const)('resets the stopwatch from %s', async (status) => {
    mount()
    await act(async () => {
      await useStopwatchStore.getState().start()
      if (status === 'paused') await useStopwatchStore.getState().pause()
      hosts[0].adapter.execute.mockClear()
      await useStopwatchStore.getState().reset()
    })
    expect(hosts[0].adapter.execute).toHaveBeenCalledExactlyOnceWith({ type: 'resetStopwatch' })
    expect(useStopwatchStore.getState().status).toBe('stopped')
  })
  it('updates timer and stopwatch from a host frame without command echo', () => {
    mount()
    const host = hosts[0]
    host.runtime.execute({ type: 'setDuration', seconds: 75 })
    host.runtime.execute({ type: 'startStopwatch' })
    act(() => host.publish())
    expect(useTimerStore.getState().remainingSeconds).toBe(75)
    expect(useStopwatchStore.getState().status).toBe('running')
    expect(host.adapter.execute).not.toHaveBeenCalled()
  })
  it('ignores callbacks retained by a disposed adapter after remount', () => {
    const first = mount()
    first.unmount()
    mount()
    hosts[0].runtime.execute({ type: 'setDuration', seconds: 1 })
    act(() => hosts[0].publish())
    expect(useTimerStore.getState().remainingSeconds).toBe(300)
  })
  it('does not change state optimistically when the host rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mount()
    hosts[0].adapter.execute.mockResolvedValue({ status: 'rejected', reason: 'host-unavailable' })
    await act(async () => {
      await expect(useTimerStore.getState().setDuration(75)).resolves.toEqual({
        status: 'rejected',
        reason: 'host-unavailable'
      })
    })
    expect(useTimerStore.getState().totalDuration).toBe(300)
    expect(useTimerStore.getState().remainingSeconds).toBe(300)
  })
  it('does not create a renderer interval when either timer starts', async () => {
    mount()
    const interval = vi.spyOn(globalThis, 'setInterval')
    await act(async () => {
      await useTimerStore.getState().start()
      await useStopwatchStore.getState().start()
    })
    expect(interval).not.toHaveBeenCalled()
  })
  it('returns null outside the provider', () => {
    const { result } = renderHook(() => useTimerEngine())
    expect(result.current).toBeNull()
  })
})
