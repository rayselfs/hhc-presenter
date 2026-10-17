import { performance } from 'perf_hooks'
import { TimerRuntime } from '@shared/timer-runtime'
import type {
  TimerCommand,
  TimerSettings,
  TimerState,
  StopwatchState,
  TimerTickPayload,
  TimerRuntimeSnapshot,
  TimerRuntimeResult
} from '@shared/types/timer'
interface TimerWindow {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: 'timer-tick', payload: TimerTickPayload): void
  }
}

interface TimerWindows {
  getMainWindow(): TimerWindow | null
  getProjectionWindow(): TimerWindow | null
}

function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export class TimerService {
  private runtime = new TimerRuntime(() => performance.now())
  private intervalId: NodeJS.Timeout | null = null
  private intervalDelayMs: number | null = null
  private windowManager: TimerWindows | null = null
  private lastBroadcastRemaining = -1
  private lastBroadcastTime = 0

  private get settings(): TimerSettings {
    return this.runtime.getSnapshot().configuration.settings
  }

  setWindowManager(windowManager: TimerWindows): void {
    this.windowManager = windowManager
  }

  private syncInterval(): void {
    const snapshot = this.runtime.getSnapshot()
    const delay =
      snapshot.stopwatch.status === 'running'
        ? 100
        : snapshot.timer.status === 'running'
          ? 1000
          : null
    if (delay === this.intervalDelayMs) return
    this.stopInterval()
    if (delay === null) return
    this.intervalDelayMs = delay
    this.intervalId = setInterval(() => this.tick(), delay)
  }

  private stopInterval(): void {
    if (this.intervalId !== null) clearInterval(this.intervalId)
    this.intervalId = null
    this.intervalDelayMs = null
  }

  private tick(): void {
    const previous = this.runtime.getSnapshot()
    const snapshot = this.runtime.tick()
    this.syncInterval()
    const finished = previous.timer.status === 'running' && snapshot.timer.status === 'stopped'
    const secondChanged = snapshot.timer.remainingSeconds !== this.lastBroadcastRemaining
    const secondElapsed = performance.now() - this.lastBroadcastTime >= 1000
    const timerRunning = snapshot.timer.status === 'running'
    const stopwatchRunning = snapshot.stopwatch.status === 'running'
    if (
      (secondChanged || secondElapsed || stopwatchRunning || finished) &&
      (timerRunning || stopwatchRunning || finished)
    )
      this.broadcast(snapshot)
  }

  private broadcast(snapshot = this.runtime.getSnapshot()): void {
    const payload = this.buildTickPayload(snapshot)
    const windows = this.windowManager
      ? [this.windowManager.getMainWindow(), this.windowManager.getProjectionWindow()]
      : []
    new Set(windows).forEach((window) => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send('timer-tick', payload)
    })
    this.lastBroadcastRemaining = snapshot.timer.remainingSeconds
    this.lastBroadcastTime = performance.now()
  }

  private buildTickPayload(snapshot: TimerRuntimeSnapshot): TimerTickPayload {
    const {
      mode,
      totalDuration,
      reminderEnabled,
      reminderDuration,
      overtimeMessageEnabled,
      overtimeMessage
    } = this.settings
    const { remainingSeconds, overtimeSeconds } = snapshot.timer

    const phase = snapshot.timer.phase
    const progress = snapshot.timer.progress

    let mainDisplay: string
    let subDisplay: string | null = null
    let overtimeDisplay: string | null = null

    switch (phase) {
      case 'idle':
        mainDisplay = formatTime(totalDuration)
        break
      case 'main':
        if (reminderEnabled) {
          mainDisplay = formatTime(remainingSeconds - reminderDuration)
          subDisplay = formatTime(reminderDuration)
        } else {
          mainDisplay = formatTime(remainingSeconds)
        }
        break
      case 'warning':
        mainDisplay = formatTime(remainingSeconds)
        break
      case 'overtime':
        mainDisplay = '00:00'
        overtimeDisplay = formatTime(overtimeSeconds)
        break
      default:
        mainDisplay = formatTime(remainingSeconds)
    }

    return {
      runtime: snapshot,
      mode,
      remainingSeconds,
      phase,
      mainDisplay,
      subDisplay: subDisplay ?? overtimeDisplay,
      progress,
      overtimeSeconds,
      overtimeMessage: overtimeMessageEnabled ? overtimeMessage : null,
      reminderColor: reminderEnabled ? snapshot.configuration.settings.reminderColor : null,
      ...(mode === 'stopwatch' && {
        stopwatchElapsedMs: snapshot.stopwatch.elapsedMs,
        stopwatchFormattedTime: snapshot.stopwatch.formattedTime
      })
    }
  }

  handleCommand(command: TimerCommand): void {
    this.runtime.executeLegacy(command)
    this.syncInterval()
    this.broadcast()
  }

  getState(): TimerState & { stopwatch: StopwatchState } {
    const snapshot = this.runtime.getSnapshot()
    return {
      ...snapshot.timer,
      formattedTime: formatTime(snapshot.timer.remainingSeconds),
      stopwatch: snapshot.stopwatch
    }
  }

  initializeState(settings: TimerSettings): void {
    this.runtime.initializeLegacy(settings)
    this.syncInterval()
    this.broadcast()
  }

  initializeRuntime(configuration: unknown): TimerRuntimeResult {
    const result = this.runtime.initialize(configuration)
    if (result.status === 'accepted') {
      this.syncInterval()
      this.broadcast(result.snapshot)
    }
    return result
  }

  executeRuntimeCommand(command: unknown): TimerRuntimeResult {
    const result = this.runtime.execute(command)
    if (result.status === 'accepted') {
      this.syncInterval()
      this.broadcast(result.snapshot)
    }
    return result
  }

  dispose(): void {
    this.stopInterval()
  }
}

export const timerService = new TimerService()
