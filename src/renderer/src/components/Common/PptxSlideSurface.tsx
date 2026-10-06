import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { Spinner } from '@heroui/react/spinner'
import { openPptxViewer, type PptxViewerHandle } from '@renderer/lib/pptx-renderer-service'
import {
  readPresentationArrayBuffer,
  type PresentationSource
} from '@renderer/lib/presentation-source'

type PptxSlideSurfaceStatus = 'idle' | 'loading' | 'ready' | 'failed'

interface PptxSlideSurfaceProps {
  source: PresentationSource
  slideIndex: number
  className?: string
  verifyNativeFile?: boolean
  onReady?: (info: { slideCount: number; width: number; height: number }) => void
  onError?: (error: Error) => void
}

export default function PptxSlideSurface({
  source,
  slideIndex,
  className,
  verifyNativeFile,
  onReady,
  onError
}: PptxSlideSurfaceProps): React.JSX.Element {
  const sourceId = source.id
  const sourceUrl = source.url
  const sourceMimeType = source.mimeType
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PptxViewerHandle | null>(null)
  const [viewer, setViewer] = useState<PptxViewerHandle | null>(null)
  const [status, setStatus] = useState<PptxSlideSurfaceStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) return
    const target = container

    target.innerHTML = ''
    viewerRef.current?.destroy()
    viewerRef.current = null

    async function open(): Promise<void> {
      await Promise.resolve()
      if (cancelled) return
      setViewer(null)
      setStatus('loading')
      setError(null)
      try {
        const buffer = await readPresentationArrayBuffer(
          {
            id: sourceId,
            url: sourceUrl,
            mimeType: sourceMimeType
          },
          { verifyNativeFile }
        )
        if (cancelled) return
        const handle = await openPptxViewer(buffer, target, { renderMode: 'slide' })
        if (cancelled) {
          handle.destroy()
          return
        }
        viewerRef.current = handle
        setViewer(handle)
        setStatus('ready')
      } catch (loadError) {
        if (cancelled) return
        const nextError = loadError instanceof Error ? loadError : new Error(String(loadError))
        setStatus('failed')
        setError(nextError.message)
        onError?.(nextError)
      }
    }

    void open()
    return () => {
      cancelled = true
      viewerRef.current?.destroy()
      viewerRef.current = null
    }
  }, [onError, sourceId, sourceMimeType, sourceUrl, verifyNativeFile])

  useEffect(() => {
    const current = viewerRef.current
    if (!current || status !== 'ready') return
    const clampedSlideIndex = Math.max(0, Math.min(slideIndex, current.slideCount - 1))
    let cancelled = false
    void current.viewer
      .renderSlide(clampedSlideIndex)
      .then(() => {
        if (cancelled || viewerRef.current !== current) return
        onReady?.({
          slideCount: current.slideCount,
          width: current.slideWidth,
          height: current.slideHeight
        })
      })
      .catch((renderError) => {
        if (cancelled || viewerRef.current !== current) return
        const nextError =
          renderError instanceof Error ? renderError : new Error(String(renderError))
        setStatus('failed')
        setError(nextError.message)
        onError?.(nextError)
      })
    return () => {
      cancelled = true
    }
  }, [onError, onReady, slideIndex, status, viewer])

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className ?? ''}`}>
      <div ref={containerRef} className="h-full w-full" />
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <Spinner />
        </div>
      )}
      {status === 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black p-6 text-center">
          <FileText className="mb-3 text-danger" size={36} />
          <p className="max-w-lg text-sm text-danger">{error ?? 'Failed to render presentation'}</p>
        </div>
      )}
    </div>
  )
}
