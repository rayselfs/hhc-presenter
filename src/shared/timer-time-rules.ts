import type { TimerStatus, TimerPhase } from './types/timer'

export function formatTimerTime(totalSeconds: number): string {
  const abs = Math.abs(Math.round(totalSeconds))
  const hours = Math.floor(abs / 3600)
  const minutes = Math.floor((abs % 3600) / 60)
  const seconds = abs % 60
  return `${hours > 0 ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function computePhase(
  status: TimerStatus,
  remainingSeconds: number,
  reminderEnabled: boolean,
  reminderDuration: number
): TimerPhase {
  if (status === 'stopped') return 'idle'
  if (remainingSeconds <= 0) return 'overtime'
  if (reminderEnabled && remainingSeconds <= reminderDuration) return 'warning'
  return 'main'
}

export function computeProgress(remainingDuration: number, totalDuration: number): number {
  if (totalDuration <= 0) return 0
  return Math.max(0, Math.min(1, remainingDuration / totalDuration))
}

export function readCountdownAt(
  deadlineMs: number,
  nowMs: number
): { remainingMs: number; remainingSeconds: number; overtimeSeconds: number } {
  const remainingMs = deadlineMs - nowMs
  const rawSeconds = remainingMs / 1000
  return {
    remainingMs,
    remainingSeconds: Math.max(0, Math.ceil(rawSeconds)),
    overtimeSeconds: rawSeconds <= 0 ? Math.abs(Math.floor(rawSeconds)) : 0
  }
}
