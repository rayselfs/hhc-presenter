import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createJSONStorage } from 'zustand/middleware'

const lazyLocalStorage = vi.hoisted(() => ({
  getItem: (name: string) => localStorage.getItem(name),
  setItem: (name: string, value: string) => localStorage.setItem(name, value),
  removeItem: (name: string) => localStorage.removeItem(name)
}))

vi.mock('@renderer/lib/persist-storage', () => ({
  hhcPersistStorage: createJSONStorage(() => lazyLocalStorage),
  createKey: (name: string) => `hhc-${name}`
}))

import {
  useTimerStore,
  DEFAULT_STATE,
  DEFAULT_SETTINGS,
  getDisplayValues
} from '@renderer/stores/timer'
import { installTimerRuntimeHarness } from '@renderer/test/timer-runtime-harness'
import { useSettingsStore } from '@renderer/stores/settings'
import { MAX_DURATION_SECONDS } from '@shared/constants/timer'

const INITIAL_STATE = {
  ...DEFAULT_SETTINGS,
  ...DEFAULT_STATE,
  hostRevision: -1
}

let host: ReturnType<typeof installTimerRuntimeHarness>
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  useSettingsStore.setState({ reminderMode: 'subtract' })
  useTimerStore.setState(INITIAL_STATE)
  host = installTimerRuntimeHarness()
})
afterEach(() => {
  host.dispose()
  vi.useRealTimers()
})

describe('initial state', () => {
  it('starts with correct default values', () => {
    const s = useTimerStore.getState()
    expect(s.status).toBe('stopped')
    expect(s.phase).toBe('idle')
    expect(s.remainingSeconds).toBe(300)
    expect(s.totalDuration).toBe(300)
    expect(s.overtimeSeconds).toBe(0)
    expect(s.progress).toBe(1)
    expect(s.formattedTime).toBe('05:00')
    expect(s.mode).toBe('timer')
    expect(s.reminderEnabled).toBe(false)
    expect(s.reminderDuration).toBe(60)
    expect(s).not.toHaveProperty('targetEndTime')
  })
})

describe('selectors', () => {
  it('isStopped() returns true in initial state', () => {
    expect(useTimerStore.getState().isStopped()).toBe(true)
  })

  it('isRunning() returns false in initial state', () => {
    expect(useTimerStore.getState().isRunning()).toBe(false)
  })

  it('isPaused() returns false in initial state', () => {
    expect(useTimerStore.getState().isPaused()).toBe(false)
  })

  it('isWarning() returns false in initial state', () => {
    expect(useTimerStore.getState().isWarning()).toBe(false)
  })

  it('isOvertime() returns false in initial state', () => {
    expect(useTimerStore.getState().isOvertime()).toBe(false)
  })

  it('isRunning() returns true after start()', () => {
    useTimerStore.getState().start()
    expect(useTimerStore.getState().isRunning()).toBe(true)
  })

  it('isPaused() returns true after pause()', () => {
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    expect(useTimerStore.getState().isPaused()).toBe(true)
  })
})

describe('start()', () => {
  it('transitions status to running', () => {
    useTimerStore.getState().start()
    expect(useTimerStore.getState().status).toBe('running')
  })

  it('sets phase to main when reminder is disabled', () => {
    useTimerStore.getState().start()
    expect(useTimerStore.getState().phase).toBe('main')
  })

  it('uses the host deadline without exposing it to the renderer', () => {
    useTimerStore.getState().start()
    host.advance(1000)
    expect(useTimerStore.getState().remainingSeconds).toBe(299)
    expect(useTimerStore.getState()).not.toHaveProperty('targetEndTime')
  })

  it('resets overtimeSeconds to 0', () => {
    host.runtime.executeLegacy({ type: 'start' })
    host.advance(315000)
    host.runtime.executeLegacy({ type: 'pause' })
    host.publish()
    expect(useTimerStore.getState().overtimeSeconds).toBe(15)
    useTimerStore.getState().start()
    expect(useTimerStore.getState()).toMatchObject({
      overtimeSeconds: 0,
      remainingSeconds: 300,
      status: 'running'
    })
  })

  it('is a no-op when already running', () => {
    useTimerStore.getState().start()
    host.advance(1000)
    useTimerStore.getState().start()
    host.advance(1000)
    expect(useTimerStore.getState().remainingSeconds).toBe(298)
  })
})

