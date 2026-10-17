import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getState,
  handleAddTime,
  handlePause,
  handlePauseStopwatch,
  handleRemoveTime,
  handleReset,
  handleResetStopwatch,
  handleResume,
  handleResumeStopwatch,
  handleStart,
  handleStartStopwatch,
  resetPostMessageFn,
  resetStateForTesting,
  setPostMessageFn,
  type WorkerOutgoingMessage
} from '../timer.worker'

let posted: WorkerOutgoingMessage[]

beforeEach(() => {
  vi.useFakeTimers()
  resetStateForTesting()
  posted = []
  setPostMessageFn((msg) => posted.push(msg))
})

afterEach(() => {
  resetPostMessageFn()
  vi.useRealTimers()
})

describe('handleStart', () => {
  it('sets status to running', () => {
    handleStart(5000)
    expect(getState().status).toBe('running')
  })

  it('sets targetEndTime approximately now + durationMs', () => {
    const before = Date.now()
    handleStart(5000)
    const after = Date.now()
    const { targetEndTime } = getState()
    expect(targetEndTime).toBeGreaterThanOrEqual(before + 5000)
    expect(targetEndTime).toBeLessThanOrEqual(after + 5000)
  })

  it('stores totalDurationMs', () => {
    handleStart(10000)
    expect(getState().totalDurationMs).toBe(10000)
  })

  it('stores remainingAtPause equal to durationMs', () => {
    handleStart(3000)
    expect(getState().remainingAtPause).toBe(3000)
  })

  it('starts the interval', () => {
    handleStart(5000)
    expect(getState().intervalId).not.toBeNull()
  })

  it('replaces an existing interval when called again', () => {
    handleStart(5000)
    const firstId = getState().intervalId
    handleStart(8000)
    const secondId = getState().intervalId
    expect(secondId).not.toBeNull()
    expect(getState().totalDurationMs).toBe(8000)
    expect(firstId).not.toBe(secondId)
  })
})

describe('handlePause', () => {
  it('sets status to paused when running', () => {
    handleStart(5000)
    handlePause()
    expect(getState().status).toBe('paused')
  })

  it('captures remainingAtPause from targetEndTime', () => {
    vi.setSystemTime(1000)
    handleStart(5000)
    vi.setSystemTime(2000)
    handlePause()
    const { remainingAtPause } = getState()
    expect(remainingAtPause).toBeCloseTo(4000, -1)
  })

  it('does nothing if not running', () => {
    handleStart(5000)
    handlePause()
    handlePause()
    expect(getState().status).toBe('paused')
  })

  it('does nothing if stopped', () => {
    expect(getState().status).toBe('stopped')
    handlePause()
    expect(getState().status).toBe('stopped')
  })
})

describe('handleResume', () => {
  it('sets status to running from paused', () => {
    handleStart(5000)
    handlePause()
    handleResume()
    expect(getState().status).toBe('running')
  })

  it('recalculates targetEndTime using remainingAtPause', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    vi.setSystemTime(1000)
    handlePause()
    vi.setSystemTime(2000)
    handleResume()
    const { targetEndTime, remainingAtPause } = getState()
    expect(targetEndTime).toBeCloseTo(2000 + remainingAtPause, -1)
  })

  it('does nothing if not paused', () => {
    expect(getState().status).toBe('stopped')
    handleResume()
    expect(getState().status).toBe('stopped')
  })

  it('restarts the interval', () => {
    handleStart(5000)
    handlePause()
    handleResume()
    expect(getState().intervalId).not.toBeNull()
  })
})

describe('handleReset', () => {
  it('sets status to stopped', () => {
    handleStart(5000)
    handleReset()
    expect(getState().status).toBe('stopped')
  })

  it('clears targetEndTime', () => {
    handleStart(5000)
    handleReset()
    expect(getState().targetEndTime).toBeNull()
  })

  it('clears the interval', () => {
    handleStart(5000)
    handleReset()
    expect(getState().intervalId).toBeNull()
  })

  it('resets remainingAtPause and totalDurationMs', () => {
    handleStart(5000)
    handleReset()
    expect(getState().remainingAtPause).toBe(0)
    expect(getState().totalDurationMs).toBe(0)
  })
})

