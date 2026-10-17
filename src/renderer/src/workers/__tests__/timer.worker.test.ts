import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTimerWorkerHost, type WorkerOutgoingMessage } from '../timer-worker-host'
import type { TimerRuntimeCommand, TimerRuntimeSnapshot } from '@shared/types/timer'

let host: ReturnType<typeof createTimerWorkerHost>
let messages: WorkerOutgoingMessage[]
let latest: TimerRuntimeSnapshot
let requestId: number
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  messages = []
  requestId = 0
  host = createTimerWorkerHost(
    (message) => {
      messages.push(message)
      if (message.type === 'snapshot') latest = message.snapshot
      else if (message.result.status === 'accepted') latest = message.result.snapshot
    },
    () => Date.now()
  )
  host.handleMessage({
    type: 'initialize',
    requestId: ++requestId,
    configuration: {
      settings: {
        mode: 'timer',
        totalDuration: 10,
        reminderEnabled: false,
        reminderDuration: 2,
        reminderColor: '#f00',
        overtimeMessageEnabled: false,
        overtimeMessage: ''
      },
      reminderMode: 'subtract'
    }
  })
})
afterEach(() => {
  host.dispose()
  vi.useRealTimers()
})
function command(command: TimerRuntimeCommand): void {
  host.handleMessage({ type: 'command', requestId: ++requestId, command })
}
function start(seconds = 10): void {
  command({ type: 'setDuration', seconds })
  command({ type: 'start' })
}
function advance(ms: number): void {
  vi.advanceTimersByTime(ms)
}
function frames(): TimerRuntimeSnapshot[] {
  return messages.flatMap((message) => (message.type === 'snapshot' ? [message.snapshot] : []))
}

