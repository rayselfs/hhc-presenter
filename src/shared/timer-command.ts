import { MAX_DURATION_SECONDS } from './constants/timer'
import type {
  TimerCommand,
  TimerMode,
  TimerRuntimeCommand,
  TimerRuntimeConfiguration,
  TimerSettings
} from './types/timer'

const TIMER_COMMAND_TYPES = new Set([
  'start',
  'pause',
  'resume',
  'reset',
  'setDuration',
  'addTime',
  'removeTime',
  'setMode',
  'setReminder',
  'setOvertimeMessage',
  'startStopwatch',
  'pauseStopwatch',
  'resetStopwatch'
])

const TIMER_MODES = new Set<TimerMode>(['timer', 'clock', 'both', 'stopwatch'])

export function isTimerMode(value: unknown): value is TimerMode {
  return typeof value === 'string' && TIMER_MODES.has(value as TimerMode)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validTimerSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_DURATION_SECONDS
  )
}

export function parseTimerCommand(value: unknown): TimerCommand | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !TIMER_COMMAND_TYPES.has(value.type)) {
    return null
  }

  switch (value.type) {
    case 'start':
    case 'pause':
    case 'resume':
    case 'reset':
    case 'startStopwatch':
    case 'pauseStopwatch':
    case 'resetStopwatch':
      return { type: value.type }
    case 'setDuration':
    case 'addTime':
    case 'removeTime':
      return validTimerSeconds(value.seconds) ? { type: value.type, seconds: value.seconds } : null
    case 'setMode':
      return isTimerMode(value.mode) ? { type: 'setMode', mode: value.mode } : null
    case 'setReminder':
      return typeof value.enabled === 'boolean' && validTimerSeconds(value.durationSeconds)
        ? {
            type: 'setReminder',
            enabled: value.enabled,
            durationSeconds: value.durationSeconds
          }
        : null
    case 'setOvertimeMessage':
      return typeof value.enabled === 'boolean' &&
        typeof value.message === 'string' &&
        value.message.length <= 1000
        ? { type: 'setOvertimeMessage', enabled: value.enabled, message: value.message }
        : null
    default:
      return null
  }
}

export function validateTimerSettings(value: unknown): value is TimerSettings {
  return (
    isRecord(value) &&
    isTimerMode(value.mode) &&
    validTimerSeconds(value.totalDuration) &&
    typeof value.reminderEnabled === 'boolean' &&
    validTimerSeconds(value.reminderDuration) &&
    typeof value.reminderColor === 'string' &&
    typeof value.overtimeMessageEnabled === 'boolean' &&
    typeof value.overtimeMessage === 'string'
  )
}

export function parseTimerRuntimeConfiguration(value: unknown): TimerRuntimeConfiguration | null {
  if (
    !isRecord(value) ||
    !validateTimerSettings(value.settings) ||
    (value.reminderMode !== 'subtract' && value.reminderMode !== 'add')
  )
    return null
  const settings = value.settings
  return {
    settings: {
      mode: settings.mode,
      totalDuration: settings.totalDuration,
      reminderEnabled: settings.reminderEnabled,
      reminderDuration: settings.reminderDuration,
      reminderColor: settings.reminderColor,
      overtimeMessageEnabled: settings.overtimeMessageEnabled,
      overtimeMessage: settings.overtimeMessage
    },
    reminderMode: value.reminderMode
  }
}

export function parseTimerRuntimeCommand(value: unknown): TimerRuntimeCommand | null {
  if (!isRecord(value)) return null
  if (value.type === 'resumeStopwatch') return { type: 'resumeStopwatch' }
  if (value.type === 'setReminderMode') {
    return value.mode === 'subtract' || value.mode === 'add'
      ? { type: 'setReminderMode', mode: value.mode }
      : null
  }
  const command = parseTimerCommand(value)
  if (command?.type !== 'setReminder') return command
  if (value.color !== undefined && typeof value.color !== 'string') return null
  return { ...command, ...(value.color !== undefined ? { color: value.color } : {}) }
}
