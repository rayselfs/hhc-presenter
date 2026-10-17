import { computeProgress, readCountdownAt } from '@shared/timer-time-rules'

/**
 * Web Worker timer engine
 * Runs setInterval(100) — not throttled in background tabs
 * The renderer runtime owns the final deadline; ticks continue until pause/reset.
 * No window, no document, no React imports
 */

// ─── Message Protocol ──────────────────────────────────────────────────────

export type WorkerIncomingMessage =
  | { type: 'start'; durationMs: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'reset' }
  | { type: 'addTime'; ms: number }
  | { type: 'removeTime'; ms: number }
  | { type: 'startStopwatch' }
  | { type: 'pauseStopwatch' }
  | { type: 'resumeStopwatch' }
  | { type: 'resetStopwatch' }

export type WorkerOutgoingMessage =
  | { type: 'tick'; remainingMs: number; progress: number }
  | { type: 'finished' }
  | { type: 'stopwatchTick'; elapsedMs: number }

// ─── postMessage abstraction ───────────────────────────────────────────────
// jsdom's self.postMessage (window.postMessage) requires targetOrigin.
// In a real Worker context it's fire-and-forget. We abstract it so tests
// can inject a simple spy without dealing with the window API signature.

let _postMessage: (msg: WorkerOutgoingMessage) => void = (msg) => {
  self.postMessage(msg)
}

export function setPostMessageFn(fn: (msg: WorkerOutgoingMessage) => void): void {
  _postMessage = fn
}

export function resetPostMessageFn(): void {
  _postMessage = (msg) => self.postMessage(msg)
}

// ─── State ─────────────────────────────────────────────────────────────────

interface TimerWorkerState {
  // Countdown timer
  intervalId: ReturnType<typeof setInterval> | null
  targetEndTime: number | null
  remainingAtPause: number
  totalDurationMs: number
  status: 'running' | 'paused' | 'stopped'
  hasFinished: boolean

  // Stopwatch
  stopwatchStatus: 'running' | 'paused' | 'stopped'
  stopwatchStartTime: number | null
  stopwatchAccumulatedMs: number
}

const state: TimerWorkerState = {
  intervalId: null,
  targetEndTime: null,
  remainingAtPause: 0,
  totalDurationMs: 0,
  status: 'stopped',
  hasFinished: false,

  stopwatchStatus: 'stopped',
  stopwatchStartTime: null,
  stopwatchAccumulatedMs: 0
}

// ─── Interval Management ───────────────────────────────────────────────────

function startInterval(): void {
  if (state.intervalId !== null) return
  state.intervalId = setInterval(tick, 100)
}

function stopInterval(): void {
  if (state.intervalId !== null) {
    clearInterval(state.intervalId)
    state.intervalId = null
  }
}

function needsInterval(): boolean {
  return state.status === 'running' || state.stopwatchStatus === 'running'
}

// ─── Tick ──────────────────────────────────────────────────────────────────

function tick(): void {
  tickCountdown()
  tickStopwatch()

  // If nothing is running anymore, stop the interval
  if (!needsInterval()) {
    stopInterval()
  }
}

function tickCountdown(): void {
  if (state.status !== 'running') return
  if (state.targetEndTime === null) return

  const { remainingMs } = readCountdownAt(state.targetEndTime, Date.now())

  if (remainingMs <= 0 && !state.hasFinished) {
    state.hasFinished = true
    _postMessage({ type: 'finished' })
  } else if (remainingMs > 0) {
    state.hasFinished = false
  }

  const progress = computeProgress(remainingMs, state.totalDurationMs)
  _postMessage({ type: 'tick', remainingMs: Math.max(0, remainingMs), progress })
}

function tickStopwatch(): void {
  if (state.stopwatchStatus !== 'running') return
  if (state.stopwatchStartTime === null) return

  const elapsedMs = state.stopwatchAccumulatedMs + (Date.now() - state.stopwatchStartTime)
  _postMessage({ type: 'stopwatchTick', elapsedMs })
}

// ─── Command Handlers ──────────────────────────────────────────────────────

