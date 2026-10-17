import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TimerService } from '../timerService'
import type { TimerRuntimeConfiguration, TimerTickPayload } from '@shared/types/timer'

const configuration: TimerRuntimeConfiguration = {
  settings: {
    mode: 'timer',
    totalDuration: 1,
    reminderEnabled: false,
    reminderDuration: 0,
    reminderColor: '#ff0000',
    overtimeMessageEnabled: false,
    overtimeMessage: ''
  },
  reminderMode: 'subtract'
}
let service: TimerService
let now: number
let frames: TimerTickPayload[]
beforeEach(() => {
  vi.useFakeTimers()
  now = 0
  frames = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  service = new TimerService()
  service.setWindowManager({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (_channel, frame) => frames.push(frame) }
    }),
    getProjectionWindow: () => null
  })
})
afterEach(() => {
  service.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('rejects commands before initialization without publishing an invented state', () => {
  expect(service.executeRuntimeCommand({ type: 'start' })).toEqual({
    status: 'rejected',
    reason: 'not-initialized'
  })
  expect(frames).toHaveLength(0)
})
it.each([
  null,
  {},
  { ...configuration, settings: { ...configuration.settings, totalDuration: NaN } }
])('rejects malformed configuration %j', (value) => {
  expect(service.initializeRuntime(value)).toEqual({
    status: 'rejected',
    reason: 'invalid-configuration'
  })
  expect(frames).toHaveLength(0)
})
it('publishes the accepted complete frame before returning acknowledgement', () => {
  const result = service.initializeRuntime(configuration)
  expect(result.status).toBe('accepted')
  if (result.status === 'rejected') throw new Error(result.reason)
  expect(frames.at(-1)?.runtime).toEqual(result.snapshot)
  expect(result.snapshot.configuration).toEqual(configuration)
})
it('publishes the terminal stopped frame before clearing the last heartbeat', () => {
  service.initializeRuntime(configuration)
  service.executeRuntimeCommand({ type: 'start' })
  now = 1500
  vi.advanceTimersByTime(1000)
  expect(frames.at(-1)).toMatchObject({
    remainingSeconds: 0,
    phase: 'overtime',
    runtime: { timer: { status: 'stopped', remainingSeconds: 0, overtimeSeconds: 0 } }
  })
  expect(vi.getTimerCount()).toBe(0)
  const count = frames.length
  vi.advanceTimersByTime(5000)
  expect(frames).toHaveLength(count)
})
it('keeps accepted running state across renderer reload initialization', () => {
  service.initializeRuntime({
    ...configuration,
    settings: { ...configuration.settings, totalDuration: 60 }
  })
  service.executeRuntimeCommand({ type: 'start' })
  now = 2500
  const result = service.initializeRuntime(configuration)
  expect(result).toMatchObject({
    status: 'accepted',
    snapshot: {
      configuration: { settings: { totalDuration: 60 } },
      timer: { status: 'running', remainingSeconds: 58 }
    }
  })
})
it.each([null, { type: 'explode' }, { type: 'addTime', seconds: Infinity }])(
  'rejects malformed command %j without broadcasting',
  (command) => {
    service.initializeRuntime(configuration)
    frames.length = 0
    expect(service.executeRuntimeCommand(command)).toEqual({
      status: 'rejected',
      reason: 'invalid-command'
    })
    expect(frames).toHaveLength(0)
  }
)