describe('pause()', () => {
  it('transitions status to paused', () => {
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    expect(useTimerStore.getState().status).toBe('paused')
  })

  it('prevents host time from advancing a paused countdown', () => {
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    host.advance(10000)
    expect(useTimerStore.getState()).toMatchObject({ status: 'paused', remainingSeconds: 300 })
    expect(useTimerStore.getState()).not.toHaveProperty('targetEndTime')
  })

  it('preserves remainingSeconds when paused', () => {
    useTimerStore.getState().setDuration(120)
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    expect(useTimerStore.getState().remainingSeconds).toBe(120)
  })

  it('is a no-op when not running', () => {
    useTimerStore.getState().pause()
    expect(useTimerStore.getState().status).toBe('stopped')
  })
})

describe('resume()', () => {
  it('transitions status back to running', () => {
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    useTimerStore.getState().resume()
    expect(useTimerStore.getState().status).toBe('running')
  })

  it('resumes from the accepted paused time on the host clock', () => {
    useTimerStore.getState().setDuration(90)
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    host.advance(20000)
    useTimerStore.getState().resume()
    host.advance(1000)
    expect(useTimerStore.getState().remainingSeconds).toBe(89)
    expect(useTimerStore.getState()).not.toHaveProperty('targetEndTime')
  })

  it('is a no-op when not paused', () => {
    useTimerStore.getState().resume()
    expect(useTimerStore.getState().status).toBe('stopped')
  })
})

describe('reset()', () => {
  it('transitions status to stopped', () => {
    useTimerStore.getState().start()
    useTimerStore.getState().reset()
    expect(useTimerStore.getState().status).toBe('stopped')
  })

  it('restores remainingSeconds to totalDuration', () => {
    useTimerStore.getState().start()
    host.advance(250_000)
    useTimerStore.getState().start()
    useTimerStore.getState().reset()
    expect(useTimerStore.getState().remainingSeconds).toBe(300)
  })

  it('resets phase to idle', () => {
    useTimerStore.getState().start()
    useTimerStore.getState().reset()
    expect(useTimerStore.getState().phase).toBe('idle')
  })

  it('resets overtimeSeconds to 0', () => {
    host.runtime.executeLegacy({ type: 'start' })
    host.advance(330000)
    expect(useTimerStore.getState().overtimeSeconds).toBe(30)
    useTimerStore.getState().reset()
    expect(useTimerStore.getState().overtimeSeconds).toBe(0)
  })

  it('retires the host run on reset', () => {
    useTimerStore.getState().start()
    host.advance(5000)
    useTimerStore.getState().reset()
    host.advance(10000)
    expect(useTimerStore.getState()).toMatchObject({ status: 'stopped', remainingSeconds: 300 })
    expect(useTimerStore.getState()).not.toHaveProperty('targetEndTime')
  })

  it('resets progress to 1', () => {
    useTimerStore.getState().reset()
    expect(useTimerStore.getState().progress).toBe(1)
  })
})

describe('setDuration()', () => {
  it('sets totalDuration and remainingSeconds when stopped', () => {
    useTimerStore.getState().setDuration(180)
    const s = useTimerStore.getState()
    expect(s.totalDuration).toBe(180)
    expect(s.remainingSeconds).toBe(180)
  })

  it('updates formattedTime to reflect new duration', () => {
    useTimerStore.getState().setDuration(180)
    expect(useTimerStore.getState().formattedTime).toBe('03:00')
  })

  it('sets phase to idle', () => {
    useTimerStore.getState().setDuration(180)
    expect(useTimerStore.getState().phase).toBe('idle')
  })

  it('is a no-op when running', () => {
    useTimerStore.getState().start()
    useTimerStore.getState().setDuration(999)
    expect(useTimerStore.getState().totalDuration).toBe(300)
  })

  it('is a no-op when paused', () => {
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    useTimerStore.getState().setDuration(999)
    expect(useTimerStore.getState().totalDuration).toBe(300)
  })

  it('clamps to MAX_DURATION_SECONDS (3599)', () => {
    useTimerStore.getState().setDuration(MAX_DURATION_SECONDS + 1)
    expect(useTimerStore.getState().totalDuration).toBe(MAX_DURATION_SECONDS)
  })

  it('clamps to minimum 0', () => {
    useTimerStore.getState().setDuration(-10)
    expect(useTimerStore.getState().totalDuration).toBe(0)
  })

  it('auto-disables reminder when new duration <= reminderDuration', () => {
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().setDuration(50)
    expect(useTimerStore.getState().reminderEnabled).toBe(false)
  })

  it('keeps reminder enabled when new duration > reminderDuration', () => {
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().setDuration(120)
    expect(useTimerStore.getState().reminderEnabled).toBe(true)
  })
})

