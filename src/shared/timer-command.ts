import { MAX_DURATION_SECONDS } from './constants/timer'
import type { TimerCommand, TimerMode } from './types/timer'

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
      return typeof value.mode === 'string' && TIMER_MODES.has(value.mode as TimerMode)
        ? { type: 'setMode', mode: value.mode as TimerMode }
        : null
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
