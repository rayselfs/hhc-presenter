import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useCallback, useEffect, useRef } from 'react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import MediaPresenter from '@renderer/components/Control/FileExplorer/Presenter/MediaPresenter'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { closeProjectionAndMediaSession } from '@renderer/lib/projection-actions'
import { getPresentationWorkspacePath, isPresentationItem } from '@renderer/lib/presentation-media'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'

export default function MediaWorkspacePage(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { stopProjection } = useProjection()
  const isPresenting = useMediaProjectionStore((state) => state.isPresenting)
  const endLiveSession = useMediaProjectionStore((state) => state.endLiveSession)
  const filesPath = useFileExplorerStore((state) =>
    state.folders[state.currentFolderId]?.personalOwnerId ? '/cloud-files' : '/files'
  )
  const currentItem = useMediaProjectionStore((state) => state.currentItem())
  const returnPathRef = useRef(filesPath)
  const isClosingRef = useRef(false)

  useEffect(() => {
    if (isPresenting) {
      returnPathRef.current =
        currentItem && isPresentationItem(currentItem)
          ? getPresentationWorkspacePath(currentItem.id)
          : filesPath
    } else {
      navigate(returnPathRef.current, { replace: true })
    }
  }, [currentItem, filesPath, isPresenting, navigate])

  const handleExit = useCallback(async (): Promise<void> => {
    if (isClosingRef.current) return
    isClosingRef.current = true
    try {
      await closeProjectionAndMediaSession({ closeProjection: stopProjection, endLiveSession })
    } catch {
      toast.danger(t('toast.projectionCloseFailed'))
    } finally {
      isClosingRef.current = false
    }
  }, [endLiveSession, stopProjection, t])

  return <MediaPresenter onExit={() => void handleExit()} />
}
