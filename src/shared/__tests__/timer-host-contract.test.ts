import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimerService } from '../../main/timerService'
import { createTimerWorkerHost } from '../../renderer/src/workers/timer-worker-host'
import type {
  TimerRuntimeConfiguration,
  TimerRuntimeResult,
  TimerRuntimeSnapshot
} from '../types/timer'

const configuration: TimerRuntimeConfiguration = {
  settings: {
    mode: 'timer',
    totalDuration: 60,
    reminderEnabled: false,
    reminderDuration: 10,
    reminderColor: '#ff0000',
    overtimeMessageEnabled: false,
    overtimeMessage: ''
  },
  reminderMode: 'subtract'
}

for (const platform of ['main', 'worker'] as const) {
  describe(`${platform} authoritative timer host contract`, () => {
    let now: number
    let latest: TimerRuntimeSnapshot
    let initialize: (value: unknown) => TimerRuntimeResult
    let command: (value: unknown) => TimerRuntimeResult
    let dispose: () => void
    beforeEach(() => {
      vi.useFakeTimers()
      now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      if (platform === 'main') {
        const service = new TimerService()
        service.setWindowManager({
          getMainWindow: () => ({
            isDestroyed: () => false,
            webContents: {
              isDestroyed: () => false,
              send: (_channel, payload) => {
                if (payload.runtime) latest = payload.runtime
              }
            }
          }),
          getProjectionWindow: () => null
        })
        initialize = (value) => service.initializeRuntime(value)
        command = (value) => service.executeRuntimeCommand(value)
        dispose = () => service.dispose()
      } else {
        let result: TimerRuntimeResult | undefined
        let requestId = 0
        const worker = createTimerWorkerHost(
          (message) => {
            if (message.type === 'snapshot') latest = message.snapshot
            else {
              result = message.result
              if (result.status === 'accepted') latest = result.snapshot
            }
          },
          () => now
        )
        const request = (message: Record<string, unknown>): TimerRuntimeResult => {
          result = undefined
          worker.handleMessage({ ...message, requestId: ++requestId })
          if (!result) throw new Error('Worker did not respond to its request')
          return result
        }
        initialize = (value) => request({ type: 'initialize', configuration: value })
        command = (value) => request({ type: 'command', command: value })
        dispose = () => worker.dispose()
      }
      initialize(configuration)
    })
    afterEach(() => {
      dispose()
      vi.restoreAllMocks()
      vi.useRealTimers()
    })
    function advance(ms: number): void {
      now += ms
      vi.advanceTimersByTime(ms)
    }
    it('preserves rounded pause adjustments through resume and reset', () => {
      command({ type: 'start' })
      advance(1500)
      command({ type: 'pause' })
      command({ type: 'addTime', seconds: 10 })
      advance(15_000)
      expect(latest.timer).toMatchObject({ status: 'paused', remainingSeconds: 69 })
      command({ type: 'resume' })
      advance(2100)
      expect(latest.timer.remainingSeconds).toBe(67)
      command({ type: 'reset' })
      expect(latest.timer).toMatchObject({ status: 'stopped', remainingSeconds: 60, phase: 'idle' })
    })
    it('keeps stopped adjustment as configuration and running adjustment as runtime', () => {
      command({ type: 'removeTime', seconds: 10 })
      expect(latest.configuration.settings.totalDuration).toBe(50)
      command({ type: 'start' })
      command({ type: 'addTime', seconds: 10 })
      expect(latest.timer.remainingSeconds).toBe(60)
      expect(latest.configuration.settings.totalDuration).toBe(50)
      command({ type: 'setDuration', seconds: 999 })
      expect(latest.configuration.settings.totalDuration).toBe(50)
    })
    it('preserves an added reminder deadline when reminder mode changes', () => {
      command({ type: 'setReminder', enabled: true, durationSeconds: 30 })
      command({ type: 'setReminderMode', mode: 'add' })
      command({ type: 'start' })
      expect(latest.timer.remainingSeconds).toBe(90)
      advance(1100)
      command({ type: 'setReminderMode', mode: 'subtract' })
      advance(1000)
      expect(latest.timer.remainingSeconds).toBe(88)
      command({ type: 'reset' })
      expect(latest.timer.remainingSeconds).toBe(60)
    })
    it('publishes zero, ends scheduling and restarts the configured duration', () => {
      command({ type: 'setDuration', seconds: 1 })
      command({ type: 'start' })
      advance(2500)
      expect(latest.timer).toMatchObject({
        status: 'stopped',
        phase: 'overtime',
        remainingSeconds: 0,
        overtimeSeconds: 0
      })
      expect(vi.getTimerCount()).toBe(0)
      command({ type: 'start' })
      expect(latest.timer).toMatchObject({ status: 'running', remainingSeconds: 1 })
    })
    it('uses the current host clock after a background-delayed heartbeat', () => {
      command({ type: 'start' })
      now = 75_000
      vi.advanceTimersByTime(1000)
      expect(latest.timer).toMatchObject({ status: 'stopped', remainingSeconds: 0 })
    })
    it('keeps stopwatch pause, resume and restart semantics', () => {
      command({ type: 'startStopwatch' })
      advance(1300)
      command({ type: 'pauseStopwatch' })
      advance(5000)
      expect(latest.stopwatch).toMatchObject({ status: 'paused', elapsedMs: 1300 })
      command({ type: 'resumeStopwatch' })
      advance(200)
      expect(latest.stopwatch.elapsedMs).toBe(1500)
      command({ type: 'pauseStopwatch' })
      command({ type: 'startStopwatch' })
      expect(latest.stopwatch.elapsedMs).toBe(0)
      command({ type: 'resetStopwatch' })
      expect(latest.stopwatch).toMatchObject({ status: 'stopped', elapsedMs: 0 })
    })
    it('returns the live accepted configuration on repeated initialization', () => {
      command({ type: 'start' })
      advance(2500)
      expect(
        initialize({
          ...configuration,
          settings: { ...configuration.settings, totalDuration: 900 }
        })
      ).toMatchObject({
        status: 'accepted',
        snapshot: {
          configuration: { settings: { totalDuration: 60 } },
          timer: { status: 'running', remainingSeconds: 58 }
        }
      })
    })
    it.each([NaN, Infinity, -1])(
      'rejects invalid timer seconds %s at the host boundary',
      (seconds) => {
        expect(command({ type: 'setDuration', seconds })).toEqual({
          status: 'rejected',
          reason: 'invalid-command'
        })
        expect(
          initialize({
            ...configuration,
            settings: { ...configuration.settings, totalDuration: seconds }
          })
        ).toEqual({ status: 'rejected', reason: 'invalid-configuration' })
        expect(latest.timer.remainingSeconds).toBe(60)
      }
    )
  })
}