describe('handleAddTime', () => {
  it('adds to remainingAtPause when stopped', () => {
    handleAddTime(3000)
    expect(getState().remainingAtPause).toBe(3000)
  })

  it('adds to targetEndTime when running', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    const before = getState().targetEndTime!
    handleAddTime(2000)
    expect(getState().targetEndTime).toBe(before + 2000)
  })

  it('adds to remainingAtPause when paused', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    vi.setSystemTime(1000)
    handlePause()
    const before = getState().remainingAtPause
    handleAddTime(1000)
    expect(getState().remainingAtPause).toBe(before + 1000)
  })
})

describe('handleRemoveTime', () => {
  it('removes from remainingAtPause when stopped, min 0', () => {
    handleRemoveTime(3000)
    expect(getState().remainingAtPause).toBe(0)
  })

  it('removes from remainingAtPause when paused, min 0', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    vi.setSystemTime(1000)
    handlePause()
    handleRemoveTime(99999)
    expect(getState().remainingAtPause).toBe(0)
  })

  it('removes from targetEndTime when running', () => {
    vi.setSystemTime(0)
    handleStart(10000)
    const before = getState().targetEndTime!
    handleRemoveTime(2000)
    expect(getState().targetEndTime).toBe(before - 2000)
    expect(getState().status).toBe('running')
  })

  it('triggers finished when running and time removed past zero', () => {
    vi.setSystemTime(0)
    handleStart(100)
    vi.setSystemTime(50)
    handleRemoveTime(10000)
    expect(posted).toContainEqual({ type: 'finished' })
    expect(getState().status).toBe('running')
  })
})

describe('tick behavior via setInterval', () => {
  it('posts tick messages while running', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    vi.advanceTimersByTime(300)
    const ticks = posted.filter((m) => m.type === 'tick')
    expect(ticks.length).toBeGreaterThanOrEqual(2)
  })

  it('posts finished when countdown reaches zero', () => {
    vi.setSystemTime(0)
    handleStart(500)
    vi.advanceTimersByTime(600)
    expect(posted).toContainEqual({ type: 'finished' })
  })

  it('keeps heartbeat ticks after zero and reports finished once until reset', () => {
    handleStart(0)
    vi.advanceTimersByTime(1_000)
    expect(posted.filter((message) => message.type === 'finished')).toHaveLength(1)
    expect(posted.filter((message) => message.type === 'tick')).toHaveLength(10)
    expect(posted.at(-1)).toEqual({ type: 'tick', remainingMs: 0, progress: 0 })
    handleReset()
    const count = posted.length
    vi.advanceTimersByTime(1_000)
    expect(posted).toHaveLength(count)
  })

  it('keeps the stopwatch ticking after the countdown heartbeat is reset', () => {
    handleStart(100)
    handleStartStopwatch()
    vi.advanceTimersByTime(1_000)
    handleReset()
    const countdownTicks = posted.filter((message) => message.type === 'tick').length
    vi.advanceTimersByTime(1_000)
    expect(posted.filter((message) => message.type === 'tick')).toHaveLength(countdownTicks)
    expect(posted.at(-1)).toEqual({ type: 'stopwatchTick', elapsedMs: 2_000 })
    handleResetStopwatch()
    expect(getState().intervalId).toBeNull()
  })

  it('tick progress is clamped between 0 and 1', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    vi.advanceTimersByTime(100)
    const ticks = posted.filter((m) => m.type === 'tick')
    for (const msg of ticks) {
      if (msg.type === 'tick') {
        expect(msg.progress).toBeGreaterThanOrEqual(0)
        expect(msg.progress).toBeLessThanOrEqual(1)
      }
    }
  })

  it('stops posting tick after pause', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    vi.advanceTimersByTime(200)
    handlePause()
    const countBefore = posted.filter((m) => m.type === 'tick').length
    vi.advanceTimersByTime(500)
    const countAfter = posted.filter((m) => m.type === 'tick').length
    expect(countAfter).toBe(countBefore)
  })
})