describe('addTime()', () => {
  it('increases remainingSeconds when running', () => {
    useTimerStore.getState().setDuration(100)
    useTimerStore.getState().start()
    useTimerStore.getState().addTime(30)
    expect(useTimerStore.getState().remainingSeconds).toBe(130)
  })

  it('increases remainingSeconds when paused', () => {
    useTimerStore.getState().setDuration(100)
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    useTimerStore.getState().addTime(30)
    expect(useTimerStore.getState().remainingSeconds).toBe(130)
  })

  it('increases both totalDuration and remainingSeconds when stopped', () => {
    useTimerStore.getState().addTime(60)
    const s = useTimerStore.getState()
    expect(s.remainingSeconds).toBe(360)
    expect(s.totalDuration).toBe(360)
  })

  it('does not exceed MAX_DURATION_SECONDS', () => {
    useTimerStore.getState().setDuration(MAX_DURATION_SECONDS)
    useTimerStore.getState().addTime(1)
    expect(useTimerStore.getState().remainingSeconds).toBe(MAX_DURATION_SECONDS)
  })
})

describe('removeTime()', () => {
  it('decreases remainingSeconds when running', () => {
    useTimerStore.getState().start()
    host.advance(200_000)
    useTimerStore.getState().start()
    useTimerStore.getState().removeTime(30)
    expect(useTimerStore.getState().remainingSeconds).toBe(70)
  })

  it('decreases remainingSeconds when paused', () => {
    useTimerStore.getState().start()
    host.advance(200_000)
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    useTimerStore.getState().removeTime(30)
    expect(useTimerStore.getState().remainingSeconds).toBe(70)
  })

  it('does not go below 0', () => {
    useTimerStore.getState().start()
    host.advance(290_000)
    useTimerStore.getState().start()
    useTimerStore.getState().removeTime(50)
    expect(useTimerStore.getState().remainingSeconds).toBe(0)
  })

  it('decreases both totalDuration and remainingSeconds when stopped', () => {
    useTimerStore.getState().removeTime(60)
    const s = useTimerStore.getState()
    expect(s.remainingSeconds).toBe(240)
    expect(s.totalDuration).toBe(240)
  })

  it('auto-disables reminder when stopped removeTime causes invalid state', () => {
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().removeTime(250)
    expect(useTimerStore.getState().totalDuration).toBe(50)
    expect(useTimerStore.getState().reminderEnabled).toBe(false)
  })

  it('keeps reminder enabled when stopped removeTime leaves valid state', () => {
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().removeTime(10)
    expect(useTimerStore.getState().totalDuration).toBe(290)
    expect(useTimerStore.getState().reminderEnabled).toBe(true)
  })
})

describe('setMode()', () => {
  it('changes mode to clock', () => {
    useTimerStore.getState().setMode('clock')
    expect(useTimerStore.getState().mode).toBe('clock')
  })

  it('changes mode to stopwatch', () => {
    useTimerStore.getState().setMode('stopwatch')
    expect(useTimerStore.getState().mode).toBe('stopwatch')
  })

  it('changes mode to both', () => {
    useTimerStore.getState().setMode('both')
    expect(useTimerStore.getState().mode).toBe('both')
  })

  it('changes mode back to timer', () => {
    useTimerStore.getState().setMode('clock')
    useTimerStore.getState().setMode('timer')
    expect(useTimerStore.getState().mode).toBe('timer')
  })
})

describe('tick()', () => {
  it('is a no-op when not running', () => {
    useTimerStore.getState().setDuration(100)
    host.advance(10000)
    expect(useTimerStore.getState().remainingSeconds).toBe(100)
  })

  it('decrements remainingSeconds from the host deadline', () => {
    useTimerStore.getState().start()
    host.advance(210000)
    expect(useTimerStore.getState().remainingSeconds).toBe(90)
  })

  it('transitions to overtime when remaining reaches 0', () => {
    useTimerStore.getState().start()
    host.advance(305000)
    const s = useTimerStore.getState()
    expect(s.status).toBe('stopped')
    expect(s.remainingSeconds).toBe(0)
    expect(s.phase).toBe('overtime')
    expect(s.overtimeSeconds).toBe(0)
    expect(s).not.toHaveProperty('targetEndTime')
  })

  it('updates formattedTime correctly', () => {
    useTimerStore.getState().start()
    host.advance(120000)
    expect(useTimerStore.getState().formattedTime).toBe('03:00')
  })

  it('updates progress correctly', () => {
    useTimerStore.getState().start()
    host.advance(150000)
    expect(useTimerStore.getState().progress).toBeCloseTo(0.5, 1)
  })

  it('replaces renderer-written runtime fields with the next authoritative frame', () => {
    useTimerStore.setState({ status: 'running', remainingSeconds: 100 })
    host.advance(1000)
    expect(useTimerStore.getState()).toMatchObject({ status: 'stopped', remainingSeconds: 300 })
  })
})

