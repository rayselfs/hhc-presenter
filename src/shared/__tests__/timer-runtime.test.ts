import { beforeEach, expect, it } from 'vitest'
import { TimerRuntime } from '../timer-runtime'
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
let now: number
let runtime: TimerRuntime
function frame(result: TimerRuntimeResult): TimerRuntimeSnapshot {
  expect(result.status).toBe('accepted')
  if (result.status === 'rejected') throw new Error(result.reason)
  return result.snapshot
}
beforeEach(() => {
  now = 0
  runtime = new TimerRuntime(() => now)
  frame(runtime.initialize(configuration))
})

it('retains rounded pause, paused adjustments, resume and reset semantics', () => {
  frame(runtime.execute({ type: 'start' }))
  now = 1500
  expect(runtime.tick().timer.remainingSeconds).toBe(59)
  frame(runtime.execute({ type: 'pause' }))
  frame(runtime.execute({ type: 'addTime', seconds: 10 }))
  now += 15000
  expect(runtime.tick().timer).toMatchObject({ status: 'paused', remainingSeconds: 69 })
  frame(runtime.execute({ type: 'resume' }))
  now += 2100
  expect(runtime.tick().timer.remainingSeconds).toBe(67)
  expect(frame(runtime.execute({ type: 'reset' })).timer).toMatchObject({
    status: 'stopped',
    phase: 'idle',
    remainingSeconds: 60
  })
})

it('uses the host clock after a delayed tick and stops the presenter at zero', () => {
  frame(runtime.execute({ type: 'start' }))
  now = 75000
  expect(runtime.tick().timer).toMatchObject({
    status: 'stopped',
    phase: 'overtime',
    remainingSeconds: 0,
    overtimeSeconds: 0,
    progress: 0
  })
})

it('pins presenter completion across legacy pause and resume until reset', () => {
  frame(runtime.execute({ type: 'setDuration', seconds: 1 }))
  frame(runtime.execute({ type: 'start' }))
  runtime.executeLegacy({ type: 'pause' })
  runtime.executeLegacy({ type: 'resume' })
  now = 2000
  expect(runtime.tick().timer.status).toBe('stopped')
  frame(runtime.execute({ type: 'reset' }))
  runtime.executeLegacy({ type: 'start' })
  now = 4000
  expect(runtime.tick().timer).toMatchObject({
    status: 'running',
    phase: 'overtime',
    overtimeSeconds: 1
  })
})

it('pins legacy completion across presenter pause, adjustment and resume', () => {
  runtime.executeLegacy({ type: 'setDuration', seconds: 1 })
  runtime.executeLegacy({ type: 'start' })
  frame(runtime.execute({ type: 'pause' }))
  frame(runtime.execute({ type: 'addTime', seconds: 1 }))
  frame(runtime.execute({ type: 'resume' }))
  now = 4000
  expect(runtime.tick().timer).toMatchObject({
    status: 'running',
    phase: 'overtime',
    overtimeSeconds: 2
  })
  frame(runtime.execute({ type: 'reset' }))
  frame(runtime.execute({ type: 'start' }))
  now = 6000
  expect(runtime.tick().timer.status).toBe('stopped')
})

it('preserves a running added-reminder deadline across mode changes', () => {
  frame(runtime.execute({ type: 'setReminder', enabled: true, durationSeconds: 30 }))
  frame(runtime.execute({ type: 'setReminderMode', mode: 'add' }))
  expect(frame(runtime.execute({ type: 'start' })).timer.remainingSeconds).toBe(90)
  now = 1100
  const changed = frame(runtime.execute({ type: 'setReminderMode', mode: 'subtract' }))
  expect(changed.timer.remainingSeconds).toBe(89)
  expect(changed.timer.progress).toBe(1)
  now = 2100
  expect(runtime.tick().timer.remainingSeconds).toBe(88)
  expect(frame(runtime.execute({ type: 'reset' })).timer.remainingSeconds).toBe(60)
})

it('adopts stopped reminder preferences and disables an invalid reminder after duration reduction', () => {
  frame(
    runtime.execute({ type: 'setReminder', enabled: true, durationSeconds: 30, color: '#123456' })
  )
  expect(
    frame(runtime.execute({ type: 'setReminderMode', mode: 'add' })).timer.remainingSeconds
  ).toBe(90)
  const changed = frame(runtime.execute({ type: 'setDuration', seconds: 20 }))
  expect(changed.timer.remainingSeconds).toBe(20)
  expect(changed.configuration.settings).toMatchObject({
    reminderEnabled: false,
    reminderColor: '#123456'
  })
})