export function handleStart(durationMs: number): void {
  stopInterval()
  state.hasFinished = false
  state.totalDurationMs = durationMs
  state.targetEndTime = Date.now() + durationMs
  state.remainingAtPause = durationMs
  state.status = 'running'
  startInterval()
}

export function handlePause(): void {
  if (state.status !== 'running') return
  const remaining = state.targetEndTime !== null ? state.targetEndTime - Date.now() : 0
  state.remainingAtPause = Math.max(0, remaining)
  state.status = 'paused'
  if (!needsInterval()) {
    stopInterval()
  }
}

export function handleResume(): void {
  if (state.status !== 'paused') return
  state.targetEndTime = Date.now() + state.remainingAtPause
  state.status = 'running'
  startInterval()
}

export function handleReset(): void {
  stopInterval()
  state.status = 'stopped'
  state.targetEndTime = null
  state.remainingAtPause = 0
  state.hasFinished = false
  state.totalDurationMs = 0
  if (needsInterval()) {
    startInterval()
  }
}

export function handleAddTime(ms: number): void {
  if (state.status === 'stopped') {
    state.remainingAtPause += ms
  } else if (state.status === 'running') {
    if (state.targetEndTime !== null) {
      state.targetEndTime += ms
    }
  } else if (state.status === 'paused') {
    state.remainingAtPause += ms
  }
}

export function handleRemoveTime(ms: number): void {
  if (state.status === 'stopped') {
    state.remainingAtPause = Math.max(0, state.remainingAtPause - ms)
  } else if (state.status === 'running') {
    if (state.targetEndTime !== null) {
      state.targetEndTime = Math.max(Date.now(), state.targetEndTime - ms)
      tickCountdown()
    }
  } else if (state.status === 'paused') {
    state.remainingAtPause = Math.max(0, state.remainingAtPause - ms)
  }
}

// ─── Stopwatch Command Handlers ────────────────────────────────────────────

export function handleStartStopwatch(): void {
  state.stopwatchAccumulatedMs = 0
  state.stopwatchStartTime = Date.now()
  state.stopwatchStatus = 'running'
  startInterval()
}

export function handlePauseStopwatch(): void {
  if (state.stopwatchStatus !== 'running') return
  if (state.stopwatchStartTime !== null) {
    state.stopwatchAccumulatedMs += Date.now() - state.stopwatchStartTime
  }
  state.stopwatchStatus = 'paused'
  if (!needsInterval()) {
    stopInterval()
  }
}

export function handleResumeStopwatch(): void {
  if (state.stopwatchStatus !== 'paused') return
  state.stopwatchStartTime = Date.now()
  state.stopwatchStatus = 'running'
  startInterval()
}

export function handleResetStopwatch(): void {
  state.stopwatchAccumulatedMs = 0
  state.stopwatchStartTime = null
  state.stopwatchStatus = 'stopped'
  if (!needsInterval()) {
    stopInterval()
  }
}

// ─── State accessor (for testing) ─────────────────────────────────────────

export function getState(): Readonly<TimerWorkerState> {
  return state
}

export function resetStateForTesting(): void {
  stopInterval()
  state.intervalId = null
  state.targetEndTime = null
  state.remainingAtPause = 0
  state.hasFinished = false
  state.totalDurationMs = 0
  state.status = 'stopped'
  state.stopwatchStatus = 'stopped'
  state.stopwatchStartTime = null
  state.stopwatchAccumulatedMs = 0
}

// ─── Message Handler ───────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerIncomingMessage>) => {
  const { data } = event
  switch (data.type) {
    case 'start':
      handleStart(data.durationMs)
      break
    case 'pause':
      handlePause()
      break
    case 'resume':
      handleResume()
      break
    case 'reset':
      handleReset()
      break
    case 'addTime':
      handleAddTime(data.ms)
      break
    case 'removeTime':
      handleRemoveTime(data.ms)
      break
    case 'startStopwatch':
      handleStartStopwatch()
      break
    case 'pauseStopwatch':
      handlePauseStopwatch()
      break
    case 'resumeStopwatch':
      handleResumeStopwatch()
      break
    case 'resetStopwatch':
      handleResetStopwatch()
      break
  }
}
