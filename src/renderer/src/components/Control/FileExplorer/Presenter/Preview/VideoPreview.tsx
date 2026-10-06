import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import {
  Play,
  Pause,
  ArrowCounterClockwise,
  SpeakerHigh,
  SpeakerLow,
  SpeakerX
} from '@phosphor-icons/react'
import type { FileItemRecord } from '@shared/types/folder'
import { getFileSource, openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { getBlobId } from '@renderer/lib/blob-identity'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { usePresenterCommands } from '@renderer/contexts/PresenterCommandContext'
import PreviewLoadError from './PreviewLoadError'

interface VideoPreviewProps {
  item: FileItemRecord
}

type SeekFlashDirection = 'backward' | 'forward'

interface SeekFlashState {
  direction: SeekFlashDirection
  seconds: number
  key: number
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function VideoPreview({ item }: VideoPreviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const { sendCommand, cancelPreparation, thumbnails } = usePresenterCommands()
  const videoRef = useRef<HTMLMediaElement>(null)
  const seekInputRef = useRef<HTMLInputElement>(null)
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [liveFrame, setLiveFrame] = useState<{ key: string; imageDataUrl: string } | null>(null)
  const [livePreviewFailed, setLivePreviewFailed] = useState(false)
  const [error, setError] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const blobId = getBlobId(item)

  const [hasStarted, setHasStarted] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isEnded, setIsEnded] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isVolumeHovered, setIsVolumeHovered] = useState(false)
  const [isDraggingSeek, setIsDraggingSeek] = useState(false)
  const [localSeekTime, setLocalSeekTime] = useState(0)
  const [pendingSeek, setPendingSeek] = useState<{ itemId: string; time: number } | null>(null)
  const [flashState, setFlashState] = useState<{ icon: 'play' | 'pause'; key: number } | null>(null)
  const [seekFlashState, setSeekFlashState] = useState<SeekFlashState | null>(null)

  const hasStartedRef = useRef(false)
  const playbackStateRef = useRef({ hasStarted: false, isPlaying: false, isEnded: false })
  const currentTimeRef = useRef(0)
  const durationRef = useRef(0)
  const isDraggingSeekRef = useRef(false)
  const localSeekTimeRef = useRef(0)
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashKeyRef = useRef(0)
  const seekFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seekFlashKeyRef = useRef(0)
  const seekFlashAccumulatorRef = useRef<{
    direction: SeekFlashDirection
    seconds: number
  } | null>(null)

  const zoomLevel = useMediaProjectionStore((s) => s.zoomLevel)
  const pan = useMediaProjectionStore((s) => s.pan)
  const projectionPlaybackState = useMediaProjectionStore((s) => s.typeStates.video)
  const usesProjectionVlc = useMediaProjectionStore(
    (s) =>
      s.snapshot?.entries.some(
        (entry) => entry.itemId === item.id && entry.playbackMode === 'vlc-embedded'
      ) === true
  )
  const metadataDuration = useMediaProjectionStore((s) => {
    const durationMs = s.snapshot?.entries.find((entry) => entry.itemId === item.id)?.durationMs
    return durationMs && durationMs > 0 ? durationMs / 1000 : undefined
  })
  const remoteSourceUrl = useMediaProjectionStore((s) => {
    const entry = s.snapshot?.entries.find((candidate) => candidate.itemId === item.id)
    if (!entry?.remoteItem) return undefined
    return entry.remoteSource ? entry.sourceUrl : null
  })
  const MediaElement = item.mimeType.startsWith('audio/') ? 'audio' : 'video'
  const seekable = projectionPlaybackState ? projectionPlaybackState.seekable === true : true
  const displayedCurrentTime =
    (pendingSeek?.itemId === item.id && seekable ? pendingSeek.time : undefined) ??
    projectionPlaybackState?.currentTime ??
    currentTime
  const displayedDuration = projectionPlaybackState?.duration ?? metadataDuration ?? duration
  const displayedHasStarted = projectionPlaybackState?.hasStarted ?? hasStarted
  const displayedIsPlaying = projectionPlaybackState?.isPlaying ?? isPlaying
  const displayedIsEnded = projectionPlaybackState?.isEnded ?? isEnded
  const sessionRevision = useMediaProjectionStore((s) => s.sessionRevision)
  const retryRevision = useMediaProjectionStore((s) => s.projectionRetryRevision)
  const previewKey = `${item.id}:${blobId}:${sessionRevision}:${retryRevision}`
  const isPreparing = usesProjectionVlc && projectionPlaybackState?.phase === 'preparing'
  const transform =
    !usesProjectionVlc && zoomLevel !== 1
      ? `scale(${zoomLevel}) translate(${(pan.x / zoomLevel) * 100}%, ${(pan.y / zoomLevel) * 100}%)`
      : undefined

  useEffect(() => {
    setLiveFrame(null)
    setLivePreviewFailed(false)
    if (!usesProjectionVlc || isPreparing) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      const started = performance.now()
      try {
        const capture = window.api?.projectionVlc?.getPreviewFrame
        if (!capture) throw new Error('Live preview unavailable')
        const frame = await capture(item.id)
        if (cancelled) return
        if (frame?.itemId === item.id) {
          setLiveFrame({ key: previewKey, imageDataUrl: frame.imageDataUrl })
          setLivePreviewFailed(false)
        } else {
          setLiveFrame(null)
        }
      } catch {
        if (!cancelled) {
          setLiveFrame(null)
          setLivePreviewFailed(true)
        }
      }
      if (!cancelled)
        timer = setTimeout(() => void refresh(), Math.max(250, (performance.now() - started) * 3))
    }
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [item.id, previewKey, usesProjectionVlc, isPreparing])

  const setPlaybackState = useCallback(
    (next: { hasStarted?: boolean; isPlaying?: boolean; isEnded?: boolean }): void => {
      const current = playbackStateRef.current
      const resolved = {
        hasStarted: next.hasStarted ?? current.hasStarted,
        isPlaying: next.isPlaying ?? current.isPlaying,
        isEnded: next.isEnded ?? current.isEnded
      }
      playbackStateRef.current = resolved
      hasStartedRef.current = resolved.hasStarted
      setHasStarted(resolved.hasStarted)
      setIsPlaying(resolved.isPlaying)
      setIsEnded(resolved.isEnded)
    },
    []
  )

  useEffect(() => {
    if (playbackStateRef.current.hasStarted) return
    playbackStateRef.current = { hasStarted: false, isPlaying: false, isEnded: false }
    hasStartedRef.current = false
  }, [item.id])

  useEffect(
    () =>
      useMediaProjectionStore.subscribe((state) => {
        const confirmed = state.typeStates.video
        setPendingSeek((pending) => {
          if (!pending || pending.itemId !== item.id) return pending
          if (confirmed?.seekable !== true) return null
          return confirmed.currentTime !== undefined &&
            Math.abs(confirmed.currentTime - pending.time) <= 1
            ? null
            : pending
        })
      }),
    [item.id]
  )

  useEffect(() => {
    let revokeSource: (() => void) | null = null
    let cancelled = false

    async function load(): Promise<void> {
      setError(false)
      if (usesProjectionVlc) return
      if (remoteSourceUrl !== undefined) {
        if (remoteSourceUrl) setVideoSrc(remoteSourceUrl)
        return
      }
      const db = await openFileExplorerDB()
      const source = await getFileSource(db, blobId, item.mimeType)
      if (cancelled) {
        source?.revoke()
        return
      }
      if (!source) {
        setError(true)
        toast.warning(t('fileExplorer.blobLoadFailed'))
        return
      }
      revokeSource = source.revoke
      setVideoSrc(source.url)
    }

    void load()
    return () => {
      cancelled = true
      revokeSource?.()
      setVideoSrc(null)
      isDraggingSeekRef.current = false
      setIsDraggingSeek(false)
      if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current)
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
      if (seekFlashTimeoutRef.current) clearTimeout(seekFlashTimeoutRef.current)
    }
  }, [blobId, item.mimeType, remoteSourceUrl, retryToken, t, usesProjectionVlc])

  const triggerFlash = useCallback((icon: 'play' | 'pause'): void => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    flashKeyRef.current += 1
    setFlashState({ icon, key: flashKeyRef.current })
    flashTimeoutRef.current = setTimeout(() => setFlashState(null), 1100)
  }, [])

  const triggerSeekFlash = useCallback((offsetSeconds: number): void => {
    if (offsetSeconds === 0) return
    const direction: SeekFlashDirection = offsetSeconds > 0 ? 'forward' : 'backward'
    const previous = seekFlashAccumulatorRef.current
    const seconds =
      previous?.direction === direction
        ? previous.seconds + Math.abs(offsetSeconds)
        : Math.abs(offsetSeconds)

    if (seekFlashTimeoutRef.current) clearTimeout(seekFlashTimeoutRef.current)
    seekFlashAccumulatorRef.current = { direction, seconds }
    seekFlashKeyRef.current += 1
    setSeekFlashState({ direction, seconds, key: seekFlashKeyRef.current })
    seekFlashTimeoutRef.current = setTimeout(() => {
      seekFlashAccumulatorRef.current = null
      setSeekFlashState(null)
    }, 1100)
  }, [])

  const handlePlayPause = useCallback((): void => {
    if (usesProjectionVlc) {
      if (displayedIsEnded) {
        triggerFlash('play')
        sendCommand({ action: 'seek', itemId: item.id, value: 0 })
        sendCommand({ action: 'play', itemId: item.id })
      } else if (displayedIsPlaying) {
        triggerFlash('pause')
        sendCommand({ action: 'pause', itemId: item.id })
      } else {
        if (hasStartedRef.current) triggerFlash('play')
        sendCommand({ action: 'play', itemId: item.id })
      }
      return
    }
    if (!videoRef.current) return
    if (displayedIsEnded) {
      triggerFlash('play')
      videoRef.current.currentTime = 0
      setPlaybackState({ hasStarted: true, isPlaying: true, isEnded: false })
      videoRef.current
        .play()
        .then(() => setPlaybackState({ hasStarted: true, isPlaying: true, isEnded: false }))
        .catch(() => setPlaybackState({ isPlaying: false }))
      sendCommand({ action: 'seek', itemId: item.id, value: 0 })
      sendCommand({ action: 'play', itemId: item.id })
    } else if (displayedIsPlaying) {
      triggerFlash('pause')
      setPlaybackState({ isPlaying: false })
      videoRef.current.pause()
      sendCommand({ action: 'pause', itemId: item.id })
    } else {
      if (hasStartedRef.current) triggerFlash('play')
      setPlaybackState({ hasStarted: true, isPlaying: true, isEnded: false })
      videoRef.current
        .play()
        .then(() => setPlaybackState({ hasStarted: true, isPlaying: true, isEnded: false }))
        .catch(() => setPlaybackState({ isPlaying: false }))
      sendCommand({ action: 'play', itemId: item.id })
    }
  }, [
    displayedIsEnded,
    displayedIsPlaying,
    item.id,
    sendCommand,
    setPlaybackState,
    triggerFlash,
    usesProjectionVlc
  ])

  const pauseVideo = useCallback((): void => {
    if (!displayedIsPlaying) return
    if (usesProjectionVlc) {
      triggerFlash('pause')
      sendCommand({ action: 'pause', itemId: item.id })
      return
    }
    if (!videoRef.current) return
    triggerFlash('pause')
    setPlaybackState({ isPlaying: false })
    videoRef.current.pause()
    sendCommand({ action: 'pause', itemId: item.id })
  }, [displayedIsPlaying, item.id, sendCommand, setPlaybackState, triggerFlash, usesProjectionVlc])

  useEffect(() => {
    const handleTogglePlay = (): void => {
      handlePlayPause()
    }
    window.addEventListener('media:togglePlay', handleTogglePlay)
    window.addEventListener('media:pauseVideo', pauseVideo)
    return () => {
      window.removeEventListener('media:togglePlay', handleTogglePlay)
      window.removeEventListener('media:pauseVideo', pauseVideo)
    }
  }, [handlePlayPause, pauseVideo])

  const handleVolumeChange = useCallback(
    (val: number): void => {
      setVolume(val)
      setIsMuted(val === 0)
      if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current)
      volumeDebounceRef.current = setTimeout(() => {
        sendCommand({ action: 'volume', itemId: item.id, value: val })
      }, 100)
    },
    [item.id, sendCommand]
  )

  const handleVolumeIconClick = useCallback((): void => {
    const newMuted = !isMuted
    setIsMuted(newMuted)
    const effectiveVol = newMuted ? 0 : volume || 0.8
    if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current)
    volumeDebounceRef.current = setTimeout(() => {
      sendCommand({ action: 'volume', itemId: item.id, value: effectiveVol })
    }, 100)
  }, [isMuted, item.id, volume, sendCommand])

  const syncVideoMetadata = useCallback((): void => {
    const video = videoRef.current
    if (!video) return
    const nextDuration =
      metadataDuration ??
      (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0)
    durationRef.current = nextDuration
    setDuration(nextDuration)
    currentTimeRef.current = video.currentTime
    setCurrentTime(video.currentTime)
  }, [metadataDuration])

  const commitSeek = useCallback(
    (seekTo: number): void => {
      if (!seekable) return
      const durationValue = durationRef.current
      const max = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : seekTo
      const clamped = Math.max(0, Math.min(seekTo, max))
      isDraggingSeekRef.current = false
      setIsDraggingSeek(false)
      currentTimeRef.current = clamped
      localSeekTimeRef.current = clamped
      setLocalSeekTime(clamped)
      setPendingSeek({ itemId: item.id, time: clamped })
      setCurrentTime(clamped)
      if (videoRef.current && !usesProjectionVlc) videoRef.current.currentTime = clamped
      sendCommand({ action: 'seek', itemId: item.id, value: clamped })
    },
    [item.id, seekable, sendCommand, usesProjectionVlc]
  )

  useEffect(() => {
    const handleRelativeSeek = (event: Event): void => {
      const detail = (event as CustomEvent<{ seconds?: number }>).detail
      const offset = detail?.seconds
      if (!seekable || typeof offset !== 'number' || !Number.isFinite(offset)) return
      const base = usesProjectionVlc
        ? (projectionPlaybackState?.currentTime ?? currentTimeRef.current)
        : videoRef.current && videoRef.current.readyState >= 1
          ? videoRef.current.currentTime
          : currentTimeRef.current
      commitSeek(base + offset)
      triggerSeekFlash(offset)
    }

    window.addEventListener('media:videoSeekRelative', handleRelativeSeek)
    return () => window.removeEventListener('media:videoSeekRelative', handleRelativeSeek)
  }, [
    commitSeek,
    projectionPlaybackState?.currentTime,
    seekable,
    triggerSeekFlash,
    usesProjectionVlc
  ])

  const releaseSeekPointer = useCallback((target: HTMLInputElement, pointerId: number): void => {
    if (target.hasPointerCapture?.(pointerId)) {
      target.releasePointerCapture(pointerId)
    }
  }, [])

  if (error && !usesProjectionVlc) {
    return (
      <PreviewLoadError
        message={t('presenter.videoLoadFailed')}
        retryLabel={t('presenter.retry')}
        onRetry={() => setRetryToken((value) => value + 1)}
      />
    )
  }

  return (
    <div className="w-full h-full relative bg-black">
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform,
          transformOrigin: 'center center',
          transition: 'transform 0.15s ease'
        }}
      >
        {usesProjectionVlc ? (
          <div className="relative flex h-full w-full items-center justify-center">
            {(liveFrame?.key === previewKey || thumbnails?.[item.id]) && (
              <img
                data-vlc-live-preview={liveFrame?.key === previewKey ? 'true' : 'false'}
                src={
                  liveFrame?.key === previewKey
                    ? liveFrame.imageDataUrl
                    : (thumbnails?.[item.id] ?? undefined)
                }
                alt=""
                className="h-full w-full object-contain"
              />
            )}
            <p className="absolute bottom-20 rounded bg-black/70 px-3 py-2 text-sm text-white/80">
              {t(
                livePreviewFailed
                  ? 'presenter.videoLivePreviewFailed'
                  : liveFrame?.key === previewKey
                    ? 'presenter.videoLivePreview'
                    : 'presenter.videoLivePreviewWaiting'
              )}
            </p>
          </div>
        ) : videoSrc ? (
          <MediaElement
            ref={(element) => {
              videoRef.current = element
            }}
            src={videoSrc}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            onTimeUpdate={() => {
              const value = videoRef.current?.currentTime ?? 0
              currentTimeRef.current = value
              setCurrentTime(value)
            }}
            onLoadedMetadata={syncVideoMetadata}
            onCanPlay={syncVideoMetadata}
            onDurationChange={syncVideoMetadata}
            onPlay={() => setPlaybackState({ hasStarted: true, isPlaying: true, isEnded: false })}
            onPause={() => setPlaybackState({ isPlaying: false })}
            onEnded={() => {
              setPlaybackState({ isPlaying: false, isEnded: true })
            }}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/60" />
        )}
      </div>

      {isPreparing && (
        <div
          role="status"
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/75 text-white"
        >
          <p>
            {t(
              projectionPlaybackState?.preparationPhase === 'inspection'
                ? 'presenter.videoInspecting'
                : projectionPlaybackState?.preparationPhase === 'remux'
                  ? 'presenter.videoRemuxing'
                  : 'presenter.videoInitializing'
            )}
          </p>
          {cancelPreparation && (
            <>
              <button
                type="button"
                className="rounded border border-white/50 px-3 py-2 focus-visible:outline-2 focus-visible:outline-white"
                onClick={(event) => {
                  event.stopPropagation()
                  cancelPreparation()
                }}
              >
                {t('presenter.videoCancelPreparation')}
              </button>
              <p className="max-w-sm px-4 text-center text-xs text-white/70">
                {t('presenter.videoCancelKeepsCache')}
              </p>
            </>
          )}
        </div>
      )}

      {!displayedHasStarted && !isPreparing && (
        <button
          className="absolute inset-0 flex items-center justify-center z-10 cursor-pointer"
          onClick={handlePlayPause}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="rounded-full p-4 presenter-media-control">
            <Play size={70} weight="fill" />
          </div>
        </button>
      )}

      {flashState && (
        <div
          key={flashState.key}
          className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none video-flash-icon"
        >
          <div className="rounded-full p-4 presenter-media-control">
            {flashState.icon === 'play' ? (
              <Play size={70} weight="fill" />
            ) : (
              <Pause size={70} weight="fill" />
            )}
          </div>
        </div>
      )}

      {seekFlashState && (
        <div
          className={`absolute top-1/2 z-20 -translate-y-1/2 pointer-events-none ${
            seekFlashState.direction === 'forward' ? 'right-6' : 'left-6'
          }`}
          data-testid="video-seek-flash"
        >
          <div
            key={seekFlashState.key}
            className="rounded-full px-5 py-3 presenter-media-control text-white text-3xl font-semibold tabular-nums video-flash-icon"
          >
            {seekFlashState.direction === 'forward' ? '+' : '-'}
            {seekFlashState.seconds}
          </div>
        </div>
      )}

      {displayedHasStarted && !displayedIsEnded && !isPreparing && (
        <button
          className="absolute inset-0 z-10 cursor-pointer"
          aria-label={t('fileExplorer.presenter.togglePlay', 'Toggle play')}
          onClick={handlePlayPause}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}

      {displayedDuration > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 z-20"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            type="range"
            min={0}
            max={displayedDuration || 1}
            step={0.1}
            disabled={!seekable}
            value={isDraggingSeek ? localSeekTime : displayedCurrentTime}
            className="video-seek-range w-full"
            ref={seekInputRef}
            style={
              {
                '--seek-fill': `${(((isDraggingSeek ? localSeekTime : displayedCurrentTime) / (displayedDuration || 1)) * 100).toFixed(2)}%`
              } as React.CSSProperties
            }
            onPointerDown={(e) => {
              const value = Number(e.currentTarget.value)
              isDraggingSeekRef.current = true
              setIsDraggingSeek(true)
              localSeekTimeRef.current = value
              setLocalSeekTime(value)
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onInput={(e) => {
              const value = Number(e.currentTarget.value)
              localSeekTimeRef.current = value
              setLocalSeekTime(value)
              if (!isDraggingSeekRef.current) {
                commitSeek(value)
              }
            }}
            onPointerUp={(e) => {
              const seekTo = Number((e.target as HTMLInputElement).value)
              localSeekTimeRef.current = seekTo
              releaseSeekPointer(e.currentTarget, e.pointerId)
              commitSeek(localSeekTimeRef.current)
              e.currentTarget.blur()
            }}
            onPointerCancel={(e) => {
              releaseSeekPointer(e.currentTarget, e.pointerId)
              isDraggingSeekRef.current = false
              setIsDraggingSeek(false)
              e.currentTarget.blur()
            }}
          />

          <div className="flex items-stretch pl-2 pb-2 gap-2">
            <div className="inline-flex rounded-full presenter-media-control">
              <button
                className="w-11 h-11 inline-flex items-center justify-center text-white/80 hover:text-white rounded-full transition-colors"
                onClick={handlePlayPause}
              >
                {displayedIsEnded ? (
                  <ArrowCounterClockwise size={24} weight="fill" />
                ) : displayedIsPlaying ? (
                  <Pause size={24} weight="fill" />
                ) : (
                  <Play size={24} weight="fill" />
                )}
              </button>
            </div>

            <div
              className="inline-flex items-center rounded-full presenter-media-control"
              onMouseEnter={() => setIsVolumeHovered(true)}
              onMouseLeave={() => setIsVolumeHovered(false)}
            >
              <button
                className="w-11 h-11 inline-flex items-center justify-center text-white/80 hover:text-white rounded-full transition-colors"
                onClick={handleVolumeIconClick}
              >
                {isMuted || volume === 0 ? (
                  <SpeakerX size={24} weight="fill" />
                ) : volume < 0.4 ? (
                  <SpeakerLow size={24} weight="fill" />
                ) : (
                  <SpeakerHigh size={24} weight="fill" />
                )}
              </button>
              <div
                style={{
                  width: isVolumeHovered ? '100px' : '0',
                  overflow: 'hidden',
                  transition: 'width 0.25s ease, padding-right 0.25s ease',
                  opacity: isVolumeHovered ? 1 : 0,
                  paddingRight: isVolumeHovered ? '8px' : '0'
                }}
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  className="vol-range w-full cursor-pointer pr-3"
                  style={
                    {
                      '--vol-fill': `${((isMuted ? 0 : volume) * 100).toFixed(1)}%`
                    } as React.CSSProperties
                  }
                  onPointerUp={(e) => e.currentTarget.blur()}
                  onPointerCancel={(e) => e.currentTarget.blur()}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="inline-flex items-center rounded-full presenter-media-control px-4 py-2.5">
              <span className="text-white/70 text-base tabular-nums whitespace-nowrap">
                {formatTime(displayedCurrentTime)} / {formatTime(displayedDuration)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
