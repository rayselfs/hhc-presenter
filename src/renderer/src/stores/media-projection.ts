import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import type { FileItemRecord } from '@shared/types/folder'
import { getBlobId } from '@renderer/lib/blob-identity'
import { getMediaType, type MediaType, type MediaTypeStateMap } from '@renderer/lib/presentability'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { lockMediaResources } from '@renderer/lib/media-resource-locks'
import {
  prepareMediaProjection,
  type MediaProjectionPreflightResult
} from '@renderer/lib/media-projection-preflight'
import { isEditablePresentationMimeType } from '@renderer/lib/presentation-media'
import {
  analyzePresentationReadiness,
  createPresentationSnapshot,
  getPresentationSnapshotResourceIds,
  type PresentationReadinessReport,
  type PresentationSnapshot
} from '@renderer/lib/presentation-readiness'
import { ensureSyncItemAvailableForPresentation } from '@renderer/lib/cloud-provider'
import { isPersonalRecordVisible, usePersonalSyncStore } from './personal-sync'

interface StartPresentationWithReadinessOptions {
  prioritizeStartItem?: boolean
  presentationState?: MediaTypeStateMap['presentation']
}

export type MediaProjectionActionOutcome = {
  status: 'success' | 'blocked' | 'superseded' | 'noop'
}

export type MediaProjectionActionResult = boolean | Promise<MediaProjectionActionOutcome>

export async function resolveMediaProjectionAction(
  result: MediaProjectionActionResult
): Promise<MediaProjectionActionOutcome> {
  const resolved = await result
  return typeof resolved === 'boolean' ? { status: resolved ? 'success' : 'noop' } : resolved
}

export interface MediaProjectionStore {
  playlist: FileItemRecord[]
  currentIndex: number
  isPresenting: boolean
  sessionRevision: number
  isEnded: boolean
  showGrid: boolean
  lastReadinessReport: PresentationReadinessReport | null
  snapshot: PresentationSnapshot | null
  typeStates: Partial<{ [K in MediaType]: MediaTypeStateMap[K] }>
  zoomLevel: number
  pan: { x: number; y: number }

  currentItem: () => FileItemRecord | null
  nextItem: () => FileItemRecord | null
  prevItem: () => FileItemRecord | null
  canNext: () => boolean
  canPrev: () => boolean
  progress: () => string

  startPresentation: (files: FileItemRecord[], startIndex: number) => MediaProjectionActionResult
  exit: () => void
  endLiveSession: () => void
  markProjectionClosed: () => void
  next: () => MediaProjectionActionResult
  prev: () => MediaProjectionActionResult
  jumpTo: (index: number) => MediaProjectionActionResult
  jumpToSlide: (index: number) => MediaProjectionActionResult
  toggleGrid: () => void
  getTypeState: <K extends MediaType>(type: K) => MediaTypeStateMap[K] | undefined
  setTypeState: <K extends MediaType>(type: K, value: MediaTypeStateMap[K]) => void
  setZoomLevel: (level: number) => void
  resetZoom: () => void
  setPan: (x: number, y: number) => void
  updateNotes: (itemId: string, notes: string) => void
  startPresentationWithReadiness: (
    files: FileItemRecord[],
    startIndex: number,
    options?: StartPresentationWithReadinessOptions
  ) => Promise<PresentationReadinessReport>
}

const initialTypeStates: Partial<{ [K in MediaType]: MediaTypeStateMap[K] }> = {
  pdf: { viewMode: 'slide' as const, thumbsCollapsed: false }
}

const initialState = {
  playlist: [] as FileItemRecord[],
  currentIndex: 0,
  isPresenting: false,
  sessionRevision: 0,
  isEnded: false,
  showGrid: false,
  lastReadinessReport: null as PresentationReadinessReport | null,
  snapshot: null as PresentationSnapshot | null,
  typeStates: initialTypeStates,
  zoomLevel: 1,
  pan: { x: 0, y: 0 }
}

let releaseProjectionLocks: (() => void) | null = null
let projectionActionGeneration = 0