it('keeps operator stopped adjustments as configuration and legacy restart as configured', () => {
  const adjusted = frame(runtime.execute({ type: 'addTime', seconds: 30 }))
  expect(adjusted.configuration.settings.totalDuration).toBe(90)
  expect(frame(runtime.execute({ type: 'start' })).timer.remainingSeconds).toBe(90)
  runtime.executeLegacy({ type: 'reset' })
  runtime.executeLegacy({ type: 'setDuration', seconds: 60 })
  runtime.executeLegacy({ type: 'addTime', seconds: 30 })
  expect(runtime.getSnapshot().timer.remainingSeconds).toBe(90)
  runtime.executeLegacy({ type: 'start' })
  expect(runtime.getSnapshot().timer.remainingSeconds).toBe(60)
})

it('does not reinitialize a live host from stale renderer preferences', () => {
  frame(runtime.execute({ type: 'start' }))
  now = 5000
  const before = runtime.getSnapshot().revision
  const reloaded = frame(
    runtime.initialize({
      ...configuration,
      settings: { ...configuration.settings, totalDuration: 300 }
    })
  )
  expect(reloaded.timer).toMatchObject({ status: 'running', remainingSeconds: 55 })
  expect(reloaded.configuration.settings.totalDuration).toBe(60)
  expect(reloaded.revision).toBeGreaterThan(before)
})

it('preserves stopwatch pause/resume while distinguishing a presenter restart', () => {
  frame(runtime.execute({ type: 'startStopwatch' }))
  now = 1300
  frame(runtime.execute({ type: 'pauseStopwatch' }))
  now = 3300
  runtime.executeLegacy({ type: 'startStopwatch' })
  expect(runtime.getSnapshot().stopwatch.elapsedMs).toBe(1300)
  frame(runtime.execute({ type: 'pauseStopwatch' }))
  expect(frame(runtime.execute({ type: 'startStopwatch' })).stopwatch.elapsedMs).toBe(0)
  now = 5500
  expect(runtime.tick().stopwatch).toMatchObject({
    status: 'running',
    elapsedMs: 2200,
    formattedTime: '00:02.20'
  })
})

it('resets the presenter countdown in clock mode while retaining the legacy ingress', () => {
  frame(runtime.execute({ type: 'start' }))
  expect(frame(runtime.execute({ type: 'setMode', mode: 'clock' })).timer.status).toBe('stopped')
  runtime.executeLegacy({ type: 'start' })
  runtime.executeLegacy({ type: 'setMode', mode: 'clock' })
  expect(runtime.getSnapshot().timer.status).toBe('running')
})

it.each([NaN, Infinity, -1, 3600])(
  'rejects invalid configuration/commands without changing the host: %s',
  (seconds) => {
    const before = runtime.getSnapshot()
    expect(
      runtime.initialize({
        ...configuration,
        settings: { ...configuration.settings, totalDuration: seconds }
      })
    ).toEqual({ status: 'rejected', reason: 'invalid-configuration' })
    expect(runtime.execute({ type: 'addTime', seconds })).toEqual({
      status: 'rejected',
      reason: 'invalid-command'
    })
    expect(runtime.getSnapshot()).toEqual(before)
  }
)

it('rejects commands before bootstrap and returns detached snapshots without host anchors', () => {
  const fresh = new TimerRuntime(() => now)
  expect(fresh.execute({ type: 'start' })).toEqual({
    status: 'rejected',
    reason: 'not-initialized'
  })
  const accepted = frame(fresh.initialize(configuration))
  accepted.configuration.settings.totalDuration = 999
  accepted.timer.remainingSeconds = 999
  expect(fresh.getSnapshot().timer.remainingSeconds).toBe(60)
  expect(fresh.getSnapshot().configuration.settings.totalDuration).toBe(60)
  expect(JSON.stringify(fresh.getSnapshot())).not.toMatch(/deadline|anchor|nowMs/i)
})

it('publishes only timer settings after legacy initialization with extra input fields', () => {
  const settings = { ...configuration.settings, privateMetadata: 'not-a-timer-setting' }
  runtime.initializeLegacy(settings)
  expect(runtime.getSnapshot().configuration.settings).toEqual(configuration.settings)
})
