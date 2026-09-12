import CameraProjection from '@renderer/components/Projection/CameraProjection'
import { useEffect, useReducer } from 'react'
import DefaultProjection from '@renderer/components/Projection/DefaultProjection'
import BibleProjection from '@renderer/components/Projection/BibleProjection'
import TimerProjection from '@renderer/components/Projection/TimerProjection'
import FileProjection from '@renderer/components/Projection/FileProjection'
import { createProjectionAdapter } from '@renderer/lib/projection-adapter'
import { isElectron, isWeb } from '@renderer/lib/env'
import {
  initialProjectionRenderState,
  reduceProjectionRenderState,
  selectVisibleProjection
} from '@renderer/lib/projection-render-state'
import { useSettingsStore } from '@renderer/stores/settings'
import type { ProjectionChannel, ProjectionPayload } from '@shared/projection-messages'

function resolveBrowserProjectionSession(): { generation: number; sessionId: string } {
  const query = location.hash.split('?')[1] ?? ''
  const params = new URLSearchParams(query)
  const generation = Number(params.get('generation'))
  return {
    generation: Number.isSafeInteger(generation) && generation > 0 ? generation : 0,
    sessionId: params.get('session') ?? ''
  }
}

export default function ProjectionPage(): React.JSX.Element {
  const [state, dispatch] = useReducer(reduceProjectionRenderState, initialProjectionRenderState)
  const browserSession = resolveBrowserProjectionSession()

  useEffect(() => {
    const adapter = createProjectionAdapter('projection', browserSession.sessionId)
    const unsubscribers: Array<() => void> = []
    let active = true
    let initialized = false

    const subscribe = <C extends ProjectionChannel>(channel: C): void => {
      unsubscribers.push(
        adapter.on(channel, (data) => {
          dispatch({
            type: 'message',
            channel,
            data: data as ProjectionPayload<ProjectionChannel>
          })
        })
      )
    }

    const initialize = (generation: number): void => {
      if (!active || generation <= 0) return
      adapter.setGeneration(generation)
      dispatch({ type: 'message', channel: '__system:blank', data: { showDefault: true } })
      if (initialized) {
        adapter.send('__system:ready', { generation })
        return
      }
      initialized = true
      unsubscribers.push(
        adapter.on('__system:replay', (payload) => {
          dispatch({ type: 'replay', payload })
          const timezone = payload.snapshot.timer.timezone?.timezone
          if (timezone) useSettingsStore.getState().setTimezone(timezone)
        })
      )
      for (const channel of [
        '__system:blank',
        '__system:blackout',
        '__system:active-owner',
        'timer:tick',
        'timer:stopwatch',
        'bible:chapter',
        'bible:settings',
        'camera:state',
        'file:show',
        'file:control',
        'settings:timer-ring-color'
      ] as const) {
        subscribe(channel)
      }
      unsubscribers.push(
        adapter.on('settings:timezone', ({ timezone }) => {
          useSettingsStore.getState().setTimezone(timezone)
        })
      )

      if (isWeb()) {
        unsubscribers.push(
          adapter.on('__system:close', () => window.close()),
          adapter.on('__system:ping', () => adapter.send('__system:pong', null))
        )
        adapter.send('__system:pong', null)
      }
      adapter.send('__system:ready', { generation })
    }

    if (isElectron()) {
      void window.api.projection.getGeneration().then(({ generation }) => initialize(generation))
      const unsubscribeLifecycle = window.api.projection.onProjectionLifecycle((event) => {
        if (event.status === 'opening' || event.status === 'recovering')
          initialize(event.generation)
      })

      return () => {
        active = false
        unsubscribeLifecycle()
        for (const unsubscribe of unsubscribers) unsubscribe()
        adapter.dispose()
      }
    } else {
      initialize(browserSession.generation)
    }

    return () => {
      active = false
      for (const unsubscribe of unsubscribers) unsubscribe()
      adapter.dispose()
    }
  }, [browserSession.generation, browserSession.sessionId])

  useEffect(() => {
    if (state.isBlackout || state.showDefault || state.activeContent !== 'file') {
      void window.api?.projectionVlc?.stop({ force: true })
    }
  }, [state.activeContent, state.isBlackout, state.showDefault])

  const visible = selectVisibleProjection(state)
  if (state.activeContent === 'camera' && state.camera && !state.showDefault) {
    return (
      <>
        <CameraProjection
          camera={state.camera}
          generation={state.generation || browserSession.generation}
          browserSessionId={browserSession.sessionId}
        />
        {state.isBlackout && (
          <div className="fixed inset-0 bg-black" data-testid="projection-blackout" />
        )}
      </>
    )
  }
  if (visible === 'blackout') {
    return <div className="h-screen w-screen bg-black" data-testid="projection-blackout" />
  }
  if (visible === 'bible' && state.bibleChapter) {
    return <BibleProjection data={state.bibleChapter} settings={state.bibleSettings} />
  }
  if (visible === 'file' && state.fileData) {
    return (
      <FileProjection
        generation={state.generation}
        projectionSessionId={browserSession.sessionId}
        initialReplayState={state.mediaReplayState}
        fileName={state.fileData.fileName}
        initialItemId={state.fileData.itemId}
        initialBlobId={state.fileData.blobId}
        initialMimeType={state.fileData.mimeType}
        initialStreamUrl={state.fileData.streamUrl}
        initialPlaybackMode={state.fileData.playbackMode}
        initialPlaybackVariant={state.fileData.playbackVariant}
        vlcStartRevision={state.vlcStartRevision}
        initialSeekable={state.fileData.seekable}
        initialDurationMs={state.fileData.durationMs}
        initialPresentation={state.fileData.presentation}
        initialEditablePresentation={state.fileData.editablePresentation}
        controlEvent={state.fileControlEvent}
      />
    )
  }
  if (visible === 'timer' && state.timerData) {
    return (
      <TimerProjection
        timerData={state.timerData}
        stopwatchData={state.stopwatchData}
        ringColor={state.timerRingColor ?? undefined}
      />
    )
  }
  return <DefaultProjection />
}