function beginProjectionAction(): number {
  projectionActionGeneration += 1
  return projectionActionGeneration
}

function isCurrentProjectionAction(generation: number): boolean {
  return generation === projectionActionGeneration
}

function clearLiveSession(set: StoreApi<MediaProjectionStore>['setState']): void {
  releaseProjectionLocks?.()
  releaseProjectionLocks = null
  set({ ...initialState })
}

function withoutTransientMediaRuntimeState(
  typeStates: MediaProjectionStore['typeStates']
): MediaProjectionStore['typeStates'] {
  const next = { ...typeStates }
  delete next.video
  delete next.presentation
  return next
}

function getCurrentPresentationState(
  state: Pick<MediaProjectionStore, 'playlist' | 'currentIndex' | 'typeStates'>
): MediaTypeStateMap['presentation'] | null {
  const item = state.playlist[state.currentIndex]
  if (!item || getMediaType(item.mimeType) !== 'presentation') return null
  return state.typeStates.presentation ?? { slideIndex: 0 }
}

type ProjectionPreflightValue = boolean | MediaProjectionPreflightResult

function isReadyPreflight(value: ProjectionPreflightValue): boolean {
  return value === true || (typeof value !== 'boolean' && value.status === 'ready')
}

function validatesPreflight(value: ProjectionPreflightValue): boolean {
  if (typeof value === 'boolean' || value.status !== 'ready') return true
  try {
    return value.validate?.() !== false
  } catch {
    return false
  }
}

function commitAfterPreflight(
  generation: number,
  result:
    | boolean
    | MediaProjectionPreflightResult
    | Promise<boolean | MediaProjectionPreflightResult>,
  commit: () => void,
  isCurrent = (): boolean => true
): MediaProjectionActionResult {
  const canCommit = (): boolean => isCurrentProjectionAction(generation) && isCurrent()
  if (!(result instanceof Promise)) {
    if (!isReadyPreflight(result) || !canCommit() || !validatesPreflight(result)) return false
    commit()
    return true
  }
  return result.then(
    (ready) => {
      if (!isReadyPreflight(ready)) return { status: 'blocked' }
      if (!canCommit() || !validatesPreflight(ready)) return { status: 'superseded' }
      commit()
      return { status: 'success' }
    },
    () => ({ status: 'blocked' })
  )
}

function editablePreflightItems(
  ...items: Array<FileItemRecord | null | undefined>
): FileItemRecord[] {
  return items.filter(
    (item, index, values): item is FileItemRecord =>
      item !== null &&
      item !== undefined &&
      isEditablePresentationMimeType(item.mimeType) &&
      values.indexOf(item) === index
  )
}

function prepareEditableProjection(
  ...items: Array<FileItemRecord | null | undefined>
): boolean | MediaProjectionPreflightResult | Promise<boolean | MediaProjectionPreflightResult> {
  const editableItems = editablePreflightItems(...items)
  return editableItems.length > 0 ? prepareMediaProjection(editableItems) : true
}

function isSameNavigationState(
  state: MediaProjectionStore,
  get: StoreApi<MediaProjectionStore>['getState']
): boolean {
  const current = get()
  return (
    current.playlist === state.playlist &&
    current.currentIndex === state.currentIndex &&
    current.isPresenting === state.isPresenting &&
    current.isEnded === state.isEnded &&
    current.sessionRevision === state.sessionRevision &&
    current.typeStates.presentation === state.typeStates.presentation
  )
}

function blockedReadinessReport(
  item: FileItemRecord | undefined,
  reason: 'presentation-finalization-blocked' | 'presentation-projection-superseded'
): PresentationReadinessReport {
  return {
    summary: { ready: 0, preparing: 0, unsupported: 0, missing: 0, failed: 1 },
    items: item
      ? [
          {
            itemId: item.id,
            blobId: getBlobId(item),
            status: 'failed',
            reason,
            support: null
          }
        ]
      : []
  }
}