describe('phase transitions', () => {
  it('idle → main on start (reminder disabled)', () => {
    expect(useTimerStore.getState().phase).toBe('idle')
    useTimerStore.getState().start()
    expect(useTimerStore.getState().phase).toBe('main')
  })

  it('main → warning via tick when reminder enabled', () => {
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().start()
    host.advance(250000)
    expect(useTimerStore.getState().phase).toBe('warning')
  })

  it('stays in main when reminder disabled even below reminder threshold', () => {
    useTimerStore.getState().start()
    host.advance(270000)
    expect(useTimerStore.getState().phase).toBe('main')
  })

  it('warning → overtime via tick when time runs out', () => {
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().start()
    host.advance(245000)
    expect(useTimerStore.getState().phase).toBe('warning')
    host.advance(60000)
    expect(useTimerStore.getState().phase).toBe('overtime')
  })

  it('reset from any phase returns to idle', () => {
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().start()
    host.advance(250000)
    expect(useTimerStore.getState().phase).toBe('warning')
    useTimerStore.getState().reset()
    expect(useTimerStore.getState().phase).toBe('idle')
  })
})

describe('isWarning() and isOvertime() selectors', () => {
  it('isWarning() returns true when phase is warning', () => {
    useTimerStore.setState({ phase: 'warning' })
    expect(useTimerStore.getState().isWarning()).toBe(true)
  })

  it('isWarning() returns false when phase is not warning', () => {
    useTimerStore.setState({ phase: 'main' })
    expect(useTimerStore.getState().isWarning()).toBe(false)
  })

  it('isOvertime() returns true when phase is overtime', () => {
    useTimerStore.setState({ phase: 'overtime' })
    expect(useTimerStore.getState().isOvertime()).toBe(true)
  })

  it('isOvertime() returns false when phase is main', () => {
    useTimerStore.setState({ phase: 'main' })
    expect(useTimerStore.getState().isOvertime()).toBe(false)
  })
})

describe('formattedTime', () => {
  it('formats 300s as 05:00', () => {
    useTimerStore.getState().setDuration(300)
    expect(useTimerStore.getState().formattedTime).toBe('05:00')
  })

  it('formats 3599s (max) as 59:59', () => {
    useTimerStore.getState().setDuration(3599)
    expect(useTimerStore.getState().formattedTime).toBe('59:59')
  })

  it('formats 3599s clamped from 3661s as 59:59', () => {
    useTimerStore.getState().setDuration(3661)
    expect(useTimerStore.getState().formattedTime).toBe('59:59')
  })

  it('formats 59s as 00:59', () => {
    useTimerStore.getState().setDuration(59)
    expect(useTimerStore.getState().formattedTime).toBe('00:59')
  })

  it('formats 0s as 00:00', () => {
    useTimerStore.getState().setDuration(0)
    expect(useTimerStore.getState().formattedTime).toBe('00:00')
  })
})

describe('setReminder()', () => {
  it('updates reminderEnabled and reminderDuration', () => {
    useTimerStore.getState().setReminder(true, 30)
    const s = useTimerStore.getState()
    expect(s.reminderEnabled).toBe(true)
    expect(s.reminderDuration).toBe(30)
  })

  it('recomputes phase to warning if running and within threshold', () => {
    useTimerStore.getState().start()
    host.advance(255000)
    useTimerStore.getState().setReminder(true, 60)
    expect(useTimerStore.getState().phase).toBe('warning')
  })

  it('keeps phase unchanged when stopped', () => {
    useTimerStore.getState().setReminder(true, 60)
    expect(useTimerStore.getState().phase).toBe('idle')
  })

  it('clears warning phase when reminder is disabled', () => {
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().start()
    host.advance(255000)
    expect(useTimerStore.getState().phase).toBe('warning')
    useTimerStore.getState().setReminder(false, 60)
    expect(useTimerStore.getState().phase).toBe('main')
  })
})

