import { create } from 'zustand'
import { formatTimerTime } from '@shared/timer-time-rules'
import { MAX_DURATION_SECONDS } from '@shared/constants/timer'
import type { TimerMode, TimerState, TimerRuntimeResult } from '@shared/types/timer'
import { executeTimerRuntimeCommand } from '@renderer/lib/timer-runtime-client'
import { useTimerConfigStore } from './timer-config'

export { computePhase, computeProgress } from '@shared/timer-time-rules'
export { formatTimerTime as formatTime } from '@shared/timer-time-rules'

export const DEFAULT_STATE: TimerState = {
  status: 'stopped',
  remainingSeconds: 300,
  phase: 'idle',
  overtimeSeconds: 0,
  progress: 1,
  formattedTime: '05:00'
}

export interface TimerRuntimeState extends TimerState {
  hostRevision: number
  isRunning: () => boolean
  isPaused: () => boolean
  isStopped: () => boolean
  isWarning: () => boolean
  isOvertime: () => boolean
  start: () => Promise<TimerRuntimeResult>
  pause: () => Promise<TimerRuntimeResult>
  resume: () => Promise<TimerRuntimeResult>
  reset: () => Promise<TimerRuntimeResult>
  setDuration: (seconds: number) => Promise<TimerRuntimeResult>
  addTime: (seconds: number) => Promise<TimerRuntimeResult>
  removeTime: (seconds: number) => Promise<TimerRuntimeResult>
  setMode: (mode: TimerMode) => Promise<TimerRuntimeResult>
  setReminder: (
    enabled: boolean,
    durationSeconds: number,
    color?: string
  ) => Promise<TimerRuntimeResult>
  applyPreset: (id: string) => Promise<TimerRuntimeResult>
}

export const useTimerRuntimeStore = create<TimerRuntimeState>()((_set, get) => ({
  ...DEFAULT_STATE,
  remainingSeconds: useTimerConfigStore.getState().totalDuration,
  formattedTime: formatTimerTime(useTimerConfigStore.getState().totalDuration),
  hostRevision: -1,
  isRunning: () => get().status === 'running',
  isPaused: () => get().status === 'paused',
  isStopped: () => get().status === 'stopped',
  isWarning: () => get().phase === 'warning',
  isOvertime: () => get().phase === 'overtime',
  start: () => {
    return executeTimerRuntimeCommand({ type: 'start' })
  },
  pause: () => {
    return executeTimerRuntimeCommand({ type: 'pause' })
  },
  resume: () => {
    return executeTimerRuntimeCommand({ type: 'resume' })
  },
  reset: () => {
    return executeTimerRuntimeCommand({ type: 'reset' })
  },
  setDuration: (seconds) => {
    return executeTimerRuntimeCommand({
      type: 'setDuration',
      seconds: Math.max(0, Math.min(MAX_DURATION_SECONDS, seconds))
    })
  },
  addTime: (seconds) => {
    return executeTimerRuntimeCommand({ type: 'addTime', seconds })
  },
  removeTime: (seconds) => {
    return executeTimerRuntimeCommand({ type: 'removeTime', seconds })
  },
  setMode: (mode) => {
    return executeTimerRuntimeCommand({ type: 'setMode', mode })
  },
  setReminder: (enabled, durationSeconds, color) => {
    return executeTimerRuntimeCommand({
      type: 'setReminder',
      enabled,
      durationSeconds,
      ...(color !== undefined ? { color } : {})
    })
  },
  applyPreset: (id) => {
    const preset = useTimerConfigStore.getState().presets.find((entry) => entry.id === id)
    return preset
      ? get().setDuration(preset.durationSeconds)
      : Promise.resolve<TimerRuntimeResult>({ status: 'rejected', reason: 'invalid-command' })
  }
}))
