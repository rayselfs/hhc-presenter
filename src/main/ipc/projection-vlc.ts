import { BrowserWindow, ipcMain } from 'electron'
import { createVlcLivePreview, type VlcLiveFrame } from '../vlc-live-preview'
import type { VlcPlayer } from 'electron-vlc-player'
import type {
  ProjectionVlcControlRequest,
  ProjectionVlcFailure,
  ProjectionVlcFailureCode,
  ProjectionVlcInfo,
  ProjectionVlcStartRequest,
  ProjectionVlcStopRequest
} from '@shared/ipc-channels'
import type { VideoPreparationPhase } from '../../shared/projection-messages'
import type { WindowManager } from '../windowManager'
import { isKnownWindow, isMainWindow } from './validate'
import { lockVideoPlaybackSource, resolveVideoPlaybackPath } from './video-remux'
import { isValidNativeFileId } from '../../shared/native-media'
import { resolveVlcRuntime } from '../video-engine-runtime'
import {
  loadVlcPlayerRuntime,
  type VlcPlayerRuntime,
  type VlcPlayerRuntimeResult
} from '../vlc-player-runtime'

interface PendingVlcControls {
  volume?: number
  seekSeconds?: number
  transport?: 'play' | 'pause'
}

interface OwnedVlcSession {
  itemId: string
  releaseSource: () => void
  preview: (() => Promise<VlcLiveFrame | null>) | null
  attemptId: string
  generation: number
  lifecycleVersion: number
  player: VlcPlayer | null
  runtime: VlcPlayerRuntime | null
  sourceInstalled: boolean
  mediaReady: boolean
  confirmedPlaybackStarted: boolean
  seekable: boolean | null
  pending: PendingVlcControls
  phase: 'opening' | 'waiting-media' | 'waiting-seek' | 'waiting-transport' | 'ready'
  seekTargetSeconds?: number
  durationMs?: number
  lastProgressPublicationMs: number | null
  listenerCleanup: (() => void) | null
  resizeCleanup: (() => void) | null
  closeCleanup: (() => void) | null
  watchdog: ReturnType<typeof setTimeout> | null
}

let activeSession: OwnedVlcSession | null = null
let lifecycleVersion = 0

const VLC_PROGRESS_PUBLICATION_INTERVAL_MS = 250
const VLC_PREMATURE_END_TOLERANCE_MS = 2_000
const VLC_SEEK_CONFIRMATION_TOLERANCE_SECONDS = 1
const VLC_START_WATCHDOG_MS = 15_000
const VLC_FAILURE_DETAILS: Record<
  ProjectionVlcFailureCode,
  Pick<ProjectionVlcFailure, 'recoverable' | 'message'>
> = {
  'runtime-missing': { recoverable: false, message: 'VLC runtime is not available.' },
  'binding-unavailable': {
    recoverable: false,
    message: 'VLC native playback is unavailable.'
  },
  'media-open-failed': { recoverable: true, message: 'VLC could not open this media.' },
  'playback-failed': { recoverable: true, message: 'VLC playback stopped unexpectedly.' },
  'matroska-remux-failed': {
    recoverable: true,
    message: 'This Matroska video could not be prepared.'
  },
  'insufficient-storage': {
    recoverable: true,
    message: 'Not enough storage is available to prepare this video.'
  },
  'source-replaced': {
    recoverable: true,
    message: 'The source video changed while it was being prepared.'
  },
  'remux-timeout': { recoverable: true, message: 'Preparing this video timed out.' },
  'remux-cancelled': { recoverable: true, message: 'Preparing this video was cancelled.' }
}

function remuxFailureCode(error: unknown): ProjectionVlcFailureCode {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('insufficient-storage')) return 'insufficient-storage'
  if (message.includes('source-replaced')) return 'source-replaced'
  if (message.includes('timed out')) return 'remux-timeout'
  if (message.includes('aborted')) return 'remux-cancelled'
  if (message.includes('runtime-missing')) return 'runtime-missing'
  return 'matroska-remux-failed'
}

