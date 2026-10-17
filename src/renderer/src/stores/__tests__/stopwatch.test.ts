import { installTimerRuntimeHarness } from '@renderer/test/timer-runtime-harness'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { selectFormattedTime, selectElapsedSeconds } from '@renderer/stores/selectors/stopwatch'
import type { StopwatchStatus } from '@shared/types/timer'

const INITIAL_STATE = {
  status: 'stopped' as StopwatchStatus,
  elapsedMs: 0
}

let host: ReturnType<typeof installTimerRuntimeHarness>
beforeEach(() => {
  useStopwatchStore.setState(INITIAL_STATE)
  host = installTimerRuntimeHarness()
})
afterEach(() => host.dispose())

describe('initial state', () => {
  it('starts stopped with 0ms elapsed', () => {
    const s = useStopwatchStore.getState()
    expect(s.status).toBe('stopped')
    expect(s.elapsedMs).toBe(0)
    expect(s).not.toHaveProperty('startTimestamp')
    expect(s).not.toHaveProperty('accumulatedMs')
    expect(selectFormattedTime(s)).toBe('00:00')
    expect(selectElapsedSeconds(s)).toBe(0)
  })
})

describe('selectors', () => {
  it('isStopped() returns true initially', () => {
    expect(useStopwatchStore.getState().isStopped()).toBe(true)
  })

  it('isRunning() returns false initially', () => {
    expect(useStopwatchStore.getState().isRunning()).toBe(false)
  })

  it('isPaused() returns false initially', () => {
    expect(useStopwatchStore.getState().isPaused()).toBe(false)
  })
})

describe('start()', () => {
  it('transitions from stopped to running', () => {
    useStopwatchStore.getState().start()
    expect(useStopwatchStore.getState().status).toBe('running')
  })

  it('uses the host clock without exposing its anchor', () => {
    useStopwatchStore.getState().start()
    host.advance(1250)
    expect(useStopwatchStore.getState().elapsedMs).toBe(1250)
    expect(useStopwatchStore.getState()).not.toHaveProperty('startTimestamp')
  })

  it('resets elapsed to 0 on start', () => {
    useStopwatchStore.getState().start()
    host.advance(5000)
    useStopwatchStore.getState().pause()
    useStopwatchStore.getState().start()
    expect(useStopwatchStore.getState().elapsedMs).toBe(0)
    expect(useStopwatchStore.getState()).not.toHaveProperty('accumulatedMs')
    expect(selectFormattedTime(useStopwatchStore.getState())).toBe('00:00')
  })

  it('is a no-op when already running', () => {
    useStopwatchStore.getState().start()
    host.advance(1000)
    useStopwatchStore.getState().start()
    host.advance(1000)
    expect(useStopwatchStore.getState().elapsedMs).toBe(2000)
  })

  it('sets isRunning() to true', () => {
    useStopwatchStore.getState().start()
    expect(useStopwatchStore.getState().isRunning()).toBe(true)
  })
})

describe('pause()', () => {
  it('transitions from running to paused', () => {
    useStopwatchStore.getState().start()
    useStopwatchStore.getState().pause()
    expect(useStopwatchStore.getState().status).toBe('paused')
  })

  it('preserves elapsed time on pause', () => {
    useStopwatchStore.getState().start()
    host.advance(2000)
    useStopwatchStore.getState().pause()
    const s = useStopwatchStore.getState()
    expect(s.elapsedMs).toBeGreaterThanOrEqual(2000)
    expect(s).not.toHaveProperty('startTimestamp')
  })

  it('is a no-op when already paused', () => {
    useStopwatchStore.getState().start()
    useStopwatchStore.getState().pause()
    const elapsed1 = useStopwatchStore.getState().elapsedMs
    useStopwatchStore.getState().pause()
    expect(useStopwatchStore.getState().elapsedMs).toBe(elapsed1)
    expect(useStopwatchStore.getState().status).toBe('paused')
  })

  it('is a no-op when stopped', () => {
    useStopwatchStore.getState().pause()
    expect(useStopwatchStore.getState().status).toBe('stopped')
  })

  it('sets isPaused() to true', () => {
    useStopwatchStore.getState().start()
    useStopwatchStore.getState().pause()
    expect(useStopwatchStore.getState().isPaused()).toBe(true)
  })
})

