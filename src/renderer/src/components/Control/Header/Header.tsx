import { useSettingsStore } from '@renderer/stores/settings'
import { useCurrentFolderDisplay } from '@renderer/stores/file-explorer'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { useCallback } from 'react'
import { ButtonGroup } from '@heroui/react/button-group'
import { Button } from '@heroui/react/button'
import { toast } from '@heroui/react/toast'
import { X, Monitor } from 'lucide-react'
import CameraSelector from '@renderer/components/Control/Camera/CameraSelector'
import { useCameraStore } from '@renderer/stores/camera'
import ModeSelector from '@renderer/components/Control/Timer/ModeSelector'
import SettingsPopover from '@renderer/components/Control/Header/SettingsPopover/SettingsPopover'
import BibleSelector from '@renderer/components/Control/Bible/BibleSelector'
import SearchBarToggle from '@renderer/components/Control/Header/SearchBar/SearchBarToggle'
import Breadcrumb from '@renderer/components/Control/FileExplorer/Breadcrumb'
import ViewModeDropdown from '@renderer/components/Control/FileExplorer/ViewModeDropdown'
import SortDropdown from '@renderer/components/Control/FileExplorer/SortDropdown'
import {
  isTimerRoute,
  isBibleRoute,
  isFilesRoute,
  isFavoritesRoute,
  isTrashRoute
} from '@renderer/lib/routes'
import { EVENTS } from '@renderer/config/events'
import { useTimerStore } from '@renderer/stores/timer'
import {
  useFileExplorerCustomOrder,
  useFileExplorerStore,
  useFavoritesExplorerSettings,
  useTrashExplorerSettings
} from '@renderer/stores/file-explorer'
import { getExplorerProjectionPlaylist } from '@renderer/lib/file-explorer-projection'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { useBibleProjectionStore } from '@renderer/stores/bible-projection'
import {
  getProjectionHeaderState,
  startProjectionForRoute,
  stopProjectionSession
} from '@renderer/lib/projection-actions'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'