type ListenerTarget = {
  listeners(event: string): unknown[]
  removeListener(event: string, listener: EventListener): unknown
}

type EventListener = (...args: unknown[]) => void

function getSafeItemId(itemId?: string): string | undefined {
  return itemId && /^[A-Za-z0-9_-]{1,128}$/.test(itemId) ? itemId : undefined
}

function publishFailure(
  wm: WindowManager,
  code: ProjectionVlcFailureCode,
  session: OwnedVlcSession
): void {
  if (
    activeSession !== session ||
    session.generation <= 0 ||
    session.lifecycleVersion !== lifecycleVersion ||
    wm.getProjectionState().lifecycle.generation !== session.generation
  ) {
    return
  }
  const safeItemId = getSafeItemId(session.itemId)
  wm.sendToMain('projection-vlc:failure', {
    ...(safeItemId ? { itemId: safeItemId } : {}),
    code,
    ...VLC_FAILURE_DETAILS[code]
  })
}

function publishStarted(wm: WindowManager, session: OwnedVlcSession): void {
  const safeItemId = getSafeItemId(session.itemId)
  if (
    activeSession === session &&
    safeItemId &&
    session.generation > 0 &&
    wm.getProjectionState().lifecycle.generation === session.generation
  ) {
    wm.sendToMain('projection-vlc:started', session.generation, safeItemId)
  }
}

const VLC_WINDOW_EVENTS = [
  'enter-full-screen',
  'leave-full-screen',
  'close',
  'minimize',
  'restore',
  'hide',
  'focus',
  'blur',
  'show',
  'move'
]

const VLC_WEB_CONTENTS_EVENTS = ['paint', 'devtools-opened', 'did-finish-load']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isOptionalFiniteNumber(
  value: unknown,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY
): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum)
  )
}

function validateVlcStartRequest(value: unknown): ProjectionVlcStartRequest {
  if (
    !isRecord(value) ||
    typeof value.itemId !== 'string' ||
    value.itemId.length === 0 ||
    (value.attemptId !== undefined &&
      (typeof value.attemptId !== 'string' || value.attemptId.length === 0)) ||
    !isValidNativeFileId(value.sourceFileId) ||
    value.container !== '#vlc-player' ||
    !isOptionalFiniteNumber(value.durationMs, 0) ||
    !isOptionalFiniteNumber(value.initialPositionSeconds, 0) ||
    !isOptionalFiniteNumber(value.initialVolume, 0, 1) ||
    (value.initialPlaybackState !== undefined &&
      !['playing', 'paused', 'ended'].includes(String(value.initialPlaybackState))) ||
    (value.playbackVariant !== undefined &&
      !['source', 'matroska-remux'].includes(String(value.playbackVariant)))
  ) {
    throw new Error('Invalid VLC start request')
  }
  return value as unknown as ProjectionVlcStartRequest
}

function validateVlcControlRequest(value: unknown): ProjectionVlcControlRequest {
  if (
    !isRecord(value) ||
    (value.itemId !== undefined && (typeof value.itemId !== 'string' || value.itemId.length === 0))
  ) {
    throw new Error('Invalid VLC control request')
  }
  if (value.action === 'play' || value.action === 'pause') {
    return value as unknown as ProjectionVlcControlRequest
  }
  if (
    value.action === 'seek' &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    value.value >= 0
  ) {
    return value as unknown as ProjectionVlcControlRequest
  }
  if (
    value.action === 'volume' &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    value.value <= 1
  ) {
    return value as unknown as ProjectionVlcControlRequest
  }
  throw new Error('Invalid VLC control request')
}

function validateVlcStopRequest(value: unknown): ProjectionVlcStopRequest | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Invalid VLC stop request')
  if (value.force === true) return { force: true }
  if (
    typeof value.itemId === 'string' &&
    value.itemId.length > 0 &&
    typeof value.attemptId === 'string' &&
    value.attemptId.length > 0
  ) {
    return value as unknown as ProjectionVlcStopRequest
  }
  throw new Error('Invalid VLC stop request')
}