describe('setOvertimeMessage()', () => {
  it('updates overtimeMessageEnabled and overtimeMessage', () => {
    useTimerStore.getState().setOvertimeMessage(true, 'Finished!')
    const s = useTimerStore.getState()
    expect(s.overtimeMessageEnabled).toBe(true)
    expect(s.overtimeMessage).toBe('Finished!')
  })

  it('can disable overtime message', () => {
    useTimerStore.getState().setOvertimeMessage(true, 'Finished!')
    useTimerStore.getState().setOvertimeMessage(false, 'Finished!')
    expect(useTimerStore.getState().overtimeMessageEnabled).toBe(false)
  })
})

describe('progress', () => {
  it('is 1 when fully remaining', () => {
    expect(useTimerStore.getState().progress).toBe(1)
  })

  it('is 0 when remainingSeconds is 0', () => {
    useTimerStore.getState().start()
    host.advance(301000)
    expect(useTimerStore.getState().progress).toBe(0)
  })

  it('is 0.5 when half remaining', () => {
    useTimerStore.getState().start()
    host.advance(150000)
    expect(useTimerStore.getState().progress).toBeCloseTo(0.5, 2)
  })
})

describe('reminder phase logic with 180s duration + 60s reminder', () => {
  beforeEach(() => {
    useTimerStore.setState({
      ...INITIAL_STATE,
      totalDuration: 180,
      remainingSeconds: 180,
      reminderEnabled: true,
      reminderDuration: 60,
      formattedTime: '03:00'
    })
    host.dispose()
    host = installTimerRuntimeHarness()
  })

  it('starts in main phase', () => {
    useTimerStore.getState().start()
    expect(useTimerStore.getState().phase).toBe('main')
  })

  it('transitions to warning at exactly reminderDuration seconds', () => {
    useTimerStore.getState().start()
    host.advance(120000)
    expect(useTimerStore.getState().phase).toBe('warning')
  })

  it('stays in main phase above reminderDuration', () => {
    useTimerStore.getState().start()
    host.advance(90000)
    expect(useTimerStore.getState().phase).toBe('main')
  })

  it('transitions to overtime when time runs out', () => {
    useTimerStore.getState().start()
    host.advance(181000)
    const s = useTimerStore.getState()
    expect(s.phase).toBe('overtime')
    expect(s.status).toBe('stopped')
  })
})

