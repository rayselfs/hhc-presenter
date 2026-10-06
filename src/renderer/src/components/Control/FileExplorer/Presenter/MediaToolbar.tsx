import React from 'react'
import { LayoutGrid, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'

interface MediaToolbarProps {
  onToggleGrid: () => void
}

export default function MediaToolbar({ onToggleGrid }: MediaToolbarProps): React.JSX.Element {
  const { t } = useTranslation()
  const zoomLevel = useMediaProjectionStore((s) => s.zoomLevel)
  const currentMimeType = useMediaProjectionStore((s) => s.currentItem()?.mimeType ?? '')
  const pdfViewMode = useMediaProjectionStore((s) => s.typeStates['pdf']?.viewMode ?? 'slide')
  const { resetZoom, setZoomLevel } = useMediaProjectionStore.getState()

  const usesVlc = useMediaProjectionStore(
    (s) => s.snapshot?.entries[s.currentIndex]?.playbackMode === 'vlc-embedded'
  )
  const zoomDisabled =
    usesVlc || (currentMimeType === 'application/pdf' && pdfViewMode === 'scroll')

  return (
    <div className="presenter-toolbar flex w-full items-center gap-2 py-2 shrink-0">
      <Button
        isIconOnly
        variant="ghost"
        onPress={onToggleGrid}
        aria-label={t('presenter.grid')}
        className="presenter-control-button rounded-full"
      >
        <LayoutGrid className="presenter-control-icon" />
      </Button>
      <Button
        isIconOnly
        variant={zoomLevel > 1 ? 'tertiary' : 'ghost'}
        isDisabled={zoomDisabled}
        onPress={() => (zoomLevel > 1 ? resetZoom() : setZoomLevel(1.2))}
        aria-label={t('presenter.zoom')}
        className="presenter-control-button rounded-full"
      >
        {zoomLevel > 1 ? (
          <ZoomOut className="presenter-control-icon" />
        ) : (
          <ZoomIn className="presenter-control-icon" />
        )}
      </Button>
    </div>
  )
}