function captureListeners(
  target: ListenerTarget,
  events: string[]
): Map<string, Set<EventListener>> {
  return new Map(
    events.map((event) => [event, new Set(target.listeners(event) as EventListener[])])
  )
}

function captureAddedListeners(
  target: ListenerTarget,
  events: string[],
  before: Map<string, Set<EventListener>>
): Map<string, EventListener[]> {
  return new Map(
    events.map((event) => [
      event,
      (target.listeners(event) as EventListener[]).filter(
        (listener) => !before.get(event)?.has(listener)
      )
    ])
  )
}

function createListenerCleanup(
  window: BrowserWindow,
  beforeWindow: Map<string, Set<EventListener>>,
  beforeWebContents: Map<string, Set<EventListener>>
): () => void {
  const addedWindow = captureAddedListeners(window, VLC_WINDOW_EVENTS, beforeWindow)
  const addedWebContents = captureAddedListeners(
    window.webContents,
    VLC_WEB_CONTENTS_EVENTS,
    beforeWebContents
  )

  return () => {
    removeListeners(window, addedWindow)
    if (!window.isDestroyed()) removeListeners(window.webContents, addedWebContents)
  }
}

function removeListeners(
  target: ListenerTarget,
  addedListeners: Map<string, EventListener[]>
): void {
  for (const [event, listeners] of addedListeners) {
    for (const listener of listeners) target.removeListener(event, listener)
  }
}

type LoadVlcPlayerRuntime = () => Promise<VlcPlayerRuntimeResult>

async function resolveVlcInfo(
  loadRuntime: LoadVlcPlayerRuntime
): Promise<{ info: ProjectionVlcInfo; runtime?: VlcPlayerRuntime; vlcDir?: string }> {
  const loaded = await loadRuntime()
  if (loaded.status === 'error') {
    return { info: { status: 'error', message: 'VLC native playback is unavailable.' } }
  }
  const resolved = resolveVlcRuntime(loaded.runtime.probeDefaultVlcDir)
  if (resolved.status !== 'ready' || !resolved.path) {
    return {
      info: {
        status: resolved.status,
        message:
          resolved.status === 'missing'
            ? 'VLC runtime is not available.'
            : 'VLC native playback is unavailable.'
      }
    }
  }
  return {
    info: { status: 'ready' },
    runtime: loaded.runtime,
    vlcDir: resolved.path
  }
}

function ownsSession(
  wm: WindowManager,
  session: OwnedVlcSession,
  ownerPlayer: VlcPlayer | null = session.player
): boolean {
  return (
    activeSession === session &&
    session.lifecycleVersion === lifecycleVersion &&
    session.player === ownerPlayer &&
    session.generation > 0 &&
    wm.getProjectionState().lifecycle.generation === session.generation
  )
}

function sendState(
  wm: WindowManager,
  session: OwnedVlcSession,
  next?: { isPlaying?: boolean; isEnded?: boolean }
): void {
  const ownerPlayer = session.player
  if (!ownerPlayer || !ownsSession(wm, session, ownerPlayer)) return
  let currentTime = 0
  let duration =
    session.durationMs !== undefined && session.durationMs > 0 ? session.durationMs / 1000 : 0
  let isPlaying = next?.isPlaying ?? false
  let isEnded = next?.isEnded ?? false
  let seekable: boolean | undefined
  let volume: number | undefined
  try {
    currentTime = Math.max(0, ownerPlayer.getTime()) / 1000
    if (duration === 0) duration = Math.max(0, ownerPlayer.getLength()) / 1000
    if (next?.isPlaying === undefined) isPlaying = ownerPlayer.isPlaying()
    if (next?.isEnded === undefined) isEnded = ownerPlayer.getState() === 6
    seekable = ownerPlayer.isSeekable()
    const nativeVolume = ownerPlayer.getVolume()
    if (Number.isFinite(nativeVolume) && nativeVolume >= 0) {
      volume = Math.max(0, Math.min(100, nativeVolume)) / 100
    }
  } catch {
    // Native state can be unavailable after VLC reports a playback failure.
  }
  if (!ownsSession(wm, session, ownerPlayer)) return

  const phase = isEnded
    ? 'ended'
    : isPlaying
      ? 'playing'
      : session.confirmedPlaybackStarted
        ? 'paused'
        : 'ready'
  wm.sendToMain('projection:message', session.generation, 'file:playback-state', {
    itemId: session.itemId,
    phase,
    currentTime,
    duration,
    isPlaying,
    isEnded,
    ...(seekable !== undefined ? { seekable } : {}),
    ...(volume !== undefined ? { volume } : {})
  })
}