export const useMediaProjectionStore = create<MediaProjectionStore>()((set, get) => ({
  ...initialState,

  currentItem: () => {
    const { playlist, currentIndex } = get()
    return playlist[currentIndex] ?? null
  },

  nextItem: () => {
    const { playlist, currentIndex } = get()
    return playlist[currentIndex + 1] ?? null
  },

  prevItem: () => {
    const { playlist, currentIndex } = get()
    return playlist[currentIndex - 1] ?? null
  },

  canNext: () => {
    const state = get()
    const presentation = getCurrentPresentationState(state)
    return (
      !state.isEnded &&
      state.playlist.length > 0 &&
      (!presentation ||
        (Number.isInteger(presentation.slideCount) && (presentation.slideCount ?? 0) > 0))
    )
  },

  canPrev: () => {
    const state = get()
    const { currentIndex } = state
    const presentation = getCurrentPresentationState(state)
    if (presentation && presentation.slideIndex > 0) return true
    return currentIndex > 0
  },

  progress: () => {
    const state = get()
    const { playlist, currentIndex } = state
    const presentation = getCurrentPresentationState(state)
    if (
      presentation &&
      Number.isInteger(presentation.slideCount) &&
      (presentation.slideCount ?? 0) > 0
    ) {
      return `${presentation.slideIndex + 1} / ${presentation.slideCount}`
    }
    if (presentation) return `${presentation.slideIndex + 1} / …`
    if (playlist.length === 0) return '0 / 0'
    return `${currentIndex + 1} / ${playlist.length}`
  },

  startPresentation: (files: FileItemRecord[], startIndex: number) => {
    if (files.some((item) => !isPersonalRecordVisible(item))) return false
    const generation = beginProjectionAction()
    return commitAfterPreflight(generation, prepareEditableProjection(files[startIndex]), () => {
      releaseProjectionLocks?.()
      const snapshot = createPresentationSnapshot(files)
      releaseProjectionLocks = lockMediaResources(getPresentationSnapshotResourceIds(snapshot))
      set({
        playlist: files,
        currentIndex: startIndex,
        isPresenting: true,
        sessionRevision: get().sessionRevision + 1,
        lastReadinessReport: null,
        snapshot,
        typeStates: initialTypeStates
      })
    })
  },

  startPresentationWithReadiness: async (
    files: FileItemRecord[],
    startIndex: number,
    options: StartPresentationWithReadinessOptions = {}
  ): Promise<PresentationReadinessReport> => {
    const generation = beginProjectionAction()
    const requestedItem = files[startIndex]
    if (files.some((item) => !isPersonalRecordVisible(item)))
      return blockedReadinessReport(requestedItem, 'presentation-projection-superseded')
    let report = await analyzePresentationReadiness(files)
    if (!isCurrentProjectionAction(generation)) {
      return blockedReadinessReport(requestedItem, 'presentation-projection-superseded')
    }
    if (options.prioritizeStartItem && requestedItem) {
      const requestedReadiness = report.items.find((item) => item.itemId === requestedItem.id)
      if (
        requestedReadiness?.status === 'preparing' &&
        requestedReadiness.reason.startsWith('sync-') &&
        (await ensureSyncItemAvailableForPresentation(requestedItem))
      ) {
        report = await analyzePresentationReadiness(files)
        if (!isCurrentProjectionAction(generation)) {
          return blockedReadinessReport(requestedItem, 'presentation-projection-superseded')
        }
      }
    }

    const readyItemIds = new Set(
      report.items.filter((item) => item.status === 'ready').map((item) => item.itemId)
    )
    const readyFiles = files.filter((file) => readyItemIds.has(file.id))
    const requestedReadyIndex = requestedItem
      ? readyFiles.findIndex((file) => file.id === requestedItem.id)
      : -1
    if (options.prioritizeStartItem && requestedItem && requestedReadyIndex === -1) {
      if (!isCurrentProjectionAction(generation)) {
        return blockedReadinessReport(requestedItem, 'presentation-projection-superseded')
      }
      set({ lastReadinessReport: report })
      return report
    }
    if (readyFiles.length === 0) {
      if (!isCurrentProjectionAction(generation)) {
        return blockedReadinessReport(requestedItem, 'presentation-projection-superseded')
      }
      set({ lastReadinessReport: report })
      return report
    }

    const fallbackReadyIndex = readyFiles.findIndex(
      (file) => files.findIndex((candidate) => candidate.id === file.id) >= startIndex
    )
    const resolvedIndex =
      requestedReadyIndex >= 0
        ? requestedReadyIndex
        : fallbackReadyIndex >= 0
          ? fallbackReadyIndex
          : readyFiles.length - 1

    const preflight = await prepareEditableProjection(readyFiles[resolvedIndex])
    if (!isReadyPreflight(preflight)) {
      return blockedReadinessReport(readyFiles[resolvedIndex], 'presentation-finalization-blocked')
    }
    if (!isCurrentProjectionAction(generation) || !validatesPreflight(preflight)) {
      return blockedReadinessReport(readyFiles[resolvedIndex], 'presentation-projection-superseded')
    }

    releaseProjectionLocks?.()
    const snapshot = createPresentationSnapshot(readyFiles, report.items)
    releaseProjectionLocks = lockMediaResources(getPresentationSnapshotResourceIds(snapshot))
    set({
      playlist: readyFiles,
      currentIndex: resolvedIndex,
      isPresenting: true,
      sessionRevision: get().sessionRevision + 1,
      lastReadinessReport: report,
      isEnded: false,
      showGrid: false,
      snapshot,
      typeStates: options.presentationState
        ? { ...initialTypeStates, presentation: options.presentationState }
        : initialTypeStates,
      zoomLevel: 1,
      pan: { x: 0, y: 0 }
    })
    return report
  },

  exit: () => {
    beginProjectionAction()
    clearLiveSession(set)
  },

  endLiveSession: () => {
    beginProjectionAction()
    clearLiveSession(set)
  },

  markProjectionClosed: () => {
    beginProjectionAction()
    clearLiveSession(set)
  },

  next: () => {
    const generation = beginProjectionAction()
    const s = get()
    if (s.isEnded) return false
    const presentation = getCurrentPresentationState(s)
    if (
      presentation &&
      (!Number.isInteger(presentation.slideCount) || (presentation.slideCount ?? 0) < 1)
    )
      return false
    if (
      presentation &&
      presentation.slideCount !== undefined &&
      presentation.slideIndex < presentation.slideCount - 1
    ) {
      return commitAfterPreflight(
        generation,
        prepareEditableProjection(s.currentItem()),
        () => {
          const current = get()
          const currentPresentation = getCurrentPresentationState(current)
          if (!currentPresentation) return
          set({
            typeStates: {
              ...current.typeStates,
              presentation: {
                ...currentPresentation,
                slideIndex: currentPresentation.slideIndex + 1
              }
            }
          })
        },
        () => isSameNavigationState(s, get)
      )
    }
    if (s.currentIndex >= s.playlist.length - 1) {
      return commitAfterPreflight(
        generation,
        prepareEditableProjection(s.currentItem()),
        () => {
          set({ isEnded: true })
        },
        () => isSameNavigationState(s, get)
      )
    }
    return commitAfterPreflight(
      generation,
      prepareEditableProjection(s.currentItem(), s.nextItem()),
      () => {
        const current = get()
        set({
          currentIndex: current.currentIndex + 1,
          zoomLevel: 1,
          pan: { x: 0, y: 0 },
          typeStates: withoutTransientMediaRuntimeState(current.typeStates)
        })
      },
      () => isSameNavigationState(s, get)
    )
  },

  prev: () => {
    const generation = beginProjectionAction()
    const s = get()
    if (s.isEnded) {
      return commitAfterPreflight(
        generation,
        prepareEditableProjection(s.currentItem()),
        () => {
          set({ isEnded: false })
        },
        () => isSameNavigationState(s, get)
      )
    }
    const presentation = getCurrentPresentationState(s)
    if (presentation && presentation.slideIndex > 0) {
      return commitAfterPreflight(
        generation,
        prepareEditableProjection(s.currentItem()),
        () => {
          const current = get()
          const currentPresentation = getCurrentPresentationState(current)
          if (!currentPresentation) return
          set({
            typeStates: {
              ...current.typeStates,
              presentation: {
                ...currentPresentation,
                slideIndex: currentPresentation.slideIndex - 1
              }
            }
          })
        },
        () => isSameNavigationState(s, get)
      )
    }
    if (s.currentIndex <= 0) return false
    return commitAfterPreflight(
      generation,
      prepareEditableProjection(s.currentItem(), s.prevItem()),
      () => {
        const current = get()
        set({
          currentIndex: current.currentIndex - 1,
          zoomLevel: 1,
          pan: { x: 0, y: 0 },
          typeStates: withoutTransientMediaRuntimeState(current.typeStates)
        })
      },
      () => isSameNavigationState(s, get)
    )
  },

  jumpTo: (index: number) => {
    const generation = beginProjectionAction()
    const s = get()
    const clamped = Math.max(0, Math.min(index, s.playlist.length - 1))
    return commitAfterPreflight(
      generation,
      prepareEditableProjection(s.currentItem(), s.playlist[clamped]),
      () => {
        const current = get()
        set({
          currentIndex: clamped,
          isEnded: false,
          zoomLevel: 1,
          pan: { x: 0, y: 0 },
          typeStates:
            clamped === current.currentIndex
              ? current.typeStates
              : withoutTransientMediaRuntimeState(current.typeStates)
        })
      },
      () => isSameNavigationState(s, get)
    )
  },

  jumpToSlide: (index: number) => {
    const generation = beginProjectionAction()
    const state = get()
    const presentation = getCurrentPresentationState(state)
    if (
      !presentation ||
      !Number.isInteger(index) ||
      !Number.isInteger(presentation.slideCount) ||
      index < 0 ||
      index >= (presentation.slideCount ?? 0)
    )
      return false
    return commitAfterPreflight(
      generation,
      prepareEditableProjection(state.currentItem()),
      () =>
        set({
          isEnded: false,
          typeStates: { ...state.typeStates, presentation: { ...presentation, slideIndex: index } }
        }),
      () => isSameNavigationState(state, get)
    )
  },

  toggleGrid: () => {
    set((state) => ({ showGrid: !state.showGrid }))
  },

  getTypeState: <K extends MediaType>(type: K) => {
    return get().typeStates[type] as MediaTypeStateMap[K] | undefined
  },

  setTypeState: <K extends MediaType>(type: K, value: MediaTypeStateMap[K]) => {
    set((s) => ({
      typeStates: { ...s.typeStates, [type]: value } as Partial<{
        [T in MediaType]: MediaTypeStateMap[T]
      }>
    }))
  },

  setZoomLevel: (level: number) => {
    if (level <= 1) {
      set({ zoomLevel: 1, pan: { x: 0, y: 0 } })
    } else {
      set({ zoomLevel: level })
    }
  },

  resetZoom: () => {
    set({ zoomLevel: 1, pan: { x: 0, y: 0 } })
  },

  setPan: (x: number, y: number) => {
    set({ pan: { x, y } })
  },

  updateNotes: (itemId: string, notes: string) => {
    const store = useFileExplorerStore.getState()
    if (store.updateItem) store.updateItem(itemId, { notes })
    set((state) => {
      const idx = state.playlist.findIndex((item) => item.id === itemId)
      if (idx === -1) return {}
      const newPlaylist = [...state.playlist]
      newPlaylist[idx] = { ...newPlaylist[idx], notes }
      return { playlist: newPlaylist }
    })
  }
}))

usePersonalSyncStore.subscribe((state, previous) => {
  if (state.activeOwnerId === previous.activeOwnerId) return
  beginProjectionAction()
  if (useMediaProjectionStore.getState().playlist.some((item) => !isPersonalRecordVisible(item)))
    useMediaProjectionStore.getState().exit()
})
