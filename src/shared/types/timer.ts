/**
 * Shared timer types for main process and renderer.
 * No runtime validation — types only.
 * Uses number for timestamps (IPC serialization safety).
 */

/**
 * Timer mode — string literal union (not enum for tree-shakability)
 */
export type TimerMode = 'timer' | 'clock' | 'both' | 'stopwatch'

/**
 * Timer status
 */
export type TimerStatus = 'running' | 'paused' | 'stopped'

/**
 * Stopwatch status
 */
export type StopwatchStatus = 'running' | 'paused' | 'stopped'

/**
 * Timer phase — distinguishes timer phase within a run.
 * Used for dual-countdown UX (main + warning/overtime)
 */
export type TimerPhase = 'idle' | 'main' | 'warning' | 'overtime'

/**
 * Timer settings — persistent configuration
 */
export interface TimerSettings {
  mode: TimerMode
  totalDuration: number
  reminderEnabled: boolean
  reminderDuration: number
  reminderColor: string
  overtimeMessageEnabled: boolean
  overtimeMessage: string
}

/**
 * Timer state — current runtime state
 */
export interface TimerState {
  status: TimerStatus
  remainingSeconds: number
  phase: TimerPhase
  overtimeSeconds: number
  progress: number
  formattedTime: string
}

/**
 * Stopwatch state — stopwatch runtime state
 */
export interface StopwatchState {
  status: StopwatchStatus
  elapsedMs: number
  formattedTime: string
}

/**
 * Timer preset — saved timer configuration
 */
export interface TimerPreset {
  id: string
  name: string
  durationSeconds: number
  mode: TimerMode
}

/**
 * Timer command — discriminated union for all timer actions
 */
export type TimerCommand =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'reset' }
  | { type: 'setDuration'; seconds: number }
  | { type: 'addTime'; seconds: number }
  | { type: 'removeTime'; seconds: number }
  | { type: 'setMode'; mode: TimerMode }
  | { type: 'setReminder'; enabled: boolean; durationSeconds: number }
  | { type: 'setOvertimeMessage'; enabled: boolean; message: string }
  | { type: 'startStopwatch' }
  | { type: 'pauseStopwatch' }
  | { type: 'resetStopwatch' }

/**
 * Timer tick payload — high-frequency update for display
 */
export interface TimerTickPayload {
  runtime?: TimerRuntimeSnapshot
  mode: TimerMode
  remainingSeconds: number
  phase: TimerPhase
  mainDisplay: string
  subDisplay: string | null
  progress: number
  overtimeSeconds: number
  overtimeMessage: string | null
  reminderColor: string | null
  /** Stopwatch elapsed time in ms — present when mode is 'stopwatch' */
  stopwatchElapsedMs?: number
  /** Stopwatch formatted time string — present when mode is 'stopwatch' */
  stopwatchFormattedTime?: string
}

/**
 * Timer sync payload — full state snapshot
 */
export interface TimerSyncPayload {
  settings: TimerSettings
  state: TimerState
  stopwatchState: StopwatchState
}

/**
 * Stopwatch tick payload — stopwatch update
 */
export interface StopwatchTickPayload {
  elapsedMs: number
  formattedTime: string
  status: StopwatchStatus
}

export interface TimerRuntimeConfiguration {
  settings: TimerSettings
  reminderMode: 'subtract' | 'add'
}

export interface TimerRuntimeSnapshot {
  revision: number
  configuration: TimerRuntimeConfiguration
  timer: TimerState
  stopwatch: StopwatchState
}

export type TimerRuntimeCommand =
  | Exclude<TimerCommand, { type: 'setReminder' }>
  | { type: 'setReminder'; enabled: boolean; durationSeconds: number; color?: string }
  | { type: 'setReminderMode'; mode: 'subtract' | 'add' }
  | { type: 'resumeStopwatch' }

export type TimerRuntimeResult =
  | { status: 'accepted'; snapshot: TimerRuntimeSnapshot }
  | {
      status: 'rejected'
      reason:
        | 'invalid-command'
        | 'invalid-configuration'
        | 'not-initialized'
        | 'unauthorized-sender'
        | 'host-unavailable'
        | 'disposed'
    }
