import React, { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { useTimerRuntimeStore } from '@renderer/stores/timer-runtime'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { setPresenterActive } from '@renderer/lib/shortcut-registry'
import { getDescriptor } from '@renderer/lib/presenter-registry'
import { PresenterCommandContext } from '@renderer/contexts/PresenterCommandContext'
import { PreviewCacheProvider } from '@renderer/contexts/PreviewCacheContext'
import { ShortcutScope } from '@renderer/contexts/ShortcutScopeContext'
import type { FileControlPayload } from '@shared/projection-messages'
import PresenterHeader from './PresenterHeader'
import PresenterNavigation from './PresenterNavigation'
import PresenterSidebar from './PresenterSidebar'
import PresenterGrid from './PresenterGrid'
import MediaPreview from './Preview/MediaPreview'
import MediaToolbar from './MediaToolbar'
import GlassDivider from '@renderer/components/Common/GlassDivider'
import { usePreviewCache } from '@renderer/hooks/usePreviewCache'
import { useThumbnails } from '@renderer/hooks/useThumbnails'
import { toast } from '@heroui/react/toast'
import {
  resolveMediaProjectionAction,
  type MediaProjectionActionResult
} from '@renderer/stores/media-projection'

interface MediaPresenterProps {
  onExit: () => void
}

export default function MediaPresenter({ onExit }: MediaPresenterProps): React.JSX.Element {
  const { t } = useTranslation()
  const { project } = useProjection()

  const playlist = useMediaProjectionStore((s) => s.playlist)
  const { pdfPageThumbs } = usePreviewCache(playlist)
  const coverThumbnails = useThumbnails(playlist)
  const showGrid = useMediaProjectionStore((s) => s.showGrid)
  const zoomLevel = useMediaProjectionStore((s) => s.zoomLevel)
  const isEnded = useMediaProjectionStore((s) => s.isEnded)
  const currentItem = useMediaProjectionStore((s) => s.currentItem())

  const { next, prev, jumpTo, toggleGrid, setZoomLevel, resetZoom } =
    useMediaProjectionStore.getState()

  const descriptor = currentItem ? getDescriptor(currentItem.mimeType) : null

  const sendCommand = useCallback(
    (cmd: FileControlPayload) => {
      void project('file:control', cmd)
    },
    [project]
  )

  const getCurrentKeyboardVideoState = useCallback(() => {
    const state = useMediaProjectionStore.getState()
    const item = state.currentItem()
    const itemDescriptor = item ? getDescriptor(item.mimeType) : null
    return {
      isVideo: itemDescriptor?.type === 'video',
      videoState: state.typeStates.video
    }
  }, [])

  const pauseCurrentVideoIfPlaying = useCallback((): void => {
    const { isVideo, videoState } = getCurrentKeyboardVideoState()
    if (isVideo && videoState?.isPlaying) {
      window.dispatchEvent(new CustomEvent('media:pauseVideo'))
    }
  }, [getCurrentKeyboardVideoState])

  const toggleGridWithMediaPause = useCallback((): void => {
    if (!useMediaProjectionStore.getState().showGrid) {
      pauseCurrentVideoIfPlaying()
    }
    toggleGrid()
  }, [pauseCurrentVideoIfPlaying, toggleGrid])

  const navigate = useCallback(
    async (action: () => MediaProjectionActionResult): Promise<void> => {
      if ((await resolveMediaProjectionAction(action())).status === 'blocked') {
        toast.danger(t('presentationWorkspace.saveFailed', 'Unable to save presentation'))
      }
    },
    [t]
  )

  const advance = (): void => {
    if (useMediaProjectionStore.getState().isEnded) onExit()
    else void navigate(next)
  }

  useEffect(() => {
    const timerStatus = useTimerRuntimeStore.getState().status
    if (timerStatus === 'running') {
      useTimerRuntimeStore.getState().pause()
    }
  }, [])

  useEffect(() => {
    setPresenterActive(true)
    return () => {
      setPresenterActive(false)
    }
  }, [])

  useKeyboardShortcuts(
    [
      {
        config: SHORTCUTS.MEDIA.ESCAPE,
        handler: () => {
          const { isVideo, videoState } = getCurrentKeyboardVideoState()
          if (isVideo && videoState?.isPlaying) {
            window.dispatchEvent(new CustomEvent('media:pauseVideo'))
          } else if (showGrid) {
            toggleGrid()
          } else if (zoomLevel > 1) {
            resetZoom()
          } else {
            onExit()
          }
        }
      },
      {
        config: SHORTCUTS.MEDIA.NEXT_SLIDE,
        handler: () => {
          advance()
        }
      },
      { config: SHORTCUTS.MEDIA.NEXT_SLIDE_ALT, handler: advance },
      {
        config: SHORTCUTS.MEDIA.PREV_SLIDE,
        handler: () => {
          void navigate(prev)
        }
      },
      { config: SHORTCUTS.MEDIA.PREV_SLIDE_ALT, handler: () => void navigate(prev) },
      { config: SHORTCUTS.MEDIA.FIRST_SLIDE, handler: () => void navigate(() => jumpTo(0)) },
      {
        config: SHORTCUTS.MEDIA.LAST_SLIDE,
        handler: () => void navigate(() => jumpTo(playlist.length - 1))
      },
      { config: SHORTCUTS.MEDIA.TOGGLE_GRID, handler: toggleGridWithMediaPause },
      {
        config: SHORTCUTS.MEDIA.TOGGLE_ZOOM,
        handler: () => (zoomLevel > 1 ? resetZoom() : setZoomLevel(1.2))
      },
      {
        config: SHORTCUTS.MEDIA.ZOOM_IN,
        handler: () => setZoomLevel(Math.min(zoomLevel + 0.5, 5))
      },
      {
        config: SHORTCUTS.MEDIA.ZOOM_OUT,
        handler: () => setZoomLevel(Math.max(zoomLevel - 0.5, 1))
      },
      ...(descriptor?.type === 'video'
        ? [
            {
              config: SHORTCUTS.MEDIA.VIDEO_TOGGLE_PLAY,
              handler: () => window.dispatchEvent(new CustomEvent('media:togglePlay'))
            },
            {
              config: SHORTCUTS.MEDIA.VIDEO_SEEK_FORWARD,
              handler: () => {
                const { videoState } = getCurrentKeyboardVideoState()
                if (!videoState?.hasStarted || videoState.isEnded) return
                window.dispatchEvent(
                  new CustomEvent('media:videoSeekRelative', { detail: { seconds: 5 } })
                )
              }
            },
            {
              config: SHORTCUTS.MEDIA.VIDEO_SEEK_BACKWARD,
              handler: () => {
                const { videoState } = getCurrentKeyboardVideoState()
                if (!videoState?.hasStarted || videoState.isEnded) return
                window.dispatchEvent(
                  new CustomEvent('media:videoSeekRelative', { detail: { seconds: -5 } })
                )
              }
            }
          ]
        : []),
      ...(descriptor?.type === 'pdf'
        ? [
            {
              config: SHORTCUTS.MEDIA.PDF_NEXT_PAGE,
              handler: () => window.dispatchEvent(new CustomEvent('media:pdfNextPage'))
            },
            {
              config: SHORTCUTS.MEDIA.PDF_PREV_PAGE,
              handler: () => window.dispatchEvent(new CustomEvent('media:pdfPrevPage'))
            },
            {
              config: SHORTCUTS.MEDIA.PDF_TOGGLE_VIEW_MODE,
              handler: () => {
                const currentViewMode =
                  useMediaProjectionStore.getState().typeStates['pdf']?.viewMode ?? 'slide'
                const newMode = currentViewMode === 'slide' ? 'scroll' : 'slide'
                useMediaProjectionStore.getState().setTypeState('pdf', { viewMode: newMode })
                void project('file:control', {
                  action: 'pdfViewMode',
                  value: newMode === 'slide' ? 'single' : 'continuous'
                })
              }
            }
          ]
        : [])
    ],
    { sectionKey: 'media' }
  )

  return (
    <PresenterCommandContext.Provider value={{ sendCommand }}>
      <PreviewCacheProvider pdfPageThumbs={pdfPageThumbs}>
        <div className="media-presenter h-full min-h-0 bg-surface" data-testid="media-presenter">
          <div className="flex h-full">
            <div className="presenter-current flex-3 lg:flex-2 min-w-0 flex flex-col h-full">
              <PresenterHeader onExit={onExit} />
              <MediaPreview
                currentItem={currentItem}
                descriptor={descriptor}
                onNext={advance}
                isEnded={isEnded}
                onExit={onExit}
              />
              <MediaToolbar onToggleGrid={toggleGridWithMediaPause} />
              <PresenterNavigation onNext={advance} />
            </div>

            <GlassDivider vertical />

            <div className="flex-2 lg:flex-1 min-w-0 h-full">
              <PresenterSidebar previewCache={coverThumbnails} onNext={advance} />
            </div>
          </div>

          {showGrid && (
            <ShortcutScope name="grid">
              <PresenterGrid previewCache={coverThumbnails} />
            </ShortcutScope>
          )}
        </div>
      </PreviewCacheProvider>
    </PresenterCommandContext.Provider>
  )
}