export default function Header(): React.JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { isProjectionOpen, ensureProjectionOpen, startProjection, stopProjection } =
    useProjection()
  const cameraReady = useCameraStore((state) => state.capturing)
  const showCameraControls = location.pathname === '/camera'
  const mode = useTimerStore((s) => s.mode)

  const currentFolderId = useFileExplorerStore((state) => state.currentFolderId)
  const fileItems = useFileExplorerStore((state) => state._itemsArray)
  const biblePayloads = useBibleProjectionStore((state) => state.lastPayloads)
  const getFolderPath = useFileExplorerStore((state) => state.getFolderPath)
  const navigateToFolder = useFileExplorerStore((state) => state.navigateToFolder)
  const navigateToRoot = useFileExplorerStore((state) => state.navigateToRoot)
  const { viewMode, setViewMode, sortField, sortDir, setSortFieldAndDir, groupMode, setGroupMode } =
    useCurrentFolderDisplay()

  const favViewMode = useFavoritesExplorerSettings((state) => state.viewMode)
  const favSetViewMode = useFavoritesExplorerSettings((state) => state.setViewMode)
  const favSortField = useFavoritesExplorerSettings((state) => state.sortField)
  const favSortDir = useFavoritesExplorerSettings((state) => state.sortDir)
  const favSetSortFieldAndDir = useFavoritesExplorerSettings((state) => state.setSortFieldAndDir)

  const trashViewMode = useTrashExplorerSettings((state) => state.viewMode)
  const trashSetViewMode = useTrashExplorerSettings((state) => state.setViewMode)
  const trashSortField = useTrashExplorerSettings((state) => state.sortField)
  const trashSortDir = useTrashExplorerSettings((state) => state.sortDir)
  const trashSetSortFieldAndDir = useTrashExplorerSettings((state) => state.setSortFieldAndDir)

  const showTimerControls = isTimerRoute(location.pathname)
  const showBibleControls = isBibleRoute(location.pathname)
  const showFilesControls = isFilesRoute(location.pathname)
  const showFavoritesControls = isFavoritesRoute(location.pathname)
  const showTrashControls = isTrashRoute(location.pathname)
  const showExplorerControls = showFilesControls || showFavoritesControls || showTrashControls
  useSettingsStore((state) => state.timezone)
  useFileExplorerCustomOrder((state) => state.orders[currentFolderId])
  const presentableItems = getExplorerProjectionPlaylist(
    fileItems.filter((item) => item.parentId === currentFolderId && !item.deletedAt)
  )
  const projectionHeaderState = getProjectionHeaderState({
    cameraReady,
    pathname: location.pathname,
    isProjectionOpen,
    biblePayloads,
    presentableItems
  })

  const activeViewMode = showFavoritesControls
    ? favViewMode
    : showTrashControls
      ? trashViewMode
      : viewMode
  const activeSetViewMode = showFavoritesControls
    ? favSetViewMode
    : showTrashControls
      ? trashSetViewMode
      : setViewMode
  const activeSortField = showFavoritesControls
    ? favSortField
    : showTrashControls
      ? trashSortField
      : sortField
  const activeSortDir = showFavoritesControls
    ? favSortDir
    : showTrashControls
      ? trashSortDir
      : sortDir
  const activeSetSortFieldAndDir = showFavoritesControls
    ? favSetSortFieldAndDir
    : showTrashControls
      ? trashSetSortFieldAndDir
      : setSortFieldAndDir

  const startCurrentRouteProjection = useCallback(async (): Promise<void> => {
    if (isProjectionOpen || projectionHeaderState.disabled) return
    const started = await startProjectionForRoute({
      pathname: location.pathname,
      startProjection,
      ensureProjectionOpen,
      biblePayloads,
      presentableItems,
      startMediaPresentation: (items, startIndex) =>
        useMediaProjectionStore.getState().startPresentationWithReadiness(items, startIndex),
      onNoProjectableFiles: () => toast.warning(t('fileExplorer.noProjectableFiles'))
    })
    if (started && isFilesRoute(location.pathname)) navigate('/media')
  }, [
    biblePayloads,
    ensureProjectionOpen,
    isProjectionOpen,
    location.pathname,
    presentableItems,
    projectionHeaderState.disabled,
    navigate,
    startProjection,
    t
  ])

  useKeyboardShortcuts(
    [
      {
        config: SHORTCUTS.PROJECTION.START,
        handler: () => {
          void startCurrentRouteProjection()
        },
        id: 'projection.start',
        description: t('shortcuts.projection.start')
      }
    ],
    { sectionKey: 'projection' }
  )

  const handleProjectionAction = async (): Promise<void> => {
    if (!isProjectionOpen) {
      await startCurrentRouteProjection()
      return
    }

    await stopProjectionSession({ stopProjection }).catch(() => {
      toast.danger(t('toast.projectionCloseFailed'))
    })
  }

  const handleOpenBibleSelector = (): void => {
    window.dispatchEvent(new Event(EVENTS.OPEN_BIBLE_SELECTOR))
  }

  const handleBreadcrumbNavigate = (folderId: string | null): void => {
    if (folderId === null) {
      navigateToRoot()
    } else {
      void navigateToFolder(folderId)
    }
  }

  return (
    <header className="relative flex items-center justify-end gap-2 p-2">
      {(showTimerControls || showBibleControls) && (
        <div className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <SettingsPopover
            variant={showBibleControls ? 'bible' : mode === 'stopwatch' ? 'stopwatch' : 'timer'}
          />
          <div
            className={`lg:hidden transition-all duration-200 ${showBibleControls ? 'opacity-100 translate-x-0 pointer-events-auto' : 'opacity-0 -translate-x-3 pointer-events-none'}`}
          >
            <BibleSelector onOpenDialog={handleOpenBibleSelector} />
          </div>
        </div>
      )}

      <div
        className={`absolute left-2 top-1/2 -translate-y-1/2 flex items-center gap-2 max-w-[50%] transition-all duration-200 ${showExplorerControls ? 'opacity-100 translate-x-0 pointer-events-auto' : 'opacity-0 -translate-x-3 pointer-events-none'}`}
      >
        <ButtonGroup size="lg">
          <ViewModeDropdown viewMode={activeViewMode} onViewModeChange={activeSetViewMode} />
          <SortDropdown
            sortField={activeSortField}
            sortDir={activeSortDir}
            onSortChange={activeSetSortFieldAndDir}
            groupMode={groupMode}
            onGroupChange={showFilesControls ? setGroupMode : undefined}
          />
        </ButtonGroup>
        {showFilesControls && (
          <Breadcrumb
            rootFolderId={
              location.pathname === '/cloud-files'
                ? getFolderPath(currentFolderId).find((folder) => folder.personalOwnerId)?.id
                : undefined
            }
            currentFolderId={currentFolderId}
            getFolderPath={getFolderPath}
            onNavigate={handleBreadcrumbNavigate}
          />
        )}
      </div>

      <div
        className={`absolute inset-0 flex items-center lg:justify-center max-lg:justify-start max-lg:pl-14 pointer-events-none transition-all duration-200 ${showTimerControls ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-3'}`}
      >
        <div className={showTimerControls ? 'pointer-events-auto' : undefined}>
          <ModeSelector />
        </div>
      </div>

      <div
        className={`absolute inset-0 flex items-center justify-center pointer-events-none transition-all duration-200 ${showBibleControls ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-3'}`}
      >
        <div className={`max-lg:hidden ${showBibleControls ? 'pointer-events-auto' : ''}`}>
          <div data-testid="bible-header-controls">
            <BibleSelector onOpenDialog={handleOpenBibleSelector} />
          </div>
        </div>
      </div>

      {showCameraControls && (
        <div className="absolute inset-y-0 left-2 right-14 flex items-center lg:left-1/2 lg:right-auto lg:-translate-x-1/2">
          <CameraSelector />
        </div>
      )}
      <div className="flex items-center gap-2">
        {(showBibleControls || showFilesControls) && (
          <SearchBarToggle variant={showBibleControls ? 'bible' : 'fileExplorer'} />
        )}
        <Button
          size="lg"
          isIconOnly
          variant="outline"
          className={`size-10 min-w-10 rounded-full p-0 ${
            isProjectionOpen ? 'text-danger' : 'text-default-foreground'
          }`}
          onPress={() => void handleProjectionAction()}
          isDisabled={!isProjectionOpen && projectionHeaderState.disabled}
          aria-label={t(isProjectionOpen ? 'projection.stopButton' : 'projection.startButton')}
        >
          {isProjectionOpen ? <X className="size-4" /> : <Monitor className="size-4" />}
        </Button>
      </div>
    </header>
  )
}