function setNativePlayerWindowVisible(
  session: OwnedVlcSession,
  currentPlayer: VlcPlayer,
  visible: boolean
): void {
  if (currentPlayer.playerId < 0) return
  try {
    session.runtime?.getBinding().setPlayerWindowVisible(currentPlayer.playerId, visible)
  } catch {
    // Window teardown can race with native view teardown.
  }
}

function didPlaybackEndPrematurely(session: OwnedVlcSession): boolean {
  const ownerPlayer = session.player
  if (!ownerPlayer) return false
  try {
    const elapsedMs = Math.max(0, ownerPlayer.getTime())
    const durationMs =
      session.durationMs !== undefined && session.durationMs > 0
        ? session.durationMs
        : Math.max(0, ownerPlayer.getLength())
    return durationMs > 0 && elapsedMs + VLC_PREMATURE_END_TOLERANCE_MS < durationMs
  } catch {
    return false
  }
}

function destroySessionResources(session: OwnedVlcSession): void {
  if (session.watchdog) clearTimeout(session.watchdog)
  session.watchdog = null
  session.preview = null
  const currentPlayer = session.player
  session.player = null
  if (currentPlayer) {
    setNativePlayerWindowVisible(session, currentPlayer, false)
    try {
      currentPlayer.destroy()
    } catch {
      // Keep invalidation authoritative when native teardown already failed.
    }
  }
  try {
    session.listenerCleanup?.()
  } catch {
    // Keep invalidation authoritative when listener teardown races window destruction.
  }
  session.listenerCleanup = null
  try {
    session.resizeCleanup?.()
  } catch {
    // Keep invalidation authoritative when listener teardown races window destruction.
  }
  session.resizeCleanup = null
  session.closeCleanup?.()
  session.closeCleanup = null
  session.releaseSource()
}

function invalidateSession(session: OwnedVlcSession): void {
  if (activeSession === session) {
    activeSession = null
    lifecycleVersion += 1
  }
  destroySessionResources(session)
}

function runOwnedNativeAction(
  wm: WindowManager,
  session: OwnedVlcSession,
  action: (player: VlcPlayer) => void
): boolean {
  const ownerPlayer = session.player
  if (!ownerPlayer || !ownsSession(wm, session, ownerPlayer)) return false
  try {
    action(ownerPlayer)
    return true
  } catch {
    if (ownsSession(wm, session, ownerPlayer)) {
      if (session.phase === 'ready') sendState(wm, session, { isPlaying: false, isEnded: true })
      publishFailure(wm, 'playback-failed', session)
      invalidateSession(session)
    }
    return false
  }
}

async function stopVlc(request?: ProjectionVlcStopRequest): Promise<void> {
  const session = activeSession
  if (!session) return
  if (
    request &&
    !('force' in request) &&
    (request.itemId !== session.itemId || request.attemptId !== session.attemptId)
  ) {
    return
  }
  invalidateSession(session)
}

