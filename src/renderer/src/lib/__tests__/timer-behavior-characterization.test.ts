import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TimerService } from '../../../../main/timerService'
import { DEFAULT_SETTINGS, DEFAULT_STATE, useTimerStore } from '@renderer/stores/timer'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { useSettingsStore } from '@renderer/stores/settings'
import { installTimerRuntimeHarness } from '@renderer/test/timer-runtime-harness'

let legacy: TimerService
let operator: ReturnType<typeof installTimerRuntimeHarness>
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  useSettingsStore.setState({ reminderMode: 'subtract' })
  useTimerStore.setState({ ...DEFAULT_SETTINGS, ...DEFAULT_STATE, hostRevision: -1 })
  useStopwatchStore.setState({ status: 'stopped', elapsedMs: 0 })
  operator = installTimerRuntimeHarness()
  legacy = new TimerService()
})
afterEach(() => {
  operator.dispose()
  legacy.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function duration(seconds: number): void {
  useTimerStore.getState().setDuration(seconds)
  legacy.handleCommand({ type: 'setDuration', seconds })
}
function start(): void {
  useTimerStore.getState().start()
  legacy.handleCommand({ type: 'start' })
}
function advance(ms: number): void {
  vi.advanceTimersByTime(ms)
  operator.tickAt(Date.now())
}

it('stops the operator at zero while the legacy ingress continues overtime', () => {
  duration(1)
  start()
  advance(2500)
  expect(useTimerStore.getState()).toMatchObject({
    status: 'stopped',
    phase: 'overtime',
    remainingSeconds: 0,
    overtimeSeconds: 0
  })
  expect(legacy.getState()).toMatchObject({
    status: 'running',
    phase: 'overtime',
    remainingSeconds: 0,
    overtimeSeconds: 1
  })
})

it('keeps operator stopped adjustments as configuration while legacy start uses its configured duration', () => {
  duration(60)
  useTimerStore.getState().addTime(30)
  legacy.handleCommand({ type: 'addTime', seconds: 30 })
  expect(useTimerStore.getState()).toMatchObject({ totalDuration: 90, remainingSeconds: 90 })
  expect(legacy.getState().remainingSeconds).toBe(90)
  start()
  expect(useTimerStore.getState().remainingSeconds).toBe(90)
  expect(legacy.getState().remainingSeconds).toBe(60)
})

it('retains rounded paused adjustments through resume and resets to the configured duration', () => {
  duration(60)
  start()
  advance(1500)
  useTimerStore.getState().pause()
  legacy.handleCommand({ type: 'pause' })
  useTimerStore.getState().addTime(10)
  legacy.handleCommand({ type: 'addTime', seconds: 10 })
  advance(15000)
  expect(useTimerStore.getState().remainingSeconds).toBe(69)
  expect(legacy.getState().remainingSeconds).toBe(69)
  useTimerStore.getState().resume()
  legacy.handleCommand({ type: 'resume' })
  advance(2100)
  expect(useTimerStore.getState().remainingSeconds).toBe(67)
  expect(legacy.getState().remainingSeconds).toBe(67)
  useTimerStore.getState().reset()
  legacy.handleCommand({ type: 'reset' })
  expect(useTimerStore.getState().remainingSeconds).toBe(60)
  expect(legacy.getState().remainingSeconds).toBe(60)
})

it('keeps an added reminder deadline when its mode changes during a run', () => {
  duration(60)
  useSettingsStore.getState().setReminderMode('add')
  useTimerStore.getState().setReminder(true, 30)
  legacy.handleCommand({ type: 'setReminder', enabled: true, durationSeconds: 30 })
  start()
  expect(useTimerStore.getState().remainingSeconds).toBe(90)
  expect(legacy.getState().remainingSeconds).toBe(60)
  advance(1100)
  useSettingsStore.getState().setReminderMode('subtract')
  advance(1000)
  expect(useTimerStore.getState().remainingSeconds).toBe(88)
  expect(legacy.getState().remainingSeconds).toBe(58)
  useTimerStore.getState().reset()
  expect(useTimerStore.getState().remainingSeconds).toBe(60)
})

it('distinguishes operator stopwatch restart from legacy stopwatch resume', () => {
  useStopwatchStore.getState().start()
  legacy.handleCommand({ type: 'startStopwatch' })
  advance(1300)
  useStopwatchStore.getState().pause()
  legacy.handleCommand({ type: 'pauseStopwatch' })
  advance(2000)
  useStopwatchStore.getState().start()
  legacy.handleCommand({ type: 'startStopwatch' })
  expect(useStopwatchStore.getState().elapsedMs).toBe(0)
  expect(legacy.getState().stopwatch.elapsedMs).toBe(1300)
})

it('resets an active operator countdown when selecting clock mode', () => {
  duration(60)
  start()
  useTimerStore.getState().setMode('clock')
  legacy.handleCommand({ type: 'setMode', mode: 'clock' })
  expect(useTimerStore.getState().status).toBe('stopped')
  expect(legacy.getState().status).toBe('running')
})
