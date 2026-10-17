import { parseTimerCommand } from './timer-command'
import type { TimerCommand } from './types/timer'

export type LanRemoteCommand =
  | { requestId: string; type: 'presentation:prev' }
  | { requestId: string; type: 'presentation:next' }
  | { requestId: string; type: 'presentation:jump'; index: number; requiredRevision?: number }
  | { requestId: string; type: 'media:play' }
  | { requestId: string; type: 'media:pause' }
  | { requestId: string; type: 'timer:command'; command: TimerCommand }

export interface LanRemoteSnapshot {
  revision: number
  presentation: {
    currentIndex: number
    total: number
    currentName: string | null
    nextName: string | null
    canPrevious: boolean
    canNext: boolean
    isPlaying: boolean
  }
  projection: {
    isOpen: boolean
  }
  timer: {
    status: string
    remainingSeconds: number
  }
  stopwatch: {
    status: string
    elapsedMs: number
  }
}

export type LanRemoteAck =
  | { requestId: string; status: 'accepted' }
  | { requestId: string; status: 'rejected'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requestIdOf(value: Record<string, unknown>): string | null {
  return typeof value.requestId === 'string' && value.requestId.length > 0 ? value.requestId : null
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? Number(value) : null
}

function booleanOrFalse(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function parseLanRemoteCommand(value: unknown): LanRemoteCommand | null {
  if (!isRecord(value)) return null
  const requestId = requestIdOf(value)
  if (!requestId || typeof value.type !== 'string') return null

  if (value.type === 'presentation:prev' || value.type === 'presentation:next') {
    return { requestId, type: value.type }
  }
  if (value.type === 'presentation:jump') {
    const index = integerOrNull(value.index)
    if (index === null || index < 0) return null
    const requiredRevision = integerOrNull(value.requiredRevision)
    return {
      requestId,
      type: 'presentation:jump',
      index,
      requiredRevision:
        requiredRevision !== null && requiredRevision >= 0 ? requiredRevision : undefined
    }
  }
  if (value.type === 'media:play' || value.type === 'media:pause') {
    return { requestId, type: value.type }
  }
  if (value.type === 'timer:command') {
    const command = parseTimerCommand(value.command)
    return command ? { requestId, type: 'timer:command', command } : null
  }
  return null
}

export function sanitizeLanRemoteSnapshot(snapshot: unknown): LanRemoteSnapshot {
  const root = isRecord(snapshot) ? snapshot : {}
  const presentation = isRecord(root.presentation) ? root.presentation : {}
  const projection = isRecord(root.projection) ? root.projection : {}
  const timer = isRecord(root.timer) ? root.timer : {}
  const stopwatch = isRecord(root.stopwatch) ? root.stopwatch : {}

  return {
    revision: numberOrZero(root.revision),
    presentation: {
      currentIndex: numberOrZero(presentation.currentIndex),
      total: numberOrZero(presentation.total),
      currentName: stringOrNull(presentation.currentName),
      nextName: stringOrNull(presentation.nextName),
      canPrevious: booleanOrFalse(presentation.canPrevious),
      canNext: booleanOrFalse(presentation.canNext),
      isPlaying: booleanOrFalse(presentation.isPlaying)
    },
    projection: {
      isOpen: booleanOrFalse(projection.isOpen)
    },
    timer: {
      status: stringOrEmpty(timer.status),
      remainingSeconds: numberOrZero(timer.remainingSeconds)
    },
    stopwatch: {
      status: stringOrEmpty(stopwatch.status),
      elapsedMs: numberOrZero(stopwatch.elapsedMs)
    }
  }
}

export function isPrivateLanAddress(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }

  const [first, second] = parts
  if (first === 10) return true
  if (first === 192 && second === 168) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  return false
}