function applyPendingVolume(wm: WindowManager, session: OwnedVlcSession): boolean {
  const volume = session.phase === 'ready' ? (session.pending.volume ?? 1) : 0
  if (!session.sourceInstalled) return true
  return runOwnedNativeAction(wm, session, (player) => {
    player.setVolume(Math.round(Math.max(0, Math.min(1, volume)) * 100))
  })
}

function finishStartup(wm: WindowManager, session: OwnedVlcSession, isPlaying: boolean): void {
  const ownerPlayer = session.player
  if (!ownerPlayer || !ownsSession(wm, session, ownerPlayer)) return
  session.phase = 'ready'
  if (!applyPendingVolume(wm, session)) return
  session.pending.seekSeconds = undefined
  session.pending.transport = undefined
  if (session.watchdog) clearTimeout(session.watchdog)
  session.watchdog = null
  setNativePlayerWindowVisible(session, ownerPlayer, true)
  sendState(wm, session, { isPlaying, isEnded: false })
  publishStarted(wm, session)
}

function applyFinalTransport(wm: WindowManager, session: OwnedVlcSession): void {
  const ownerPlayer = session.player
  if (!ownerPlayer || !ownsSession(wm, session, ownerPlayer)) return
  if (session.pending.transport === 'play') {
    try {
      if (ownerPlayer.isPlaying()) {
        finishStartup(wm, session, true)
        return
      }
    } catch {
      // Fall through to the owner-safe native play request.
    }
  }
  session.phase = 'waiting-transport'
  runOwnedNativeAction(wm, session, (player) => {
    if (session.pending.transport === 'play') player.play()
    else player.pause()
  })
}

function continueStartupAfterReadiness(wm: WindowManager, session: OwnedVlcSession): void {
  const ownerPlayer = session.player
  if (!ownerPlayer || !ownsSession(wm, session, ownerPlayer)) return
  const seekSeconds = session.pending.seekSeconds
  if (seekSeconds !== undefined && session.seekable === true) {
    session.seekTargetSeconds = seekSeconds
    session.phase = 'waiting-seek'
    runOwnedNativeAction(wm, session, (player) => {
      player.setTime(Math.max(0, Math.round(seekSeconds * 1000)))
    })
    return
  }
  if (session.seekable === false) session.pending.seekSeconds = undefined
  applyFinalTransport(wm, session)
}

