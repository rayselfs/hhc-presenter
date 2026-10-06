import { isCameraState, type CameraState } from '@shared/camera'
import type {
  FileControlPayload,
  ProjectionChannel,
  ProjectionMediaReplayState,
  ProjectionPayload
} from '@shared/projection-messages'

export interface ProjectionRenderState {
  camera: CameraState | null
  showDefault: boolean
  isBlackout: boolean
  activeContent: 'timer' | 'bible' | 'file' | 'camera' | null
  timerData: ProjectionPayload<'timer:tick'> | null
  stopwatchData: ProjectionPayload<'timer:stopwatch'> | null
  bibleChapter: ProjectionPayload<'bible:chapter'> | null
  bibleSettings: ProjectionPayload<'bible:settings'>
  fileData: ProjectionPayload<'file:show'> | null
  mediaReplayState: ProjectionMediaReplayState | null
  fileControlEvent: { id: number; data: FileControlPayload } | null
  timerRingColor: string | null
  generation: number
  vlcStartRevision: number
}

export type ProjectionRenderAction =
  | { type: 'replay'; payload: ProjectionPayload<'__system:replay'> }
  | {
      type: 'message'
      channel: ProjectionChannel
      data: ProjectionPayload<ProjectionChannel>
    }

export const initialProjectionRenderState: ProjectionRenderState = {
  camera: null,
  showDefault: true,
  isBlackout: false,
  activeContent: null,
  timerData: null,
  stopwatchData: null,
  bibleChapter: null,
  bibleSettings: { fontSize: 90 },
  fileData: null,
  mediaReplayState: null,
  fileControlEvent: null,
  timerRingColor: null,
  generation: 0,
  vlcStartRevision: 0
}

export function reduceProjectionRenderState(
  state: ProjectionRenderState,
  action: ProjectionRenderAction
): ProjectionRenderState {
  if (action.type === 'replay') {
    const { generation, snapshot, pendingFileControls } = action.payload
    const confirmedMediaState = snapshot.media.state
    const mediaReplayState =
      confirmedMediaState && pendingFileControls?.itemId === confirmedMediaState.itemId
        ? {
            ...confirmedMediaState,
            ...(pendingFileControls.seekSeconds !== undefined
              ? { positionSeconds: pendingFileControls.seekSeconds }
              : {}),
            ...(pendingFileControls.volume !== undefined
              ? { volume: pendingFileControls.volume }
              : {}),
            ...(pendingFileControls.transport
              ? {
                  isPlaying: pendingFileControls.transport === 'play',
                  ...(pendingFileControls.transport === 'play' ? { isEnded: false } : {})
                }
              : {})
          }
        : confirmedMediaState
    return {
      camera: isCameraState(snapshot.camera) ? snapshot.camera : null,
      showDefault: snapshot.showDefault,
      isBlackout: snapshot.isBlackout,
      activeContent: snapshot.owner === 'media' ? 'file' : snapshot.owner,
      timerData: snapshot.timer.tick,
      stopwatchData: snapshot.timer.stopwatch,
      bibleChapter: snapshot.bible.chapter,
      bibleSettings: snapshot.bible.settings ?? { fontSize: 90 },
      fileData: snapshot.media.show,
      mediaReplayState,
      fileControlEvent: null,
      timerRingColor: snapshot.timer.ringColor?.color ?? null,
      generation,
      vlcStartRevision: state.vlcStartRevision + 1
    }
  }

  const { channel, data } = action
  switch (channel) {
    case 'camera:state':
      return isCameraState(data) ? { ...state, camera: data } : state
    case '__system:blank':
      return {
        ...state,
        showDefault: (data as ProjectionPayload<'__system:blank'>).showDefault
      }
    case '__system:blackout':
      return {
        ...state,
        isBlackout: (data as ProjectionPayload<'__system:blackout'>).enabled
      }
    case '__system:active-owner': {
      const owner = (data as ProjectionPayload<'__system:active-owner'>).owner
      return {
        ...state,
        activeContent:
          owner === 'media'
            ? 'file'
            : owner === 'camera'
              ? 'camera'
              : owner === 'bible'
                ? 'bible'
                : 'timer'
      }
    }
    case 'timer:tick':
      return {
        ...state,
        activeContent: 'timer',
        timerData: data as ProjectionPayload<'timer:tick'>
      }
    case 'timer:stopwatch':
      return { ...state, stopwatchData: data as ProjectionPayload<'timer:stopwatch'> }
    case 'bible:chapter':
      return {
        ...state,
        activeContent: 'bible',
        bibleChapter: data as ProjectionPayload<'bible:chapter'>
      }
    case 'bible:settings':
      return { ...state, bibleSettings: data as ProjectionPayload<'bible:settings'> }
    case 'file:show': {
      const nextFile = data as ProjectionPayload<'file:show'>
      const earlyControl =
        !state.fileData &&
        state.fileControlEvent &&
        'itemId' in state.fileControlEvent.data &&
        state.fileControlEvent.data.itemId === nextFile.itemId
          ? state.fileControlEvent
          : null
      return {
        ...state,
        activeContent: 'file',
        fileData: data as ProjectionPayload<'file:show'>,
        fileControlEvent: earlyControl,
        mediaReplayState: null
      }
    }
    case 'file:control': {
      const control = data as FileControlPayload
      if (
        state.fileData &&
        'itemId' in control &&
        control.itemId !== undefined &&
        control.itemId !== state.fileData?.itemId
      )
        return state
      const pdf = state.fileData?.pdf ?? { page: 1, scroll: 0, viewMode: 'single' as const }
      const nextPdf =
        control.action === 'pdfPage'
          ? { ...pdf, page: control.value }
          : control.action === 'pdfScroll'
            ? { ...pdf, scroll: control.value }
            : control.action === 'pdfViewMode'
              ? { ...pdf, viewMode: control.value }
              : null
      return {
        ...state,
        ...(nextPdf && state.fileData?.mimeType === 'application/pdf'
          ? {
              fileData: { ...state.fileData, pdf: nextPdf },
              mediaReplayState: state.mediaReplayState
                ? {
                    ...state.mediaReplayState,
                    pdfPage: nextPdf.page,
                    pdfScroll: nextPdf.scroll,
                    pdfViewMode: nextPdf.viewMode
                  }
                : null
            }
          : {}),
        fileControlEvent: {
          id: (state.fileControlEvent?.id ?? 0) + 1,
          data: control
        }
      }
    }
    case 'settings:timer-ring-color':
      return {
        ...state,
        timerRingColor: (data as ProjectionPayload<'settings:timer-ring-color'>).color
      }
    default:
      return state
  }
}

export function selectVisibleProjection(
  state: ProjectionRenderState
): 'blackout' | 'default' | 'timer' | 'bible' | 'file' | 'camera' {
  if (state.isBlackout) return 'blackout'
  if (state.showDefault) return 'default'
  if (state.activeContent === 'timer' && state.timerData) return 'timer'
  if (state.activeContent === 'bible' && state.bibleChapter) return 'bible'
  if (state.activeContent === 'camera' && state.camera) return 'camera'
  if (state.activeContent === 'file' && state.fileData) return 'file'
  return 'default'
}
