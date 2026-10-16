import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TimerEngineProvider } from '../TimerEngineContext'
import { useTimerStore, DEFAULT_SETTINGS, DEFAULT_STATE } from '@renderer/stores/timer'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  getState,
  resetPostMessageFn,
  resetStateForTesting,
  setPostMessageFn,
  type WorkerIncomingMessage,
  type WorkerOutgoingMessage
} from '@renderer/workers/timer.worker'

// Only transport is substituted; the adapter, Worker engine and runtime are real.
class InProcessWorker {
  private listener?: (event: MessageEvent<WorkerOutgoingMessage>) => void
  constructor() {
    setPostMessageFn((data) => this.listener?.(new MessageEvent('message', { data })))
  }
  addEventListener(_event: string, listener: typeof this.listener): void {
    this.listener = listener
  }
  postMessage(data: WorkerIncomingMessage): void {
    self.onmessage?.call(self, new MessageEvent('message', { data }))
  }
  terminate(): void {
    resetStateForTesting()
    this.listener = undefined
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubGlobal('Worker', InProcessWorker)
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  resetStateForTesting()
  useSettingsStore.setState({ reminderMode: 'subtract' })
  useTimerStore.setState({ ...DEFAULT_SETTINGS, ...DEFAULT_STATE, targetEndTime: null })
  useTimerStore.getState().setDuration(10)
})

afterEach(() => {
  cleanup()
  resetStateForTesting()
  resetPostMessageFn()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function start(): void {
  render(
    <TimerEngineProvider>
      <span />
    </TimerEngineProvider>
  )
  act(() => useTimerStore.getState().start())
}

function advance(ms: number): void {
  act(() => vi.advanceTimersByTime(ms))
}

it('continues an extended countdown beyond the original Worker deadline', () => {
  start()
  advance(5_000)
  act(() => useTimerStore.getState().addTime(30))
  advance(10_000)
  expect(useTimerStore.getState()).toMatchObject({ status: 'running', remainingSeconds: 25 })
  advance(25_000)
  expect(useTimerStore.getState()).toMatchObject({
    status: 'stopped',
    phase: 'overtime',
    remainingSeconds: 0
  })
  expect(getState().intervalId).toBeNull()
})

it('finishes an additive reminder at the runtime deadline', () => {
  useSettingsStore.setState({ reminderMode: 'add' })
  useTimerStore.getState().setReminder(true, 5)
  start()
  advance(12_000)
  expect(useTimerStore.getState()).toMatchObject({
    status: 'running',
    remainingSeconds: 3,
    phase: 'warning'
  })
  advance(3_000)
  expect(useTimerStore.getState()).toMatchObject({
    status: 'stopped',
    phase: 'overtime',
    remainingSeconds: 0
  })
  expect(getState().intervalId).toBeNull()
})

it('can pause, adjust and resume after the original deadline, then reset', () => {
  start()
  act(() => useTimerStore.getState().addTime(30))
  advance(12_000)
  act(() => useTimerStore.getState().pause())
  const remaining = useTimerStore.getState().remainingSeconds
  advance(5_000)
  expect(useTimerStore.getState().remainingSeconds).toBe(remaining)
  act(() => useTimerStore.getState().removeTime(3))
  act(() => useTimerStore.getState().resume())
  advance(2_000)
  expect(useTimerStore.getState().remainingSeconds).toBe(23)
  act(() => useTimerStore.getState().reset())
  expect(getState().intervalId).toBeNull()
  advance(20_000)
  expect(useTimerStore.getState()).toMatchObject({ status: 'stopped', remainingSeconds: 10 })
})