describe('stopwatch lifecycle', () => {
  it('sets stopwatchStatus to running on startStopwatch', () => {
    handleStartStopwatch()
    expect(getState().stopwatchStatus).toBe('running')
  })

  it('resets accumulated time on startStopwatch', () => {
    vi.setSystemTime(0)
    handleStartStopwatch()
    vi.advanceTimersByTime(2000)
    handleResetStopwatch()
    handleStartStopwatch()
    expect(getState().stopwatchAccumulatedMs).toBe(0)
  })

  it('sets stopwatchStartTime on startStopwatch', () => {
    vi.setSystemTime(5000)
    handleStartStopwatch()
    expect(getState().stopwatchStartTime).toBe(5000)
  })

  it('posts stopwatchTick while running', () => {
    vi.setSystemTime(0)
    handleStartStopwatch()
    vi.advanceTimersByTime(300)
    const swTicks = posted.filter((m) => m.type === 'stopwatchTick')
    expect(swTicks.length).toBeGreaterThanOrEqual(2)
  })

  it('pauseStopwatch accumulates elapsed and sets status paused', () => {
    vi.setSystemTime(0)
    handleStartStopwatch()
    vi.setSystemTime(3000)
    handlePauseStopwatch()
    expect(getState().stopwatchStatus).toBe('paused')
    expect(getState().stopwatchAccumulatedMs).toBeCloseTo(3000, -1)
  })

  it('pauseStopwatch does nothing if not running', () => {
    expect(getState().stopwatchStatus).toBe('stopped')
    handlePauseStopwatch()
    expect(getState().stopwatchStatus).toBe('stopped')
  })

  it('resumeStopwatch continues from accumulated time', () => {
    vi.setSystemTime(0)
    handleStartStopwatch()
    vi.setSystemTime(2000)
    handlePauseStopwatch()
    vi.setSystemTime(5000)
    handleResumeStopwatch()
    expect(getState().stopwatchStatus).toBe('running')
    expect(getState().stopwatchStartTime).toBe(5000)
    expect(getState().stopwatchAccumulatedMs).toBeCloseTo(2000, -1)
  })

  it('resumeStopwatch does nothing if not paused', () => {
    handleResumeStopwatch()
    expect(getState().stopwatchStatus).toBe('stopped')
  })

  it('resetStopwatch clears all stopwatch state', () => {
    vi.setSystemTime(0)
    handleStartStopwatch()
    vi.advanceTimersByTime(1000)
    handleResetStopwatch()
    expect(getState().stopwatchStatus).toBe('stopped')
    expect(getState().stopwatchAccumulatedMs).toBe(0)
    expect(getState().stopwatchStartTime).toBeNull()
  })

  it('stopwatch tick elapsedMs accumulates across pause/resume', () => {
    vi.setSystemTime(0)
    handleStartStopwatch()
    vi.setSystemTime(2000)
    handlePauseStopwatch()
    vi.setSystemTime(5000)
    handleResumeStopwatch()
    vi.advanceTimersByTime(1100)
    const swTicks = posted.filter((m) => m.type === 'stopwatchTick')
    const last = swTicks[swTicks.length - 1]
    if (last?.type === 'stopwatchTick') {
      expect(last.elapsedMs).toBeGreaterThanOrEqual(3000)
      expect(last.elapsedMs).toBeLessThan(3200)
    }
  })
})

describe('countdown + stopwatch concurrent', () => {
  it('shares a single interval when both are running', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    handleStartStopwatch()
    expect(getState().intervalId).not.toBeNull()
  })

  it('keeps interval alive while stopwatch runs after countdown resets', () => {
    handleStart(5000)
    handleStartStopwatch()
    handleReset()
    expect(getState().intervalId).not.toBeNull()
    expect(getState().stopwatchStatus).toBe('running')
  })

  it('posts both tick and stopwatchTick in the same interval period', () => {
    vi.setSystemTime(0)
    handleStart(5000)
    handleStartStopwatch()
    vi.advanceTimersByTime(100)
    expect(posted.some((m) => m.type === 'tick')).toBe(true)
    expect(posted.some((m) => m.type === 'stopwatchTick')).toBe(true)
  })
})