async function startVlc(
  wm: WindowManager,
  loadRuntime: LoadVlcPlayerRuntime,
  request: ProjectionVlcStartRequest
): Promise<void> {
  const projectionWindow = wm.getProjectionWindow()
  if (!projectionWindow || projectionWindow.isDestroyed())
    throw new Error('Projection window not open')
  const generation = wm.getProjectionState().lifecycle.generation
  if (generation <= 0) return
  const previousSession = activeSession
  const startVersion = ++lifecycleVersion
  const session: OwnedVlcSession = {
    itemId: request.itemId,
    releaseSource: lockVideoPlaybackSource(request.sourceFileId),
    preview: null,
    attemptId: request.attemptId ?? `${request.itemId}-${startVersion}`,
    generation,
    lifecycleVersion: startVersion,
    player: null,
    runtime: null,
    sourceInstalled: false,
    mediaReady: false,
    confirmedPlaybackStarted:
      (request.initialPositionSeconds ?? 0) > 0 ||
      request.initialPlaybackState === 'playing' ||
      request.initialPlaybackState === 'ended',
    seekable: null,
    pending: {
      ...(request.initialVolume !== undefined ? { volume: request.initialVolume } : {}),
      ...(request.initialPositionSeconds !== undefined && request.initialPositionSeconds > 0
        ? { seekSeconds: request.initialPositionSeconds }
        : {}),
      transport: request.initialPlaybackState === 'playing' ? 'play' : 'pause'
    },
    phase: 'opening',
    durationMs: request.durationMs,
    lastProgressPublicationMs: null,
    listenerCleanup: null,
    resizeCleanup: null,
    closeCleanup: null,
    watchdog: null
  }
  activeSession = session
  const onClose = (): void => invalidateSession(session)
  projectionWindow.once('close', onClose)
  session.closeCleanup = () => projectionWindow.removeListener('close', onClose)
  if (previousSession) destroySessionResources(previousSession)
  const publishPreparing = (preparationPhase: VideoPreparationPhase): void => {
    if (!ownsSession(wm, session)) return
    wm.sendToMain('projection:message', session.generation, 'file:playback-state', {
      itemId: session.itemId,
      phase: 'preparing',
      preparationPhase,
      currentTime: request.initialPositionSeconds ?? 0,
      duration: request.durationMs ? request.durationMs / 1000 : 0,
      isPlaying: false,
      isEnded: false,
      ...(request.initialVolume !== undefined ? { volume: request.initialVolume } : {})
    })
  }
  publishPreparing('inspection')
  let playbackPath: string
  try {
    playbackPath = await resolveVideoPlaybackPath(
      request.sourceFileId,
      request.playbackVariant ?? 'source',
      publishPreparing
    )
  } catch (error) {
    if (ownsSession(wm, session)) publishFailure(wm, remuxFailureCode(error), session)
    invalidateSession(session)
    throw error
  }
  if (!ownsSession(wm, session)) return
  publishPreparing('player')
  session.watchdog = setTimeout(() => {
    if (!ownsSession(wm, session)) return
    publishFailure(wm, 'media-open-failed', session)
    invalidateSession(session)
  }, VLC_START_WATCHDOG_MS)

  const { info, runtime, vlcDir } = await resolveVlcInfo(loadRuntime)
  if (!ownsSession(wm, session)) return
  if (info.status !== 'ready' || !vlcDir) {
    publishFailure(
      wm,
      info.status === 'missing' ? 'runtime-missing' : 'binding-unavailable',
      session
    )
    invalidateSession(session)
    throw new Error(info.message ?? 'VLC runtime not found')
  }
  if (!runtime) {
    publishFailure(wm, 'binding-unavailable', session)
    invalidateSession(session)
    throw new Error('VLC native binding unavailable')
  }

  session.runtime = runtime
  const beforeWindowListeners = captureListeners(projectionWindow, VLC_WINDOW_EVENTS)
  const beforeWebContentsListeners = captureListeners(
    projectionWindow.webContents,
    VLC_WEB_CONTENTS_EVENTS
  )
  let nextPlayer: VlcPlayer | null = null

  try {
    nextPlayer = new runtime.VlcPlayer({
      window: projectionWindow,
      container: request.container,
      vlcDir,
      controls: false,
      autoAdvancePlaylist: false
    })
    session.player = nextPlayer
    const previewPlayer = nextPlayer
    session.preview = createVlcLivePreview(previewPlayer, () =>
      ownsSession(wm, session, previewPlayer)
    )
    await nextPlayer.embed()
    if (!ownsSession(wm, session, nextPlayer)) {
      createListenerCleanup(projectionWindow, beforeWindowListeners, beforeWebContentsListeners)()
      if (session.player === nextPlayer) destroySessionResources(session)
      return
    }
    if (!nextPlayer.isEmbedded()) throw new Error('VLC player failed to embed')

    session.listenerCleanup = createListenerCleanup(
      projectionWindow,
      beforeWindowListeners,
      beforeWebContentsListeners
    )
    const embeddedPlayer = nextPlayer
    const notifyLayoutChange = (): void => embeddedPlayer.notifyLayoutChange()
    projectionWindow.on('resize', notifyLayoutChange)
    projectionWindow.on('resized', notifyLayoutChange)
    session.resizeCleanup = () => {
      projectionWindow.removeListener('resize', notifyLayoutChange)
      projectionWindow.removeListener('resized', notifyLayoutChange)
    }

    nextPlayer.on('timeChanged', () => {
      if (!ownsSession(wm, session, embeddedPlayer)) return
      if (session.phase === 'waiting-seek') {
        let currentSeconds = Number.NaN
        try {
          currentSeconds = embeddedPlayer.getTime() / 1000
        } catch {
          return
        }
        if (
          session.seekTargetSeconds !== undefined &&
          Math.abs(currentSeconds - session.seekTargetSeconds) <=
            VLC_SEEK_CONFIRMATION_TOLERANCE_SECONDS
        ) {
          session.pending.seekSeconds = undefined
          session.seekTargetSeconds = undefined
          applyFinalTransport(wm, session)
        }
        return
      }
      if (session.phase === 'waiting-transport' && session.pending.transport === 'play') {
        let isPlaying = false
        try {
          isPlaying = embeddedPlayer.isPlaying()
        } catch {
          return
        }
        if (isPlaying) finishStartup(wm, session, true)
        return
      }
      if (session.phase !== 'ready') return
      const now = Date.now()
      if (
        session.lastProgressPublicationMs !== null &&
        now - session.lastProgressPublicationMs < VLC_PROGRESS_PUBLICATION_INTERVAL_MS
      ) {
        return
      }
      session.lastProgressPublicationMs = now
      sendState(wm, session)
    })
    nextPlayer.on('lengthChanged', () => {
      if (session.phase === 'ready') sendState(wm, session)
    })
    nextPlayer.on('buffering', () => {
      if (session.phase === 'ready') sendState(wm, session)
    })
    nextPlayer.on('playing', () => {
      if (!ownsSession(wm, session, embeddedPlayer)) return
      if (session.pending.transport === 'play' || session.phase === 'ready') {
        session.confirmedPlaybackStarted = true
      }
      if (!session.mediaReady) {
        session.mediaReady = true
        try {
          session.seekable = embeddedPlayer.isSeekable()
        } catch {
          session.seekable = false
        }
        if (session.pending.seekSeconds === undefined && session.pending.transport === 'play') {
          finishStartup(wm, session, true)
          return
        }
        continueStartupAfterReadiness(wm, session)
        return
      }
      if (session.phase === 'waiting-transport' && session.pending.transport === 'play') {
        finishStartup(wm, session, true)
      } else if (session.phase === 'ready') {
        sendState(wm, session, { isPlaying: true, isEnded: false })
      }
    })
    nextPlayer.on('paused', () => {
      if (!ownsSession(wm, session, embeddedPlayer)) return
      if (session.phase === 'waiting-transport' && session.pending.transport === 'pause') {
        finishStartup(wm, session, false)
      } else if (session.phase === 'ready') {
        sendState(wm, session, { isPlaying: false })
      }
    })
    nextPlayer.on('stopped', () => {
      if (session.phase === 'ready') sendState(wm, session, { isPlaying: false })
    })
    nextPlayer.on('endReached', () => {
      if (!ownsSession(wm, session, embeddedPlayer)) return
      const endedPrematurely = didPlaybackEndPrematurely(session)
      sendState(wm, session, { isPlaying: false, isEnded: true })
      if (endedPrematurely) {
        publishFailure(wm, 'playback-failed', session)
      }
    })
    nextPlayer.on('error', () => {
      if (!ownsSession(wm, session, embeddedPlayer)) return
      sendState(wm, session, { isPlaying: false, isEnded: true })
      publishFailure(wm, 'playback-failed', session)
      invalidateSession(session)
    })
    nextPlayer.setSource(playbackPath, { autoplay: false })
    session.sourceInstalled = true
    session.phase = 'waiting-media'
    setNativePlayerWindowVisible(session, nextPlayer, false)
    if (!applyPendingVolume(wm, session)) return
    if (!runOwnedNativeAction(wm, session, (player) => player.play())) return
  } catch (error) {
    if (!session.listenerCleanup) {
      try {
        session.listenerCleanup = createListenerCleanup(
          projectionWindow,
          beforeWindowListeners,
          beforeWebContentsListeners
        )
      } catch {
        // Preserve the original startup rejection.
      }
    }
    try {
      if (activeSession === session) publishFailure(wm, 'media-open-failed', session)
      invalidateSession(session)
    } catch {
      // Preserve the original startup rejection.
    }
    throw error
  }
}

