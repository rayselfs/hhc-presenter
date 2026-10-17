import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { calculateFitZoomPercent } from '@renderer/lib/presentation-viewport'
import { isMac } from '@renderer/lib/env'

export const PRESENTATION_CANVAS_WIDTH = 1024
const PRESENTATION_VIEWPORT_PADDING = 64
type ZoomMode = 'fit' | 'custom'
interface PresentationViewport {
  canvasViewportRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLDivElement | null>
  zoomMode: ZoomMode
  zoomPercent: number
  setCustomZoom: (zoom: number) => void
  fitZoom: () => void
}

export function usePresentationViewport(width: number, height: number): PresentationViewport {
  const canvasViewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const pendingZoomAnchorRef = useRef<{
    clientX: number
    clientY: number
    logicalX: number
    logicalY: number
    nextZoom: number
  } | null>(null)
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit')
  const [customZoomPercent, setZoomPercent] = useState(100)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const zoomPercent =
    zoomMode === 'fit' && viewportSize.width > 0 && viewportSize.height > 0
      ? calculateFitZoomPercent(
          viewportSize.width,
          viewportSize.height,
          PRESENTATION_CANVAS_WIDTH,
          (PRESENTATION_CANVAS_WIDTH * height) / width,
          PRESENTATION_VIEWPORT_PADDING
        )
      : customZoomPercent
  useEffect(() => {
    const viewport = canvasViewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const pending = pendingZoomAnchorRef.current
    const viewport = canvasViewportRef.current
    const canvas = canvasRef.current
    if (!pending || !viewport || !canvas || pending.nextZoom !== zoomPercent) return
    const rect = canvas.getBoundingClientRect()
    const scale = zoomPercent / 100
    viewport.scrollLeft += rect.left + pending.logicalX * scale - pending.clientX
    viewport.scrollTop += rect.top + pending.logicalY * scale - pending.clientY
    pendingZoomAnchorRef.current = null
  }, [zoomPercent])

  const setCustomZoom = (nextZoom: number): void => {
    setZoomMode('custom')
    setZoomPercent(Math.max(25, Math.min(200, nextZoom)))
  }

  useEffect(() => {
    const viewport = canvasViewportRef.current
    if (!viewport) return
    const handleWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || (isMac() && event.metaKey))) return
      event.preventDefault()
      if (event.deltaY === 0) return
      const nextZoom = Math.max(25, Math.min(200, zoomPercent + (event.deltaY < 0 ? 5 : -5)))
      setZoomMode('custom')
      if (nextZoom === zoomPercent) return
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const scale = zoomPercent / 100
      pendingZoomAnchorRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        logicalX: (event.clientX - rect.left) / scale,
        logicalY: (event.clientY - rect.top) / scale,
        nextZoom
      }
      setZoomPercent(nextZoom)
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [zoomPercent])

  return {
    canvasViewportRef,
    canvasRef,
    zoomMode,
    zoomPercent,
    setCustomZoom,
    fitZoom: () => setZoomMode('fit')
  }
}
