import { useEffect, useRef } from 'react'
import type { ProjectionMediaReplayState } from '@shared/projection-messages'

export default function VlcProjectionSurface({
  itemId,
  blobId,
  contentRevision,
  durationMs,
  replayState,
  playbackVariant,
  startRevision
}: {
  itemId: string | null
  blobId?: string
  contentRevision?: number
  durationMs?: number
  replayState?: ProjectionMediaReplayState | null
  playbackVariant?: 'source' | 'matroska-remux'
  startRevision?: number
}): React.JSX.Element {
  const contentRevisionRef = useRef(contentRevision)
  useEffect(() => {
    contentRevisionRef.current = contentRevision
  }, [contentRevision])
  useEffect(() => {
    if (!itemId || !blobId) return undefined
    const attemptId = crypto.randomUUID()
    void window.api?.projectionVlc
      ?.start({
        itemId,
        contentRevision: contentRevisionRef.current,
        attemptId,
        sourceFileId: blobId,
        container: '#vlc-player',
        durationMs,
        playbackVariant,
        initialPositionSeconds:
          replayState?.itemId === itemId ? replayState.positionSeconds : undefined,
        initialVolume: replayState?.itemId === itemId ? replayState.volume : undefined,
        initialPlaybackState:
          replayState?.itemId !== itemId
            ? undefined
            : replayState.isEnded
              ? 'ended'
              : replayState.isPlaying
                ? 'playing'
                : 'paused'
      })
      .catch((error) => {
        console.error('[projection-vlc] Failed to start embedded VLC playback', error)
      })
    return () => {
      void window.api?.projectionVlc?.stop({ itemId, attemptId })
    }
  }, [blobId, durationMs, itemId, playbackVariant, replayState, startRevision])

  return <div id="vlc-player" className="h-full w-full bg-black" />
}