describe('resume()', () => {
  it('transitions from paused to running', () => {
    useStopwatchStore.getState().start()
    useStopwatchStore.getState().pause()
    useStopwatchStore.getState().resume()
    expect(useStopwatchStore.getState().status).toBe('running')
  })

  it('resumes against the host clock without counting paused time', () => {
    useStopwatchStore.getState().start()
    host.advance(1000)
    useStopwatchStore.getState().pause()
    host.advance(5000)
    useStopwatchStore.getState().resume()
    host.advance(1000)
    expect(useStopwatchStore.getState().elapsedMs).toBe(2000)
    expect(useStopwatchStore.getState()).not.toHaveProperty('startTimestamp')
  })

  it('is a no-op when already running', () => {
    useStopwatchStore.getState().start()
    host.advance(1000)
    useStopwatchStore.getState().resume()
    host.advance(1000)
    expect(useStopwatchStore.getState().status).toBe('running')
    expect(useStopwatchStore.getState().elapsedMs).toBe(2000)
  })

  it('is a no-op when stopped', () => {
    useStopwatchStore.getState().resume()
    expect(useStopwatchStore.getState().status).toBe('stopped')
  })
})

describe('reset()', () => {
  it('transitions from stopped to stopped', () => {
    useStopwatchStore.getState().reset()
    expect(useStopwatchStore.getState().status).toBe('stopped')
  })

  it('stops and clears elapsed when running', () => {
    useStopwatchStore.getState().start()
    host.advance(5000)
    useStopwatchStore.getState().reset()
    host.advance(1000)
    const s = useStopwatchStore.getState()
    expect(s.status).toBe('stopped')
    expect(s.elapsedMs).toBe(0)
    expect(s).not.toHaveProperty('accumulatedMs')
    expect(s).not.toHaveProperty('startTimestamp')
    expect(selectFormattedTime(s)).toBe('00:00')
    expect(selectElapsedSeconds(s)).toBe(0)
  })

  it('stops and clears elapsed when paused', () => {
    useStopwatchStore.getState().start()
    useStopwatchStore.getState().pause()
    useStopwatchStore.getState().reset()
    const s = useStopwatchStore.getState()
    expect(s.status).toBe('stopped')
    expect(s.elapsedMs).toBe(0)
    expect(selectFormattedTime(s)).toBe('00:00')
  })

  it('sets isStopped() to true after reset from any state', () => {
    useStopwatchStore.getState().start()
    useStopwatchStore.getState().reset()
    expect(useStopwatchStore.getState().isStopped()).toBe(true)
  })
})

describe('tick()', () => {
  it('updates elapsedMs when running', () => {
    useStopwatchStore.getState().start()
    host.advance(3000)
    expect(useStopwatchStore.getState().elapsedMs).toBe(3000)
  })

  it('is a no-op when paused', () => {
    useStopwatchStore.getState().start()
    host.advance(1000)
    useStopwatchStore.getState().pause()
    const elapsedAfterPause = useStopwatchStore.getState().elapsedMs
    host.advance(4000)
    expect(useStopwatchStore.getState().elapsedMs).toBe(elapsedAfterPause)
  })

  it('is a no-op when stopped', () => {
    host.advance(10000)
    expect(useStopwatchStore.getState().elapsedMs).toBe(0)
  })

  it('accumulates correctly across pause/resume', () => {
    useStopwatchStore.getState().start()
    host.advance(2000)
    useStopwatchStore.getState().pause()
    expect(useStopwatchStore.getState().elapsedMs).toBeGreaterThanOrEqual(2000)
    host.advance(4000)
    useStopwatchStore.getState().resume()
    host.advance(3000)
    expect(useStopwatchStore.getState().elapsedMs).toBeGreaterThanOrEqual(5000)
  })

  it('updates elapsedSeconds correctly', () => {
    useStopwatchStore.getState().start()
    host.advance(4500)
    expect(selectElapsedSeconds(useStopwatchStore.getState())).toBe(4)
  })
})

describe('formattedTime', () => {
  it('shows 00:00 at 0ms', () => {
    expect(selectFormattedTime(useStopwatchStore.getState())).toBe('00:00')
  })

  it('shows 00:01 at 1000ms', () => {
    useStopwatchStore.getState().start()
    host.advance(1000)

    expect(selectFormattedTime(useStopwatchStore.getState())).toBe('00:01')
  })

  it('shows 01:30 at 90500ms', () => {
    useStopwatchStore.getState().start()
    host.advance(90500)

    expect(selectFormattedTime(useStopwatchStore.getState())).toBe('01:30')
  })

  it('shows 61:01 at 3661234ms (no hours, just keeps counting minutes)', () => {
    useStopwatchStore.getState().start()
    host.advance(3661234)

    expect(selectFormattedTime(useStopwatchStore.getState())).toBe('61:01')
  })

  it('updates formattedTime on tick', () => {
    useStopwatchStore.getState().start()
    host.advance(500)

    expect(selectFormattedTime(useStopwatchStore.getState())).toBe('00:00')
  })

  it('preserves formattedTime after pause', () => {
    useStopwatchStore.getState().start()
    host.advance(2500)
    useStopwatchStore.getState().pause()
    expect(selectFormattedTime(useStopwatchStore.getState())).toBe('00:02')
  })
})
