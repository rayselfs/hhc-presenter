import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileItemRecord } from '@shared/types/folder'
import type { MediaTypeDescriptor } from '@renderer/lib/presenter-registry'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'

interface MediaPreviewProps {
  currentItem: FileItemRecord | null
  descriptor: MediaTypeDescriptor | null
  isEnded?: boolean
  onExit: () => void
  onNext: () => void
}

export default function MediaPreview({
  currentItem,
  descriptor,
  isEnded = false,
  onExit,
  onNext
}: MediaPreviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement>(null)
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const [isDragging, setIsDragging] = useState(false)
  const panDragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0, w: 1, h: 1, zoom: 1 })

  const zoomLevel = useMediaProjectionStore((s) => s.zoomLevel)

  useEffect(() => {
    const el = previewBoxRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const { zoomLevel: currentZoom } = useMediaProjectionStore.getState()
      const delta = e.deltaY < 0 ? 0.1 : -0.1
      useMediaProjectionStore.getState().setZoomLevel(Math.max(1, Math.min(5, currentZoom + delta)))
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  const handlePanStart = useCallback((e: React.MouseEvent) => {
    const { zoomLevel: currentZoom, pan: currentPan } = useMediaProjectionStore.getState()
    if (currentZoom <= 1) return
    isDraggingRef.current = true
    setIsDragging(true)
    const rect = stageRef.current?.getBoundingClientRect()
    panDragStart.current = {
      x: e.clientX,
      y: e.clientY,
      panX: currentPan.x,
      panY: currentPan.y,
      w: rect?.width ?? 1,
      h: rect?.height ?? 1,
      zoom: currentZoom
    }

    const onMove = (ev: MouseEvent): void => {
      if (!isDraggingRef.current) return
      const { setPan: storePan } = useMediaProjectionStore.getState()
      const d = panDragStart.current
      storePan(
        d.panX + ((ev.clientX - d.x) / d.w) * d.zoom,
        d.panY + ((ev.clientY - d.y) / d.h) * d.zoom
      )
    }

    const onUp = (): void => {
      isDraggingRef.current = false
      setIsDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const PreviewComponent = descriptor?.PreviewComponent ?? null

  return (
    <div
      ref={previewBoxRef}
      className="presenter-preview relative min-h-0 flex-1 w-full overflow-hidden px-4"
      style={{
        userSelect: 'none',
        cursor:
          zoomLevel > 1
            ? isDragging
              ? 'grabbing'
              : 'grab'
            : descriptor?.clickToAdvance
              ? 'pointer'
              : 'default'
      }}
    >
      <div
        ref={stageRef}
        onMouseDown={handlePanStart}
        className="presenter-preview-stage aspect-video overflow-hidden relative rounded-2xl bg-surface-secondary border border-default-300"
        onClick={() => {
          if (isEnded) {
            onExit()
            return
          }
          if (descriptor?.clickToAdvance && zoomLevel <= 1) onNext()
        }}
      >
        {isEnded ? (
          <div className="w-full h-full flex items-center justify-center bg-black">
            <span className="text-white/10 text-4xl font-bold tracking-widest">
              {t('presenter.endOfSlides')}
            </span>
          </div>
        ) : PreviewComponent && currentItem ? (
          <PreviewComponent key={currentItem.id} item={currentItem} />
        ) : (
          <div className="text-foreground/50 text-center w-full h-full flex items-center justify-center">
            {t('presenter.noMediaSelected')}
          </div>
        )}
      </div>
    </div>
  )
}
