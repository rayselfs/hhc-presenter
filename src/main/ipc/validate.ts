import { isFilePlaybackError } from '@shared/projection-messages'
import { isCameraSignal, isCameraState, isCameraMessageFrom } from '@shared/camera'
import { BrowserWindow } from 'electron'
import { MAX_DURATION_SECONDS } from '@shared/constants/timer'
import type { WindowManager } from '../windowManager'
import type { ProjectionMessageTuple, ProjectionTransportTuple } from '@shared/projection-messages'

const VALID_TIMER_COMMAND_TYPES = new Set([
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

const VALID_TIMER_MODES = new Set(['timer', 'clock', 'both', 'stopwatch'])

const VALID_THEMES = new Set(['light', 'dark', 'system'])

export function isKnownWindow(wm: WindowManager, event: Electron.IpcMainInvokeEvent): boolean {
  const senderWindow = BrowserWindow.fromWebContents(event.sender)
  if (!senderWindow) return false
  return senderWindow === wm.getMainWindow() || senderWindow === wm.getProjectionWindow()
}

export function isMainWindow(wm: WindowManager, event: Electron.IpcMainInvokeEvent): boolean {
  const senderWindow = BrowserWindow.fromWebContents(event.sender)
  return senderWindow !== null && senderWindow === wm.getMainWindow()
}

export function validateTheme(theme: unknown): boolean {
  return typeof theme === 'string' && VALID_THEMES.has(theme)
}

export function validateTimerCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'object' || cmd === null) return false
  const obj = cmd as Record<string, unknown>
  if (typeof obj.type !== 'string' || !VALID_TIMER_COMMAND_TYPES.has(obj.type)) return false
  switch (obj.type) {
    case 'setDuration':
    case 'addTime':
    case 'removeTime':
      return (
        typeof obj.seconds === 'number' &&
        Number.isFinite(obj.seconds) &&
        obj.seconds >= 0 &&
        obj.seconds <= MAX_DURATION_SECONDS
      )
    case 'setMode':
      return typeof obj.mode === 'string' && VALID_TIMER_MODES.has(obj.mode)
    case 'setReminder':
      return (
        typeof obj.enabled === 'boolean' &&
        typeof obj.durationSeconds === 'number' &&
        Number.isFinite(obj.durationSeconds) &&
        obj.durationSeconds >= 0 &&
        obj.durationSeconds <= MAX_DURATION_SECONDS
      )
    case 'setOvertimeMessage':
      return (
        typeof obj.enabled === 'boolean' &&
        typeof obj.message === 'string' &&
        obj.message.length <= 1000
      )
    default:
      return true
  }
}

