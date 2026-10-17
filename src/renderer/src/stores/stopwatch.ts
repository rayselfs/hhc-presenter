import { create } from 'zustand'
import type { StopwatchStatus, TimerRuntimeResult } from '@shared/types/timer'
import { executeTimerRuntimeCommand } from '@renderer/lib/timer-runtime-client'

export interface StopwatchStore {
  status: StopwatchStatus
  elapsedMs: number
  showOnProjection: boolean
  isRunning: () => boolean
  isPaused: () => boolean
  isStopped: () => boolean
  start: () => Promise<TimerRuntimeResult>
  pause: () => Promise<TimerRuntimeResult>
  resume: () => Promise<TimerRuntimeResult>
  reset: () => Promise<TimerRuntimeResult>
  setShowOnProjection: (show: boolean) => void
}

export const useStopwatchStore = create<StopwatchStore>()((set, get) => ({
  status: 'stopped',
  elapsedMs: 0,
  showOnProjection: false,
  isRunning: () => get().status === 'running',
  isPaused: () => get().status === 'paused',
  isStopped: () => get().status === 'stopped',
  start: () => {
    return executeTimerRuntimeCommand({ type: 'startStopwatch' })
  },
  pause: () => {
    return executeTimerRuntimeCommand({ type: 'pauseStopwatch' })
  },
  resume: () => {
    return executeTimerRuntimeCommand({ type: 'resumeStopwatch' })
  },
  reset: () => {
    return executeTimerRuntimeCommand({ type: 'resetStopwatch' })
  },
  setShowOnProjection: (showOnProjection) => {
    set({ showOnProjection })
  }
}))