function controlVlc(wm: WindowManager, command: ProjectionVlcControlRequest): void {
  const session = activeSession
  if (!session) return
  if (command.itemId && command.itemId !== session.itemId) return

  switch (command.action) {
    case 'play':
      session.pending.transport = 'play'
      if (session.phase === 'ready')
        runOwnedNativeAction(wm, session, (player) => {
          if (player.shouldReplayFromStart()) player.replayFromStart()
          else player.play()
        })
      else if (session.mediaReady && session.phase !== 'waiting-seek')
        applyFinalTransport(wm, session)
      break
    case 'pause':
      session.pending.transport = 'pause'
      if (session.phase === 'ready') runOwnedNativeAction(wm, session, (player) => player.pause())
      else if (session.mediaReady && session.phase !== 'waiting-seek')
        applyFinalTransport(wm, session)
      break
    case 'seek':
      session.pending.seekSeconds = command.value
      if (session.phase === 'ready' && session.seekable === true) {
        runOwnedNativeAction(wm, session, (player) => {
          player.setTime(Math.max(0, Math.round(command.value * 1000)))
        })
      } else if (session.mediaReady && session.seekable === true) {
        continueStartupAfterReadiness(wm, session)
      } else if (session.seekable === false) {
        session.pending.seekSeconds = undefined
      }
      break
    case 'volume':
      session.pending.volume = command.value
      if (!applyPendingVolume(wm, session)) return
      if (session.phase === 'ready') sendState(wm, session)
      break
  }
}

