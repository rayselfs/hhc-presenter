import { useCallback, useRef, type RefObject } from 'react'
import type {
  FileControlPayload,
  ProjectionMediaReplayState,
  ProjectionPayload
} from '@shared/projection-messages'
import type { createProjectionAdapter } from '@renderer/lib/projection-adapter'

type PlaybackIdentity = Pick<
  ProjectionPayload<'file:playback-state'>,
  'itemId' | 'blobId' | 'contentRevision'
>

type PendingVideoControl = {
  itemId: string | null
  seekTo?: number
  shouldPlay?: boolean
  volume?: number
  playbackRate?: number
}

const HAVE_METADATA = 1
interface ProjectionMediaPlayback {
  mediaRef: RefObject<HTMLMediaElement | null>
  isControlForCurrentItem(data: FileControlPayload): boolean
  applyPendingVideoControl(): void
  queueVideoControl(data: FileControlPayload, control: Omit<PendingVideoControl, 'itemId'>): void
  sendVideoPlaybackState(
    video: HTMLMediaElement,
    identity: PlaybackIdentity,
    next?: { isPlaying?: boolean; isEnded?: boolean }
  ): void
  configurePlayback(options: {
    playbackMode?: 'native' | 'vlc-embedded'
    seekable?: boolean
    durationMs?: number
  }): void
  prepareMediaReplay(
    itemId: string,
    replay: Pick<
      ProjectionMediaReplayState,
      'positionSeconds' | 'isPlaying' | 'isEnded' | 'volume' | 'playbackRate'
    > | null
  ): void
  clearPendingMediaControl(): void
  getPlaybackMode(): 'native' | 'vlc-embedded'
  isSeekable(): boolean
  getDurationMs(): number | undefined
}

export function useProjectionMediaPlayback({
  currentItemIdRef,
  adapterSendRef,
  initialDurationMs
}: {
  currentItemIdRef: RefObject<string | null>
  adapterSendRef: RefObject<ReturnType<typeof createProjectionAdapter>['send'] | null>
  initialDurationMs?: number
}): ProjectionMediaPlayback {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const pendingVideoControlRef = useRef<PendingVideoControl | null>(null)
  const seekableRef = useRef(true)
  const playbackModeRef = useRef<'native' | 'vlc-embedded'>('native')
  const durationMsRef = useRef(initialDurationMs)

  const isControlForCurrentItem = useCallback(
    (data: FileControlPayload): boolean => {
      if (!('itemId' in data) || data.itemId === undefined) return true
      return data.itemId === currentItemIdRef.current
    },
    [currentItemIdRef]
  )

  const clampVideoTime = useCallback((video: HTMLMediaElement, value: number): number => {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : value
    return Math.max(0, Math.min(value, duration))
  }, [])

  const applyPendingVideoControl = useCallback((): void => {
    const pending = pendingVideoControlRef.current
    const video = mediaRef.current
    if (!pending || !video) return
    if (pending.itemId && pending.itemId !== currentItemIdRef.current) {
      pendingVideoControlRef.current = null
      return
    }

    if (pending.volume !== undefined) {
      video.muted = false
      video.volume = Math.max(0, Math.min(1, pending.volume))
      delete pending.volume
    }

    if (pending.playbackRate !== undefined) {
      video.playbackRate = pending.playbackRate
      delete pending.playbackRate
    }

    if (pending.seekTo !== undefined) {
      if (!seekableRef.current) {
        delete pending.seekTo
      } else {
        if (video.readyState < HAVE_METADATA) return
        try {
          video.currentTime = clampVideoTime(video, pending.seekTo)
          delete pending.seekTo
        } catch {
          return
        }
      }
    }

    if (pending.shouldPlay !== undefined) {
      if (pending.shouldPlay) {
        const mustApplySeekBeforePlay = pending.seekTo !== undefined && seekableRef.current
        if (mustApplySeekBeforePlay && video.readyState < HAVE_METADATA) return
        video.muted = false
        video.play().catch((error) => {
          console.error('[file-projection] Video play failed', error)
        })
      } else {
        video.pause()
      }
      delete pending.shouldPlay
    }

    if (
      pending.seekTo === undefined &&
      pending.shouldPlay === undefined &&
      pending.volume === undefined &&
      pending.playbackRate === undefined
    ) {
      pendingVideoControlRef.current = null
    }
  }, [clampVideoTime, currentItemIdRef])

  const queueVideoControl = useCallback(
    (data: FileControlPayload, control: Omit<PendingVideoControl, 'itemId'>): void => {
      if (!isControlForCurrentItem(data)) return
      const itemId =
        'itemId' in data && data.itemId !== undefined ? data.itemId : currentItemIdRef.current
      pendingVideoControlRef.current = {
        ...(pendingVideoControlRef.current ?? {}),
        itemId,
        ...control
      }
      applyPendingVideoControl()
    },
    [applyPendingVideoControl, isControlForCurrentItem, currentItemIdRef]
  )

  const sendVideoPlaybackState = useCallback(
    (
      video: HTMLMediaElement,
      identity: PlaybackIdentity,
      next?: { isPlaying?: boolean; isEnded?: boolean }
    ): void => {
      const send = adapterSendRef.current
      if (video !== mediaRef.current || !send) return
      const metadataDuration =
        durationMsRef.current !== undefined && durationMsRef.current > 0
          ? durationMsRef.current / 1000
          : undefined
      const duration =
        metadataDuration ??
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0)
      send('file:playback-state', {
        ...identity,
        phase:
          (next?.isEnded ?? video.ended)
            ? 'ended'
            : (next?.isPlaying ?? !video.paused)
              ? 'playing'
              : video.currentTime > 0
                ? 'paused'
                : 'ready',
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration,
        isPlaying: next?.isPlaying ?? !video.paused,
        isEnded: next?.isEnded ?? video.ended,
        playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
        seekable: seekableRef.current,
        volume: Number.isFinite(video.volume) ? video.volume : 1
      })
    },
    [adapterSendRef]
  )

  const configurePlayback = useCallback(
    (options: {
      playbackMode?: 'native' | 'vlc-embedded'
      seekable?: boolean
      durationMs?: number
    }): void => {
      playbackModeRef.current = options.playbackMode ?? 'native'
      seekableRef.current = options.seekable !== false
      durationMsRef.current = options.durationMs
    },
    []
  )
  const prepareMediaReplay = useCallback(
    (
      itemId: string,
      replay: Pick<
        ProjectionMediaReplayState,
        'positionSeconds' | 'isPlaying' | 'isEnded' | 'volume' | 'playbackRate'
      > | null
    ): void => {
      pendingVideoControlRef.current = replay
        ? {
            itemId,
            seekTo: replay.positionSeconds,
            shouldPlay: replay.isPlaying && !replay.isEnded,
            volume: replay.volume,
            playbackRate: replay.playbackRate ?? 1
          }
        : null
    },
    []
  )
  const clearPendingMediaControl = useCallback((): void => {
    pendingVideoControlRef.current = null
  }, [])
  const getPlaybackMode = useCallback(() => playbackModeRef.current, [])
  const isSeekable = useCallback(() => seekableRef.current, [])
  const getDurationMs = useCallback(() => durationMsRef.current, [])

  return {
    mediaRef,
    isControlForCurrentItem,
    applyPendingVideoControl,
    queueVideoControl,
    sendVideoPlaybackState,
    configurePlayback,
    prepareMediaReplay,
    clearPendingMediaControl,
    getPlaybackMode,
    isSeekable,
    getDurationMs
  }
}
