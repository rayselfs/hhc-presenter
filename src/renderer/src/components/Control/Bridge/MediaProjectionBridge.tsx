import { useEffect, useMemo } from 'react'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { useHhcAuth } from '@renderer/contexts/HhcAuthContext'
import {
  useMediaProjectionSync,
  type HhcProjectionAccessRevoked
} from '@renderer/lib/media-projection-sync'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'

export default function MediaProjectionBridge({
  onHhcAccessRevoked
}: {
  onHhcAccessRevoked?: (scope: HhcProjectionAccessRevoked) => void
}): null {
  const { on, isProjectionOpen, recovery } = useProjection()
  const { session, getAccessToken, getAuthGeneration, refreshAfterUnauthorized, endSession } =
    useHhcAuth()
  const auth = useMemo(
    () => ({
      getSession: () => session,
      getAuthGeneration,
      getAccessToken,
      refreshAfterUnauthorized,
      endSession
    }),
    [endSession, getAccessToken, getAuthGeneration, refreshAfterUnauthorized, session]
  )

  useMediaProjectionSync({ auth, onAccessRevoked: onHhcAccessRevoked })

  useEffect(() => {
    return on('file:playback-state', (data) => {
      const state = useMediaProjectionStore.getState()
      if (state.currentItem()?.id !== data.itemId) return
      const current = state.typeStates.video
      state.setTypeState('video', {
        phase: data.phase,
        hasStarted: (current?.hasStarted ?? false) || data.currentTime > 0 || data.isPlaying,
        isPlaying: data.isPlaying,
        isEnded: data.isEnded,
        currentTime: data.currentTime,
        duration: data.duration,
        seekable: data.seekable,
        volume: data.volume
      })
    })
  }, [on])

  useEffect(() => {
    if (isProjectionOpen || recovery.status !== 'closed') return
    const state = useMediaProjectionStore.getState()
    if (!state.isPresenting && state.playlist.length === 0) return
    state.markProjectionClosed()
  }, [isProjectionOpen, recovery.status])

  return null
}