describe('getDisplayValues', () => {
  it('IDLE: shows totalDuration, no sub, not red, no overtime', () => {
    const result = getDisplayValues({
      phase: 'idle',
      remainingSeconds: 300,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 300,
      reminderEnabled: false
    })
    expect(result.mainDisplay).toBe('05:00')
    expect(result.subDisplay).toBeNull()
    expect(result.overtimeDisplay).toBeNull()
  })

  it('IDLE with custom totalDuration: formats correctly', () => {
    const result = getDisplayValues({
      phase: 'idle',
      remainingSeconds: 120,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 3600,
      reminderEnabled: false
    })
    expect(result.mainDisplay).toBe('1:00:00')
  })

  it('MAIN phase with reminder enabled: shows countdown-to-warning, subDisplay=reminderDuration', () => {
    const result = getDisplayValues({
      phase: 'main',
      remainingSeconds: 180,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(result.mainDisplay).toBe('02:00')
    expect(result.subDisplay).toBe('01:00')
    expect(result.overtimeDisplay).toBeNull()
  })

  it('MAIN phase with reminder enabled: remainingSeconds=121', () => {
    const result = getDisplayValues({
      phase: 'main',
      remainingSeconds: 121,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(result.mainDisplay).toBe('01:01')
    expect(result.subDisplay).toBe('01:00')
  })

  it('MAIN phase with reminder enabled: remainingSeconds=61 (1s before warning)', () => {
    const result = getDisplayValues({
      phase: 'main',
      remainingSeconds: 61,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(result.mainDisplay).toBe('00:01')
    expect(result.subDisplay).toBe('01:00')
  })

  it('WARNING phase: mainDisplay=remainingSeconds in red, subDisplay=null', () => {
    const result = getDisplayValues({
      phase: 'warning',
      remainingSeconds: 60,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(result.mainDisplay).toBe('01:00')
    expect(result.subDisplay).toBeNull()
    expect(result.overtimeDisplay).toBeNull()
  })

  it('WARNING phase counting down: remainingSeconds=30', () => {
    const result = getDisplayValues({
      phase: 'warning',
      remainingSeconds: 30,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(result.mainDisplay).toBe('00:30')
  })

  it('OVERTIME phase: mainDisplay=00:00, overtimeDisplay=elapsed, not red', () => {
    const result = getDisplayValues({
      phase: 'overtime',
      remainingSeconds: 0,
      reminderDuration: 60,
      overtimeSeconds: 15,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(result.mainDisplay).toBe('00:00')
    expect(result.subDisplay).toBeNull()
    expect(result.overtimeDisplay).toBe('00:15')
  })

  it('OVERTIME phase: overtimeDisplay counts up correctly', () => {
    const result = getDisplayValues({
      phase: 'overtime',
      remainingSeconds: 0,
      reminderDuration: 60,
      overtimeSeconds: 90,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(result.overtimeDisplay).toBe('01:30')
  })

  it('MAIN phase with reminder DISABLED: shows remainingSeconds directly, no subDisplay', () => {
    const result = getDisplayValues({
      phase: 'main',
      remainingSeconds: 180,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 180,
      reminderEnabled: false
    })
    expect(result.mainDisplay).toBe('03:00')
    expect(result.subDisplay).toBeNull()
  })

  it('PAUSED state uses same display as running — phase drives display, not status', () => {
    const resultMain = getDisplayValues({
      phase: 'main',
      remainingSeconds: 120,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(resultMain.mainDisplay).toBe('01:00')
    expect(resultMain.subDisplay).toBe('01:00')

    const resultWarning = getDisplayValues({
      phase: 'warning',
      remainingSeconds: 45,
      reminderDuration: 60,
      overtimeSeconds: 0,
      totalDuration: 180,
      reminderEnabled: true
    })
    expect(resultWarning.mainDisplay).toBe('00:45')
  })
})

describe('getDisplayValues end-to-end via store tick', () => {
  it('full phase transition: main → warning → overtime', () => {
    useTimerStore.getState().setDuration(180)
    useTimerStore.getState().setReminder(true, 60)
    useTimerStore.getState().start()
    host.advance(59000)
    let s = useTimerStore.getState()
    expect(s.phase).toBe('main')
    expect(s.remainingSeconds).toBe(121)
    const dv1 = getDisplayValues(s)
    expect(dv1.mainDisplay).toBe('01:01')
    expect(dv1.subDisplay).toBe('01:00')
    host.advance(61000)
    s = useTimerStore.getState()
    expect(s.phase).toBe('warning')
    const dv2 = getDisplayValues(s)
    expect(dv2.subDisplay).toBeNull()
    host.advance(61000)
    s = useTimerStore.getState()
    expect(s.phase).toBe('overtime')
    const dv3 = getDisplayValues(s)
    expect(dv3.mainDisplay).toBe('00:00')
    expect(dv3.overtimeDisplay).not.toBeNull()
  })
})

describe('preset management', () => {
  let localStorageMock: Record<string, string> = {}

  beforeEach(() => {
    localStorageMock = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] || null,
      setItem: (key: string, value: string) => {
        localStorageMock[key] = value
      },
      removeItem: (key: string) => {
        delete localStorageMock[key]
      },
      clear: () => {
        localStorageMock = {}
      },
      length: 0,
      key: (index: number) => {
        const keys = Object.keys(localStorageMock)
        return keys[index] || null
      }
    })
    useTimerStore.setState(INITIAL_STATE)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('has default presets on initial state', () => {
    const s = useTimerStore.getState()
    expect(s.presets).toHaveLength(3)
    expect(s.presets[0].name).toBe('10:00')
    expect(s.presets[1].name).toBe('05:00')
    expect(s.presets[2].name).toBe('03:00')
  })

  it('addPreset increases presets array', () => {
    const initialCount = useTimerStore.getState().presets.length
    useTimerStore.getState().addPreset('15m', 900)
    expect(useTimerStore.getState().presets).toHaveLength(initialCount + 1)
  })

  it('addPreset with name and duration creates correct preset', () => {
    useTimerStore.getState().addPreset('15m', 900)
    const presets = useTimerStore.getState().presets
    const last = presets[presets.length - 1]
    expect(last.name).toBe('15m')
    expect(last.durationSeconds).toBe(900)
    expect(last.mode).toBe('timer')
    expect(last.id).toBeDefined()
  })

  it('removePreset filters out matching id', () => {
    useTimerStore.getState().addPreset('test', 500)
    const presets = useTimerStore.getState().presets
    const idToRemove = presets[presets.length - 1].id
    useTimerStore.getState().removePreset(idToRemove)
    expect(useTimerStore.getState().presets.find((p) => p.id === idToRemove)).toBeUndefined()
  })

  it('applyPreset sets duration when timer is stopped', () => {
    useTimerStore.getState().addPreset('20m', 1200)
    const presets = useTimerStore.getState().presets
    const presetId = presets[presets.length - 1].id
    useTimerStore.getState().applyPreset(presetId)
    expect(useTimerStore.getState().remainingSeconds).toBe(1200)
    expect(useTimerStore.getState().totalDuration).toBe(1200)
  })

  it('applyPreset is no-op when timer is running', () => {
    useTimerStore.getState().addPreset('20m', 1200)
    useTimerStore.getState().start()
    const presets = useTimerStore.getState().presets
    const presetId = presets[presets.length - 1].id
    const before = useTimerStore.getState().remainingSeconds
    useTimerStore.getState().applyPreset(presetId)
    expect(useTimerStore.getState().remainingSeconds).toBe(before)
  })

  it('applyPreset is no-op when timer is paused', () => {
    useTimerStore.getState().addPreset('20m', 1200)
    useTimerStore.getState().start()
    useTimerStore.getState().pause()
    const presets = useTimerStore.getState().presets
    const presetId = presets[presets.length - 1].id
    const before = useTimerStore.getState().remainingSeconds
    useTimerStore.getState().applyPreset(presetId)
    expect(useTimerStore.getState().remainingSeconds).toBe(before)
  })

  it('addPreset persists presets to localStorage via persist middleware', () => {
    useTimerStore.getState().addPreset('12m', 720)
    const raw = localStorageMock['hhc-timer-config']
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw)
    const presets = parsed.state.presets
    expect(presets.some((p: { name: string }) => p.name === '12m')).toBe(true)
  })

  it('removePreset updates localStorage via persist middleware', () => {
    useTimerStore.getState().addPreset('remove-me', 999)
    const presetsAfterAdd = useTimerStore.getState().presets
    const idToRemove = presetsAfterAdd[presetsAfterAdd.length - 1].id
    useTimerStore.getState().removePreset(idToRemove)
    const raw = localStorageMock['hhc-timer-config']
    const parsed = JSON.parse(raw)
    expect(parsed.state.presets.find((p: { id: string }) => p.id === idToRemove)).toBeUndefined()
  })

  it('persist hydration restores presets from localStorage', () => {
    const testPresets = [
      { id: 'test-1', name: 'test-10m', durationSeconds: 600, mode: 'timer' as const },
      { id: 'test-2', name: 'test-5m', durationSeconds: 300, mode: 'timer' as const }
    ]
    localStorageMock['hhc-timer-config'] = JSON.stringify({
      state: { presets: testPresets, totalDuration: 300 },
      version: 1
    })
    useTimerStore.persist.rehydrate()
    const s = useTimerStore.getState()
    expect(s.presets).toHaveLength(2)
    expect(s.presets[0].name).toBe('test-10m')
    expect(s.presets[1].name).toBe('test-5m')
  })

  it('persist hydration uses defaults when key missing', () => {
    delete localStorageMock['hhc-timer-config']
    useTimerStore.persist.rehydrate()
    const s = useTimerStore.getState()
    expect(s.presets).toBeDefined()
    expect(Array.isArray(s.presets)).toBe(true)
  })

  it('addPreset generates unique ids', () => {
    useTimerStore.getState().addPreset('a', 100)
    useTimerStore.getState().addPreset('b', 200)
    const presets = useTimerStore.getState().presets
    const ids = presets.filter((p) => p.name === 'a' || p.name === 'b').map((p) => p.id)
    expect(ids.length).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('clamps durationSeconds to MAX_DURATION_SECONDS', () => {
    useTimerStore.getState().addPreset('Too long', MAX_DURATION_SECONDS + 100)
    const presets = useTimerStore.getState().presets
    const added = presets[presets.length - 1]
    expect(added.durationSeconds).toBe(MAX_DURATION_SECONDS)
  })
})

describe('duration persistence', () => {
  let localStorageMock: Record<string, string> = {}

  beforeEach(() => {
    localStorageMock = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] || null,
      setItem: (key: string, value: string) => {
        localStorageMock[key] = value
      },
      removeItem: (key: string) => {
        delete localStorageMock[key]
      },
      clear: () => {
        localStorageMock = {}
      },
      length: 0,
      key: (index: number) => {
        const keys = Object.keys(localStorageMock)
        return keys[index] || null
      }
    })
    useTimerStore.setState(INITIAL_STATE)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('setDuration persists totalDuration via persist middleware', () => {
    useTimerStore.getState().setDuration(120)
    const raw = localStorageMock['hhc-timer-config']
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw)
    expect(parsed.state.totalDuration).toBe(120)
    expect(parsed.version).toBe(1)
  })

  it('a fresh host seeds its duration from hydrated preferences', () => {
    localStorageMock['hhc-timer-config'] = JSON.stringify({
      state: { totalDuration: 180 },
      version: 1
    })
    useTimerStore.persist.rehydrate()
    host.dispose()
    host = installTimerRuntimeHarness()
    const s = useTimerStore.getState()
    expect(s.totalDuration).toBe(180)
    expect(s.remainingSeconds).toBe(180)
    expect(s.formattedTime).toBe('03:00')
  })

  it('persist hydration keeps current state when key missing', () => {
    useTimerStore.persist.rehydrate()
    const s = useTimerStore.getState()
    expect(s.totalDuration).toBe(300)
  })

  it('addTime in stopped state persists new totalDuration', () => {
    useTimerStore.getState().addTime(60)
    const raw = localStorageMock['hhc-timer-config']
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw)
    expect(parsed.state.totalDuration).toBe(360)
  })

  it('removeTime in stopped state persists new totalDuration', () => {
    useTimerStore.getState().removeTime(60)
    const raw = localStorageMock['hhc-timer-config']
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw)
    expect(parsed.state.totalDuration).toBe(240)
  })
})

describe('persist middleware writes correct format', () => {
  let localStorageMock: Record<string, string> = {}

  beforeEach(() => {
    localStorageMock = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] || null,
      setItem: (key: string, value: string) => {
        localStorageMock[key] = value
      },
      removeItem: (key: string) => {
        delete localStorageMock[key]
      },
      clear: () => {
        localStorageMock = {}
      },
      length: 0,
      key: (index: number) => {
        const keys = Object.keys(localStorageMock)
        return keys[index] || null
      }
    })
    useTimerStore.setState(INITIAL_STATE)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persist key is hhc-timer-config', () => {
    useTimerStore.getState().setDuration(120)
    expect(localStorageMock['hhc-timer-config']).toBeDefined()
  })

  it('persisted value has state and version fields', () => {
    useTimerStore.getState().setDuration(120)
    const parsed = JSON.parse(localStorageMock['hhc-timer-config'])
    expect(parsed).toHaveProperty('state')
    expect(parsed).toHaveProperty('version', 1)
  })

  it('partialize only persists config fields, not runtime fields', () => {
    useTimerStore.getState().setDuration(120)
    const parsed = JSON.parse(localStorageMock['hhc-timer-config'])
    const state = parsed.state
    expect(state).toHaveProperty('mode')
    expect(state).toHaveProperty('totalDuration')
    expect(state).toHaveProperty('reminderEnabled')
    expect(state).toHaveProperty('reminderDuration')
    expect(state).toHaveProperty('reminderColor')
    expect(state).toHaveProperty('overtimeMessageEnabled')
    expect(state).toHaveProperty('overtimeMessage')
    expect(state).toHaveProperty('presets')
    expect(state).not.toHaveProperty('status')
    expect(state).not.toHaveProperty('phase')
    expect(state).not.toHaveProperty('remainingSeconds')
    expect(state).not.toHaveProperty('targetEndTime')
  })

  it('setReminder persists reminderEnabled and related fields', () => {
    useTimerStore.getState().setReminder(true, 45, '#00ff00')
    const parsed = JSON.parse(localStorageMock['hhc-timer-config'])
    expect(parsed.state.reminderEnabled).toBe(true)
    expect(parsed.state.reminderDuration).toBe(45)
    expect(parsed.state.reminderColor).toBe('#00ff00')
  })

  it('setOvertimeMessage persists overtime fields', () => {
    useTimerStore.getState().setOvertimeMessage(true, 'Done!')
    const parsed = JSON.parse(localStorageMock['hhc-timer-config'])
    expect(parsed.state.overtimeMessageEnabled).toBe(true)
    expect(parsed.state.overtimeMessage).toBe('Done!')
  })
})