describe('start command', () => {
  it('sets status to running', () => {
    start()
    expect(latest.timer.status).toBe('running')
  })
  it('owns the deadline without serializing its clock anchor', () => {
    start()
    advance(1000)
    expect(latest.timer.remainingSeconds).toBe(9)
    expect(JSON.stringify(latest)).not.toMatch(/deadline|anchor/i)
  })
  it('retains the accepted configured duration', () => {
    start(20)
    expect(latest.configuration.settings.totalDuration).toBe(20)
  })
  it('starts from the configured remaining time', () => {
    start()
    expect(latest.timer.remainingSeconds).toBe(10)
  })
  it('starts the interval', () => {
    start()
    expect(vi.getTimerCount()).toBe(1)
  })
  it('does not allocate another interval or restart an active run', () => {
    start()
    advance(1000)
    command({ type: 'start' })
    advance(1000)
    expect(vi.getTimerCount()).toBe(1)
    expect(latest.timer.remainingSeconds).toBe(8)
  })
})
describe('pause command', () => {
  it('sets status to paused when running', () => {
    start()
    command({ type: 'pause' })
    expect(latest.timer.status).toBe('paused')
  })
  it('captures the remaining countdown on the host', () => {
    start()
    advance(3000)
    command({ type: 'pause' })
    expect(latest.timer.remainingSeconds).toBe(7)
  })
  it('does nothing if already paused', () => {
    start()
    command({ type: 'pause' })
    advance(5000)
    command({ type: 'pause' })
    expect(latest.timer).toMatchObject({ status: 'paused', remainingSeconds: 10 })
  })
  it('does nothing if stopped', () => {
    command({ type: 'pause' })
    expect(latest.timer.status).toBe('stopped')
    expect(vi.getTimerCount()).toBe(0)
  })
})
describe('resume command', () => {
  it('sets status to running from paused', () => {
    start()
    command({ type: 'pause' })
    command({ type: 'resume' })
    expect(latest.timer.status).toBe('running')
  })
  it('resumes from remaining time without counting the pause', () => {
    start()
    advance(3000)
    command({ type: 'pause' })
    advance(5000)
    command({ type: 'resume' })
    advance(2000)
    expect(latest.timer.remainingSeconds).toBe(5)
  })
  it('does nothing if not paused', () => {
    command({ type: 'resume' })
    expect(latest.timer.status).toBe('stopped')
  })
  it('restarts the interval', () => {
    start()
    command({ type: 'pause' })
    expect(vi.getTimerCount()).toBe(0)
    command({ type: 'resume' })
    expect(vi.getTimerCount()).toBe(1)
  })
})
describe('reset command', () => {
  it('sets status to stopped', () => {
    start()
    command({ type: 'reset' })
    expect(latest.timer.status).toBe('stopped')
  })
  it('retires the countdown deadline', () => {
    start()
    advance(2000)
    command({ type: 'reset' })
    advance(20000)
    expect(latest.timer.remainingSeconds).toBe(10)
  })
  it('clears the interval', () => {
    start()
    command({ type: 'reset' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('resets runtime while retaining accepted configuration', () => {
    start()
    advance(3000)
    command({ type: 'reset' })
    expect(latest.timer).toMatchObject({ phase: 'idle', remainingSeconds: 10, overtimeSeconds: 0 })
    expect(latest.configuration.settings.totalDuration).toBe(10)
  })
})
describe('addTime command', () => {
  it('adds to stopped configuration and remaining time', () => {
    command({ type: 'setDuration', seconds: 0 })
    command({ type: 'addTime', seconds: 5 })
    expect(latest.timer.remainingSeconds).toBe(5)
    expect(latest.configuration.settings.totalDuration).toBe(5)
  })
  it('extends a running deadline', () => {
    start()
    advance(3000)
    command({ type: 'addTime', seconds: 5 })
    advance(1000)
    expect(latest.timer.remainingSeconds).toBe(11)
  })
  it('adds to paused remaining time', () => {
    start()
    advance(3000)
    command({ type: 'pause' })
    command({ type: 'addTime', seconds: 5 })
    expect(latest.timer).toMatchObject({ status: 'paused', remainingSeconds: 12 })
  })
})
describe('removeTime command', () => {
  it('removes from stopped configuration with a zero minimum', () => {
    command({ type: 'removeTime', seconds: 20 })
    expect(latest.timer.remainingSeconds).toBe(0)
  })
  it('removes paused remaining time with a zero minimum', () => {
    start()
    command({ type: 'pause' })
    command({ type: 'removeTime', seconds: 20 })
    expect(latest.timer).toMatchObject({ status: 'paused', remainingSeconds: 0 })
  })
  it('shortens a running deadline', () => {
    start()
    command({ type: 'removeTime', seconds: 5 })
    advance(2000)
    expect(latest.timer.remainingSeconds).toBe(3)
  })
  it('accepts a terminal frame immediately when running time is removed past zero', () => {
    start()
    command({ type: 'removeTime', seconds: 20 })
    expect(latest.timer).toMatchObject({
      status: 'stopped',
      phase: 'overtime',
      remainingSeconds: 0
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
describe('tick behavior via setInterval', () => {
  it('posts authoritative snapshots while running', () => {
    start()
    messages = []
    advance(500)
    expect(frames()).toHaveLength(5)
    expect(frames()[4].timer.status).toBe('running')
  })
  it('posts completion when countdown reaches zero', () => {
    start(1)
    advance(1000)
    expect(latest.timer).toMatchObject({
      status: 'stopped',
      phase: 'overtime',
      remainingSeconds: 0
    })
  })
  it('keeps an extended run alive past the old deadline and completes once', () => {
    start(1)
    command({ type: 'addTime', seconds: 2 })
    advance(1500)
    expect(latest.timer).toMatchObject({ status: 'running', remainingSeconds: 2 })
    advance(3000)
    expect(frames().filter((frame) => frame.timer.phase === 'overtime')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps the stopwatch ticking after the countdown resets', () => {
    start()
    command({ type: 'startStopwatch' })
    command({ type: 'reset' })
    messages = []
    advance(500)
    expect(latest.stopwatch.elapsedMs).toBe(500)
    expect(frames()).toHaveLength(5)
  })
  it('clamps progress between zero and one', () => {
    start()
    command({ type: 'addTime', seconds: 20 })
    expect(latest.timer.progress).toBe(1)
    command({ type: 'removeTime', seconds: 30 })
    expect(latest.timer.progress).toBe(0)
  })
  it('stops posting snapshots after pause', () => {
    start()
    command({ type: 'pause' })
    messages = []
    advance(1000)
    expect(frames()).toEqual([])
  })
})
describe('stopwatch lifecycle', () => {
  it('sets stopwatch status to running on start', () => {
    command({ type: 'startStopwatch' })
    expect(latest.stopwatch.status).toBe('running')
  })
  it('restarts accumulated time when explicitly starting a paused stopwatch', () => {
    command({ type: 'startStopwatch' })
    advance(500)
    command({ type: 'pauseStopwatch' })
    command({ type: 'startStopwatch' })
    expect(latest.stopwatch.elapsedMs).toBe(0)
  })
  it('owns the stopwatch anchor without serializing it', () => {
    command({ type: 'startStopwatch' })
    advance(100)
    expect(latest.stopwatch.elapsedMs).toBe(100)
    expect(latest.stopwatch).not.toHaveProperty('startTimestamp')
  })
  it('posts stopwatch elapsed time while running', () => {
    command({ type: 'startStopwatch' })
    advance(300)
    expect(latest.stopwatch.elapsedMs).toBe(300)
  })
  it('pause samples elapsed time and sets status paused', () => {
    command({ type: 'startStopwatch' })
    advance(1250)
    command({ type: 'pauseStopwatch' })
    expect(latest.stopwatch).toMatchObject({ status: 'paused', elapsedMs: 1250 })
  })
  it('pause does nothing if not running', () => {
    command({ type: 'pauseStopwatch' })
    expect(latest.stopwatch.status).toBe('stopped')
  })
  it('resume continues from accumulated time', () => {
    command({ type: 'startStopwatch' })
    advance(1250)
    command({ type: 'pauseStopwatch' })
    advance(5000)
    command({ type: 'resumeStopwatch' })
    advance(1000)
    expect(latest.stopwatch.elapsedMs).toBe(2250)
  })
  it('resume does nothing if not paused', () => {
    command({ type: 'resumeStopwatch' })
    expect(latest.stopwatch.status).toBe('stopped')
  })
  it('reset clears all stopwatch runtime state', () => {
    command({ type: 'startStopwatch' })
    advance(500)
    command({ type: 'resetStopwatch' })
    expect(latest.stopwatch).toMatchObject({ status: 'stopped', elapsedMs: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('elapsed time accumulates across pause and resume', () => {
    command({ type: 'startStopwatch' })
    advance(2000)
    command({ type: 'pauseStopwatch' })
    advance(5000)
    command({ type: 'resumeStopwatch' })
    advance(3000)
    expect(latest.stopwatch.elapsedMs).toBe(5000)
  })
})
describe('countdown and stopwatch concurrent', () => {
  it('shares one interval for both running clocks', () => {
    start()
    command({ type: 'startStopwatch' })
    expect(vi.getTimerCount()).toBe(1)
  })
  it('keeps interval alive for stopwatch after countdown reset', () => {
    start()
    command({ type: 'startStopwatch' })
    command({ type: 'reset' })
    expect(vi.getTimerCount()).toBe(1)
  })
  it('posts both clock states in the same snapshot', () => {
    start()
    command({ type: 'startStopwatch' })
    advance(1000)
    expect(latest.timer.remainingSeconds).toBe(9)
    expect(latest.stopwatch.elapsedMs).toBe(1000)
  })
})
describe('transport validation and disposal', () => {
  it.each([null, { type: 'command', requestId: 0 }, { type: 'command', requestId: NaN }])(
    'ignores invalid request identity: %j',
    (message) => {
      messages = []
      host.handleMessage(message)
      expect(messages).toEqual([])
    }
  )
  it('rejects invalid commands without mutating the host', () => {
    const before = latest
    host.handleMessage({
      type: 'command',
      requestId: ++requestId,
      command: { type: 'addTime', seconds: NaN }
    })
    expect(messages.at(-1)).toMatchObject({
      type: 'result',
      result: { status: 'rejected', reason: 'invalid-command' }
    })
    expect(latest).toBe(before)
  })
  it('rejects invalid bootstrap configuration', () => {
    host.handleMessage({ type: 'initialize', requestId: ++requestId, configuration: {} })
    expect(messages.at(-1)).toMatchObject({
      result: { status: 'rejected', reason: 'invalid-configuration' }
    })
  })
  it('cannot restart a disposed Worker host', () => {
    start()
    host.dispose()
    messages = []
    command({ type: 'start' })
    advance(1000)
    expect(messages).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