const NULL_PROJECTION_CHANNELS = new Set([
  '__system:pong',
  '__system:ping',
  '__system:close',
  '__system:closed',
  'file:end'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateProjectionPayload(channel: string, data: unknown): boolean {
  if (channel === '__system:ready') {
    return isRecord(data) && isValidProjectionGeneration(data.generation)
  }
  if (channel === '__system:replay') {
    return (
      isRecord(data) &&
      isValidProjectionGeneration(data.generation) &&
      validateProjectionReplayPayload(data.generation, data)
    )
  }
  if (NULL_PROJECTION_CHANNELS.has(channel)) return data === null
  if (!isRecord(data)) return false
  const obj = data

  switch (channel) {
    case 'camera:state':
      return isCameraState(data)
    case 'camera:ready':
      return isCameraMessageFrom(channel, data, 'projection')
    case 'camera:signal':
      return isCameraSignal(data)
    case '__system:blank':
      return typeof obj.showDefault === 'boolean'
    case '__system:blackout':
      return typeof obj.enabled === 'boolean'
    case '__system:active-owner':
      return typeof obj.owner === 'string'
    case 'settings:timezone':
      return typeof obj.timezone === 'string'
    case 'settings:timer-ring-color':
      return obj.color === null || typeof obj.color === 'string'
    case 'bible:settings':
      return typeof obj.fontSize === 'number' && Number.isFinite(obj.fontSize)
    case 'file:show':
      return (
        typeof obj.itemId === 'string' &&
        typeof obj.blobId === 'string' &&
        typeof obj.fileName === 'string' &&
        typeof obj.mimeType === 'string' &&
        (obj.contentRevision === undefined || isValidProjectionGeneration(obj.contentRevision)) &&
        Array.isArray(obj.playlist) &&
        typeof obj.currentIndex === 'number' &&
        Number.isInteger(obj.currentIndex) &&
        (obj.playbackVariant === undefined ||
          obj.playbackVariant === 'source' ||
          obj.playbackVariant === 'matroska-remux')
      )
    case 'file:control':
      if (typeof obj.action !== 'string') return false
      if ('itemId' in obj && obj.itemId !== undefined && typeof obj.itemId !== 'string') {
        return false
      }
      if (['play', 'pause'].includes(obj.action)) return true
      if (['seek', 'volume', 'pdfPage', 'pdfScroll', 'zoom'].includes(obj.action)) {
        return isFiniteNumber(obj.value)
      }
      if (obj.action === 'pdfViewMode') {
        return obj.value === 'single' || obj.value === 'continuous'
      }
      if (obj.action === 'pan') {
        const value = obj.value as Record<string, unknown> | null
        return (
          typeof value === 'object' &&
          value !== null &&
          isFiniteNumber(value.x) &&
          isFiniteNumber(value.y)
        )
      }
      return false
    case 'file:playback-error':
      return isFilePlaybackError(data)
    case 'file:playback-state':
      return (
        typeof obj.itemId === 'string' &&
        typeof obj.phase === 'string' &&
        ['preparing', 'ready', 'playing', 'paused', 'ended'].includes(obj.phase) &&
        isFiniteNumber(obj.currentTime) &&
        isFiniteNumber(obj.duration) &&
        typeof obj.isPlaying === 'boolean' &&
        typeof obj.isEnded === 'boolean' &&
        (obj.seekable === undefined || typeof obj.seekable === 'boolean') &&
        (obj.volume === undefined ||
          (isFiniteNumber(obj.volume) && obj.volume >= 0 && obj.volume <= 1))
      )
    case 'timer:tick':
      return (
        typeof obj.mode === 'string' &&
        VALID_TIMER_MODES.has(obj.mode) &&
        isFiniteNumber(obj.remainingSeconds) &&
        typeof obj.phase === 'string' &&
        typeof obj.mainDisplay === 'string' &&
        (obj.subDisplay === null || typeof obj.subDisplay === 'string') &&
        isFiniteNumber(obj.progress) &&
        isFiniteNumber(obj.overtimeSeconds)
      )
    case 'timer:sync': {
      const state = obj.state as Record<string, unknown> | null
      const stopwatch = obj.stopwatchState as Record<string, unknown> | null
      return (
        validateTimerSettings(obj.settings) &&
        typeof state === 'object' &&
        state !== null &&
        typeof state.status === 'string' &&
        isFiniteNumber(state.remainingSeconds) &&
        typeof stopwatch === 'object' &&
        stopwatch !== null &&
        typeof stopwatch.status === 'string' &&
        isFiniteNumber(stopwatch.elapsedMs)
      )
    }
    case 'timer:stopwatch':
      return (
        isFiniteNumber(obj.elapsedMs) &&
        typeof obj.formattedTime === 'string' &&
        typeof obj.status === 'string'
      )
    case 'timer:overtime-message':
      return typeof obj.message === 'string'
    case 'bible:chapter':
      return (
        isFiniteNumber(obj.bookNumber) &&
        isFiniteNumber(obj.chapter) &&
        Array.isArray(obj.chapterVerses) &&
        isFiniteNumber(obj.currentVerse)
      )
    default:
      return false
  }
}

function validateNullablePayload(channel: string, value: unknown): boolean {
  return value === null || validateProjectionPayload(channel, value)
}

function validateMediaReplayState(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isRecord(value.pan)) return false
  return (
    typeof value.itemId === 'string' &&
    isFiniteNumber(value.positionSeconds) &&
    isFiniteNumber(value.durationSeconds) &&
    typeof value.isPlaying === 'boolean' &&
    typeof value.isEnded === 'boolean' &&
    (value.seekable === undefined || typeof value.seekable === 'boolean') &&
    isFiniteNumber(value.volume) &&
    isFiniteNumber(value.pdfPage) &&
    isFiniteNumber(value.pdfScroll) &&
    (value.pdfViewMode === 'single' || value.pdfViewMode === 'continuous') &&
    isFiniteNumber(value.zoom) &&
    isFiniteNumber(value.pan.x) &&
    isFiniteNumber(value.pan.y)
  )
}

function validatePendingFileControls(value: unknown): boolean {
  if (!isRecord(value) || typeof value.itemId !== 'string') return false
  return (
    (value.seekSeconds === undefined ||
      (isFiniteNumber(value.seekSeconds) && value.seekSeconds >= 0)) &&
    (value.volume === undefined ||
      (isFiniteNumber(value.volume) && value.volume >= 0 && value.volume <= 1)) &&
    (value.transport === undefined || value.transport === 'play' || value.transport === 'pause')
  )
}

function validateProjectionReplayPayload(generation: number, data: unknown): boolean {
  if (!isRecord(data) || data.generation !== generation || !isRecord(data.snapshot)) return false
  const snapshot = data.snapshot
  if (
    !['timer', 'bible', 'media', 'camera'].includes(String(snapshot.owner)) ||
    typeof snapshot.showDefault !== 'boolean' ||
    typeof snapshot.isBlackout !== 'boolean' ||
    !isRecord(snapshot.timer) ||
    !isRecord(snapshot.bible) ||
    !isRecord(snapshot.media)
  ) {
    return false
  }

  const timer = snapshot.timer
  const bible = snapshot.bible
  const media = snapshot.media
  return (
    (snapshot.camera == null || isCameraState(snapshot.camera)) &&
    validateNullablePayload('timer:tick', timer.tick) &&
    validateNullablePayload('timer:stopwatch', timer.stopwatch) &&
    validateNullablePayload('timer:overtime-message', timer.overtimeMessage) &&
    validateNullablePayload('settings:timezone', timer.timezone) &&
    validateNullablePayload('settings:timer-ring-color', timer.ringColor) &&
    validateNullablePayload('bible:chapter', bible.chapter) &&
    validateNullablePayload('bible:settings', bible.settings) &&
    validateNullablePayload('file:show', media.show) &&
    (media.state === null || validateMediaReplayState(media.state)) &&
    (data.pendingFileControls === undefined ||
      validatePendingFileControls(data.pendingFileControls))
  )
}

export function isValidProjectionGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

export function validateProjectionTransportTuple(
  args: unknown[]
): args is ProjectionTransportTuple {
  if (args.length !== 3 || !isValidProjectionGeneration(args[0])) return false
  const [generation, channel, data] = args
  if (typeof channel !== 'string') return false
  if (channel === '__system:ready') {
    return isRecord(data) && data.generation === generation
  }
  if (channel === '__system:replay') {
    return validateProjectionReplayPayload(generation, data)
  }
  return validateProjectionPayload(channel, data)
}

export function validateProjectionMessageTuple(args: unknown[]): args is ProjectionMessageTuple {
  if (args.length !== 2 || typeof args[0] !== 'string') return false
  return validateProjectionPayload(args[0], args[1])
}

export function validateTimerSettings(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false
  const obj = settings as Record<string, unknown>

  if (typeof obj.mode !== 'string' || !VALID_TIMER_MODES.has(obj.mode)) return false

  if (
    typeof obj.totalDuration !== 'number' ||
    obj.totalDuration < 0 ||
    obj.totalDuration > MAX_DURATION_SECONDS
  )
    return false

  if (typeof obj.reminderEnabled !== 'boolean') return false

  if (
    typeof obj.reminderDuration !== 'number' ||
    obj.reminderDuration < 0 ||
    obj.reminderDuration > MAX_DURATION_SECONDS
  )
    return false

  if (typeof obj.reminderColor !== 'string') return false

  if (typeof obj.overtimeMessageEnabled !== 'boolean') return false

  if (typeof obj.overtimeMessage !== 'string') return false

  return true
}
