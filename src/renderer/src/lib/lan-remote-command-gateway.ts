import {
  resolveMediaProjectionAction,
  useMediaProjectionStore
} from '@renderer/stores/media-projection'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { useTimerStore } from '@renderer/stores/timer'
import { getMediaType } from '@renderer/lib/presentability'
import { executeTimerRuntimeCommand } from './timer-runtime-client'
import {
  sanitizeLanRemoteSnapshot,
  type LanRemoteAck,
  type LanRemoteCommand
} from '@shared/lan-remote'
import type { LanRemoteSnapshot } from '@shared/lan-remote'

let revision = 0

function rejected(requestId: string, reason: string): LanRemoteAck {
  return { requestId, status: 'rejected', reason }
}

function accept(requestId: string): LanRemoteAck {
  revision += 1
  return { requestId, status: 'accepted' }
}

export async function executeLanRemoteCommand(command: LanRemoteCommand): Promise<LanRemoteAck> {
  if (
    'requiredRevision' in command &&
    command.requiredRevision !== undefined &&
    command.requiredRevision !== revision
  ) {
    return rejected(command.requestId, 'stale-revision')
  }

  const projection = useMediaProjectionStore.getState()

  switch (command.type) {
    case 'presentation:prev':
      if (!projection.isPresenting) {
        return rejected(command.requestId, 'presentation-not-active')
      }
      if (!projection.canPrev()) return rejected(command.requestId, 'previous-unavailable')
      if ((await resolveMediaProjectionAction(projection.prev())).status !== 'success') {
        return rejected(command.requestId, 'presentation-finalization-blocked')
      }
      return accept(command.requestId)
    case 'presentation:next':
      if (!projection.isPresenting) {
        return rejected(command.requestId, 'presentation-not-active')
      }
      if (!projection.canNext()) return rejected(command.requestId, 'next-unavailable')
      if ((await resolveMediaProjectionAction(projection.next())).status !== 'success') {
        return rejected(command.requestId, 'presentation-finalization-blocked')
      }
      return accept(command.requestId)
    case 'presentation:jump':
      if (!projection.isPresenting) {
        return rejected(command.requestId, 'presentation-not-active')
      }
      if (command.index >= projection.playlist.length) {
        return rejected(command.requestId, 'index-out-of-range')
      }
      if (
        (await resolveMediaProjectionAction(projection.jumpTo(command.index))).status !== 'success'
      ) {
        return rejected(command.requestId, 'presentation-finalization-blocked')
      }
      return accept(command.requestId)
    case 'media:play': {
      const current = projection.currentItem()
      if (!projection.isPresenting || !current || getMediaType(current.mimeType) !== 'video') {
        return rejected(command.requestId, 'video-not-active')
      }
      const video = projection.getTypeState('video')
      if (video?.isPlaying) return rejected(command.requestId, 'already-playing')
      projection.setTypeState('video', {
        ...video,
        hasStarted: true,
        isPlaying: true,
        isEnded: false
      })
      return accept(command.requestId)
    }
    case 'media:pause': {
      const current = projection.currentItem()
      if (!projection.isPresenting || !current || getMediaType(current.mimeType) !== 'video') {
        return rejected(command.requestId, 'video-not-active')
      }
      const video = projection.getTypeState('video')
      if (!video?.isPlaying) return rejected(command.requestId, 'already-paused')
      projection.setTypeState('video', {
        ...video,
        isPlaying: false
      })
      return accept(command.requestId)
    }
    case 'timer:command': {
      const result = await executeTimerRuntimeCommand(command.command)
      if (result.status === 'rejected')
        return rejected(
          command.requestId,
          result.reason === 'host-unavailable' ? 'timer-api-unavailable' : result.reason
        )
      return accept(command.requestId)
    }
  }
}

export function createLanRemoteSnapshot(isProjectionOpen: boolean): LanRemoteSnapshot {
  const projection = useMediaProjectionStore.getState()
  const timer = useTimerStore.getState()
  const stopwatch = useStopwatchStore.getState()
  const current = projection.currentItem()
  const next = projection.nextItem()

  return sanitizeLanRemoteSnapshot({
    revision,
    presentation: {
      currentIndex: projection.currentIndex,
      total: projection.playlist.length,
      currentName: current?.name ?? null,
      nextName: next?.name ?? null,
      canPrevious: projection.canPrev(),
      canNext: projection.canNext(),
      isPlaying: projection.isPresenting
    },
    projection: {
      isOpen: isProjectionOpen
    },
    timer: {
      status: timer.status,
      remainingSeconds: timer.remainingSeconds
    },
    stopwatch: {
      status: stopwatch.status,
      elapsedMs: stopwatch.elapsedMs
    }
  })
}
