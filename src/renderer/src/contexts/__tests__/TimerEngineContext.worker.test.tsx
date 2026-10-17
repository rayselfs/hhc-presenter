import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TimerEngineProvider } from '../TimerEngineContext'
import { useTimerStore, DEFAULT_SETTINGS, DEFAULT_STATE } from '@renderer/stores/timer'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  createTimerWorkerHost,
  type WorkerOutgoingMessage,
  type WorkerIncomingMessage
} from '@renderer/workers/timer-worker-host'

// Transport and clock are controlled; adapter, host and runtime are production code.
class InProcessWorker {
  static instances: InProcessWorker[] = []
  private listeners = new Map<string, Set<(event: MessageEvent<WorkerOutgoingMessage>) => void>>()
  private host: ReturnType<typeof createTimerWorkerHost>
  constructor() {
    InProcessWorker.instances.push(this)
    this.host = createTimerWorkerHost(
      (data) => {
        for (const listener of this.listeners.get('message') ?? [])
          listener(new MessageEvent('message', { data }))
      },
      () => Date.now()
    )
  }
  addEventListener(
    type: string,
    listener: (event: MessageEvent<WorkerOutgoingMessage>) => void
  ): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(
    type: string,
    listener: (event: MessageEvent<WorkerOutgoingMessage>) => void
  ): void {
    this.listeners.get(type)?.delete(listener)
  }
  postMessage(data: WorkerIncomingMessage): void {
    this.host.handleMessage(data)
  }
  terminate = vi.fn(() => {
    this.host.dispose()
    this.listeners.clear()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  InProcessWorker.instances = []
  vi.stubGlobal('Worker', InProcessWorker)
  vi.stubGlobal('api', undefined)
  useSettingsStore.setState({ reminderMode: 'subtract' })
  useTimerStore.setState({
    ...DEFAULT_SETTINGS,
    ...DEFAULT_STATE,
    totalDuration: 10,
    remainingSeconds: 10,
    hostRevision: -1
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function start(): Promise<void> {
  render(
    <TimerEngineProvider>
      <span />
    </TimerEngineProvider>
  )
  await act(async () => {
    expect((await useTimerStore.getState().start()).status).toBe('accepted')
  })
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

it('continues an extended countdown beyond the original Worker deadline', async () => {
  await start()
  await advance(5000)
  await act(async () => {
    await useTimerStore.getState().addTime(30)
  })
  await advance(10000)
  expect(useTimerStore.getState()).toMatchObject({ status: 'running', remainingSeconds: 25 })
  await advance(25000)
  expect(useTimerStore.getState()).toMatchObject({
    status: 'stopped',
    phase: 'overtime',
    remainingSeconds: 0
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('finishes an additive reminder at the host deadline', async () => {
  useSettingsStore.setState({ reminderMode: 'add' })
  useTimerStore.setState({ reminderEnabled: true, reminderDuration: 5 })
  await start()
  await advance(12000)
  expect(useTimerStore.getState()).toMatchObject({
    status: 'running',
    remainingSeconds: 3,
    phase: 'warning'
  })
  await advance(3000)
  expect(useTimerStore.getState()).toMatchObject({
    status: 'stopped',
    phase: 'overtime',
    remainingSeconds: 0
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('can pause, adjust and resume after the original deadline, then reset', async () => {
  await start()
  await act(async () => {
    await useTimerStore.getState().addTime(30)
  })
  await advance(12000)
  await act(async () => {
    await useTimerStore.getState().pause()
  })
  const remaining = useTimerStore.getState().remainingSeconds
  await advance(5000)
  expect(useTimerStore.getState().remainingSeconds).toBe(remaining)
  await act(async () => {
    await useTimerStore.getState().removeTime(3)
    await useTimerStore.getState().resume()
  })
  await advance(2000)
  expect(useTimerStore.getState().remainingSeconds).toBe(23)
  await act(async () => {
    await useTimerStore.getState().reset()
  })
  expect(vi.getTimerCount()).toBe(0)
  await advance(20000)
  expect(useTimerStore.getState()).toMatchObject({ status: 'stopped', remainingSeconds: 10 })
})

it('keeps only the current production host under StrictMode and disposes its interval on unmount', async () => {
  const mounted = render(
    <StrictMode>
      <TimerEngineProvider>
        <span />
      </TimerEngineProvider>
    </StrictMode>
  )
  await act(async () => {
    await useTimerStore.getState().start()
  })
  expect(InProcessWorker.instances).toHaveLength(2)
  expect(InProcessWorker.instances[0].terminate).toHaveBeenCalledOnce()
  expect(InProcessWorker.instances[1].terminate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  await advance(5000)
  expect(useTimerStore.getState().remainingSeconds).toBe(5)
  mounted.unmount()
  expect(InProcessWorker.instances[1].terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
