import { MAX_DURATION_SECONDS } from './constants/timer'
import { parseTimerRuntimeCommand, parseTimerRuntimeConfiguration } from './timer-command'
import { computePhase, computeProgress, formatTimerTime, readCountdownAt } from './timer-time-rules'
import type {
  StopwatchState,
  TimerCommand,
  TimerRuntimeConfiguration,
  TimerRuntimeResult,
  TimerRuntimeSnapshot,
  TimerSettings,
  TimerState
} from './types/timer'

type TimerCompletion = 'stop-at-zero' | 'continue-overtime'

function formatStopwatch(elapsedMs: number): string {
  const centiseconds = Math.floor(elapsedMs / 10)
  return `${String(Math.floor(centiseconds / 6000)).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}

export class TimerRuntime {
  private configuration: TimerRuntimeConfiguration = {
    settings: {
      mode: 'timer',
      totalDuration: 300,
      reminderEnabled: false,
      reminderDuration: 0,
      reminderColor: '#ff0000',
      overtimeMessageEnabled: false,
      overtimeMessage: ''
    },
    reminderMode: 'subtract'
  }
  private timer: TimerState = {
    status: 'stopped',
    remainingSeconds: 300,
    phase: 'idle',
    overtimeSeconds: 0,
    progress: 1,
    formattedTime: '05:00'
  }
  private stopwatch: StopwatchState = {
    status: 'stopped',
    elapsedMs: 0,
    formattedTime: '00:00.00'
  }
  private deadlineMs: number | null = null
  private stopwatchAnchorMs: number | null = null
  private stopwatchAccumulatedMs = 0
  private completion: TimerCompletion | null = null
  private initialized = false
  private revision = 0

  constructor(private readonly nowMs: () => number) {}

  private get settings(): TimerSettings {
    return this.configuration.settings
  }
  private totalDuration(): number {
    return (
      this.settings.totalDuration +
      (this.configuration.reminderMode === 'add' && this.settings.reminderEnabled
        ? this.settings.reminderDuration
        : 0)
    )
  }

  getSnapshot(): TimerRuntimeSnapshot {
    return {
      revision: this.revision,
      configuration: {
        settings: { ...this.settings },
        reminderMode: this.configuration.reminderMode
      },
      timer: { ...this.timer },
      stopwatch: { ...this.stopwatch }
    }
  }

  private accept(): TimerRuntimeResult {
    this.revision += 1
    return { status: 'accepted', snapshot: this.getSnapshot() }
  }

  initialize(value: unknown): TimerRuntimeResult {
    const configuration = parseTimerRuntimeConfiguration(value)
    if (!configuration) return { status: 'rejected', reason: 'invalid-configuration' }
    if (!this.initialized) {
      this.configuration = configuration
      this.initialized = true
      this.resetTimer(this.totalDuration())
    }
    this.sampleClock()
    return this.accept()
  }

  initializeLegacy(settings: TimerSettings): void {
    const configuration = parseTimerRuntimeConfiguration({
      settings,
      reminderMode: this.configuration.reminderMode
    })
    if (!configuration) return
    this.initialized = true
    this.configuration = configuration
    if (this.timer.status === 'stopped')
      this.updateTimer({ remainingSeconds: settings.totalDuration })
    else this.updateTimer({})
    this.revision += 1
  }

  private updateTimer(patch: Partial<TimerState>): void {
    const timer = { ...this.timer, ...patch }
    this.timer = {
      ...timer,
      phase:
        patch.phase ??
        computePhase(
          timer.status,
          timer.remainingSeconds,
          this.settings.reminderEnabled,
          this.settings.reminderDuration
        ),
      progress: computeProgress(timer.remainingSeconds, this.totalDuration()),
      formattedTime: formatTimerTime(timer.remainingSeconds)
    }
  }

  private sampleClock(): void {
    if (this.timer.status === 'running' && this.deadlineMs !== null) {
      const frame = readCountdownAt(this.deadlineMs, this.nowMs())
      if (frame.remainingMs <= 0 && this.completion === 'stop-at-zero') {
        this.deadlineMs = null
        this.updateTimer({
          status: 'stopped',
          phase: 'overtime',
          remainingSeconds: 0,
          overtimeSeconds: 0
        })
      } else
        this.updateTimer({
          remainingSeconds: frame.remainingSeconds,
          overtimeSeconds: frame.overtimeSeconds
        })
    }
    if (this.stopwatch.status === 'running' && this.stopwatchAnchorMs !== null) {
      const elapsedMs = this.stopwatchAccumulatedMs + this.nowMs() - this.stopwatchAnchorMs
      this.stopwatch = { ...this.stopwatch, elapsedMs, formattedTime: formatStopwatch(elapsedMs) }
    }
  }

  tick(): TimerRuntimeSnapshot {
    this.sampleClock()
    this.revision += 1
    return this.getSnapshot()
  }

  private startTimer(duration: number, completion: TimerCompletion): void {
    this.completion = completion
    this.deadlineMs = this.nowMs() + duration * 1000
    this.updateTimer({ status: 'running', remainingSeconds: duration, overtimeSeconds: 0 })
  }

  private pauseTimer(): void {
    if (this.timer.status !== 'running') return
    this.deadlineMs = null
    this.updateTimer({ status: 'paused' })
  }

  private resumeTimer(): void {
    if (this.timer.status !== 'paused') return
    this.deadlineMs = this.nowMs() + this.timer.remainingSeconds * 1000
    this.updateTimer({ status: 'running' })
  }

  private resetTimer(duration: number): void {
    this.deadlineMs = null
    this.completion = null
    this.updateTimer({
      status: 'stopped',
      phase: 'idle',
      remainingSeconds: duration,
      overtimeSeconds: 0
    })
  }

  private startStopwatch(): void {
    this.stopwatchAnchorMs = this.nowMs()
    this.stopwatchAccumulatedMs = 0
    this.stopwatch = { status: 'running', elapsedMs: 0, formattedTime: '00:00.00' }
  }

  private resumeStopwatch(): void {
    if (this.stopwatch.status !== 'paused') return
    this.stopwatchAnchorMs = this.nowMs()
    this.stopwatchAccumulatedMs = this.stopwatch.elapsedMs
    this.stopwatch = { ...this.stopwatch, status: 'running' }
  }

  private pauseStopwatch(): void {
    if (this.stopwatch.status !== 'running') return
    this.sampleClock()
    this.stopwatchAnchorMs = null
    this.stopwatchAccumulatedMs = this.stopwatch.elapsedMs
    this.stopwatch = { ...this.stopwatch, status: 'paused' }
  }

  private resetStopwatch(): void {
    this.stopwatchAnchorMs = null
    this.stopwatchAccumulatedMs = 0
    this.stopwatch = { status: 'stopped', elapsedMs: 0, formattedTime: '00:00.00' }
  }

  execute(value: unknown): TimerRuntimeResult {
    const command = parseTimerRuntimeCommand(value)
    if (!command) return { status: 'rejected', reason: 'invalid-command' }
    if (!this.initialized) return { status: 'rejected', reason: 'not-initialized' }
    this.sampleClock()
    switch (command.type) {
      case 'start':
        if (this.timer.status !== 'running')
          this.startTimer(
            this.timer.phase === 'overtime' ? this.totalDuration() : this.timer.remainingSeconds,
            'stop-at-zero'
          )
        break
      case 'pause':
        this.pauseTimer()
        break
      case 'resume':
        this.resumeTimer()
        break
      case 'reset':
        this.resetTimer(this.totalDuration())
        break
      case 'setDuration':
        if (this.timer.status !== 'stopped') break
        this.settings.totalDuration = command.seconds
        if (this.settings.reminderEnabled && this.settings.reminderDuration >= command.seconds)
          this.settings.reminderEnabled = false
        this.updateTimer({ remainingSeconds: this.totalDuration(), phase: 'idle' })
        break
      case 'addTime':
      case 'removeTime': {
        const adding = command.type === 'addTime'
        const adjust = (seconds: number): number =>
          adding
            ? Math.min(MAX_DURATION_SECONDS, seconds + command.seconds)
            : Math.max(0, seconds - command.seconds)
        if (this.timer.status === 'stopped') {
          this.settings.totalDuration = adjust(this.settings.totalDuration)
          if (
            !adding &&
            this.settings.reminderEnabled &&
            this.settings.reminderDuration >= this.settings.totalDuration
          )
            this.settings.reminderEnabled = false
          this.updateTimer({ remainingSeconds: this.totalDuration(), phase: this.timer.phase })
        } else {
          const remainingSeconds = adjust(this.timer.remainingSeconds)
          if (this.timer.status === 'running')
            this.deadlineMs = this.nowMs() + remainingSeconds * 1000
          this.updateTimer({
            remainingSeconds,
            overtimeSeconds: remainingSeconds > 0 ? 0 : this.timer.overtimeSeconds
          })
        }
        break
      }
      case 'setMode':
        if (command.mode === 'clock' && this.timer.status !== 'stopped')
          this.resetTimer(this.totalDuration())
        this.settings.mode = command.mode
        break
      case 'setReminder':
        this.settings.reminderEnabled = command.enabled
        this.settings.reminderDuration = command.durationSeconds
        if (command.color !== undefined) this.settings.reminderColor = command.color
        this.updateTimer(
          this.timer.status === 'stopped'
            ? { remainingSeconds: this.totalDuration(), phase: 'idle' }
            : {}
        )
        break
      case 'setReminderMode':
        this.configuration.reminderMode = command.mode
        this.updateTimer(
          this.timer.status === 'stopped'
            ? { remainingSeconds: this.totalDuration(), phase: this.timer.phase }
            : {}
        )
        break
      case 'setOvertimeMessage':
        this.settings.overtimeMessageEnabled = command.enabled
        this.settings.overtimeMessage = command.message
        break
      case 'startStopwatch':
        if (this.stopwatch.status !== 'running') this.startStopwatch()
        break
      case 'pauseStopwatch':
        this.pauseStopwatch()
        break
      case 'resumeStopwatch':
        this.resumeStopwatch()
        break
      case 'resetStopwatch':
        this.resetStopwatch()
        break
    }
    this.sampleClock()
    return this.accept()
  }

  executeLegacy(command: TimerCommand): void {
    this.initialized = true
    switch (command.type) {
      case 'start':
        this.startTimer(this.settings.totalDuration, 'continue-overtime')
        break
      case 'pause':
        this.pauseTimer()
        break
      case 'resume':
        this.resumeTimer()
        break
      case 'reset':
        this.resetTimer(this.settings.totalDuration)
        break
      case 'setDuration':
        this.settings.totalDuration = Math.max(1, Math.min(MAX_DURATION_SECONDS, command.seconds))
        if (this.timer.status === 'stopped')
          this.updateTimer({ remainingSeconds: this.settings.totalDuration })
        break
      case 'addTime':
        this.updateTimer({ remainingSeconds: this.timer.remainingSeconds + command.seconds })
        if (this.deadlineMs !== null) this.deadlineMs += command.seconds * 1000
        break
      case 'removeTime':
        this.updateTimer({
          remainingSeconds: Math.max(0, this.timer.remainingSeconds - command.seconds)
        })
        if (this.deadlineMs !== null) this.deadlineMs -= command.seconds * 1000
        break
      case 'setMode':
        this.settings.mode = command.mode
        break
      case 'setReminder':
        this.settings.reminderEnabled = command.enabled
        this.settings.reminderDuration = command.durationSeconds
        this.updateTimer({})
        break
      case 'setOvertimeMessage':
        this.settings.overtimeMessageEnabled = command.enabled
        this.settings.overtimeMessage = command.message
        break
      case 'startStopwatch':
        if (this.stopwatch.status === 'paused') this.resumeStopwatch()
        else if (this.stopwatch.status === 'stopped') this.startStopwatch()
        break
      case 'pauseStopwatch':
        this.pauseStopwatch()
        break
      case 'resetStopwatch':
        this.resetStopwatch()
        break
    }
    this.updateTimer({ phase: this.timer.phase })
    this.revision += 1
  }
}