function isProjectionOrMainWindow(wm: WindowManager, event: Electron.IpcMainInvokeEvent): boolean {
  const senderWindow = BrowserWindow.fromWebContents(event.sender)
  return senderWindow === wm.getProjectionWindow() || isKnownWindow(wm, event)
}

export function registerProjectionVlcHandlers(
  wm: WindowManager,
  loadRuntime: LoadVlcPlayerRuntime = loadVlcPlayerRuntime
): void {
  ipcMain.handle('projection-vlc:get-info', async (event): Promise<ProjectionVlcInfo> => {
    if (!isKnownWindow(wm, event)) return { status: 'error', message: 'Unauthorized VLC access' }
    return (await resolveVlcInfo(loadRuntime)).info
  })

  ipcMain.handle('projection-vlc:preview', async (event, itemId: unknown) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized VLC preview access')
    if (typeof itemId !== 'string' || !getSafeItemId(itemId))
      throw new Error('Invalid VLC preview item')
    const session = activeSession
    if (!session || session.itemId !== itemId || session.phase !== 'ready' || !session.preview)
      return null
    try {
      const frame = await session.preview()
      return frame && ownsSession(wm, session)
        ? { ...frame, itemId, generation: session.generation, attemptId: session.attemptId }
        : null
    } catch (cause) {
      throw new Error('VLC live preview is unavailable', { cause })
    }
  })

  ipcMain.handle('projection-vlc:start', async (event, request: unknown) => {
    if (!isProjectionOrMainWindow(wm, event)) throw new Error('Unauthorized VLC access')
    const validatedRequest = validateVlcStartRequest(request)
    try {
      await startVlc(wm, loadRuntime, validatedRequest)
    } catch {
      throw new Error('VLC startup failed')
    }
  })

  ipcMain.handle('projection-vlc:control', (event, command: unknown) => {
    if (!isProjectionOrMainWindow(wm, event)) throw new Error('Unauthorized VLC access')
    controlVlc(wm, validateVlcControlRequest(command))
  })

  ipcMain.handle('projection-vlc:stop', async (event, request: unknown) => {
    if (!isProjectionOrMainWindow(wm, event)) throw new Error('Unauthorized VLC access')
    await stopVlc(validateVlcStopRequest(request))
  })
}
