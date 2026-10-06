import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, AlignJustify, Maximize2 } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { FileItemRecord } from '@shared/types/folder'
import { getFileSource, openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { getBlobId } from '@renderer/lib/blob-identity'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { usePresenterCommands } from '@renderer/contexts/PresenterCommandContext'
import { usePreviewCacheContext } from '@renderer/contexts/PreviewCacheContext'
import PreviewLoadError from './PreviewLoadError'

interface PdfPreviewProps {
  item: FileItemRecord
}

import { loadPdfjsLib } from '@renderer/lib/pdfjs-loader'

function renderPage(
  pdf: PDFDocumentProxy,
  pageNum: number,
  canvas: HTMLCanvasElement,
  onError: () => void
): () => void {
  let cancelled = false
  let task: RenderTask | undefined
  void pdf
    .getPage(pageNum)
    .then(async (page) => {
      if (cancelled) return
      const viewport = page.getViewport({ scale: 1.5 })
      canvas.width = viewport.width
      canvas.height = viewport.height
      const context = canvas.getContext('2d')
      if (!context) return
      task = page.render({ canvasContext: context, viewport, canvas })
      await task.promise
    })
    .catch((error: unknown) => {
      if (!cancelled && (error as { name?: string })?.name !== 'RenderingCancelledException')
        onError()
    })
  return () => {
    cancelled = true
    task?.cancel()
  }
}

export default function PdfPreview({ item }: PdfPreviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const { sendCommand } = usePresenterCommands()
  const { pdfPageThumbs } = usePreviewCacheContext()
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(() => {
    const saved = useMediaProjectionStore.getState().typeStates.pdf
    return saved?.itemId === item.id ? (saved.currentPage ?? 1) : 1
  })
  const [pageCount, setPageCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const blobId = getBlobId(item)

  const currentPageRef = useRef(currentPage)
  const slideCanvasRef = useRef<HTMLCanvasElement>(null)
  const scrollCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const thumbButtonRefs = useRef<(HTMLButtonElement | null)[]>([])

  const pdfViewMode = useMediaProjectionStore((s) => s.typeStates['pdf']?.viewMode ?? 'slide')
  const thumbsCollapsed = useMediaProjectionStore(
    (s) => s.typeStates['pdf']?.thumbsCollapsed ?? false
  )
  const zoomLevel = useMediaProjectionStore((s) => s.zoomLevel)
  const pan = useMediaProjectionStore((s) => s.pan)
  const remoteSourceUrl = useMediaProjectionStore((s) => {
    const entry = s.snapshot?.entries.find((candidate) => candidate.itemId === item.id)
    if (!entry?.remoteItem) return undefined
    return entry.remoteSource ? entry.sourceUrl : null
  })

  const thumbs = pdfPageThumbs[item.id] ?? []

  const setPdfState = useCallback(
    (
      partial: Partial<{
        viewMode: 'slide' | 'scroll'
        thumbsCollapsed: boolean
        currentPage: number
        scrollPage: number
      }>
    ) => {
      const current = useMediaProjectionStore.getState().typeStates['pdf']
      useMediaProjectionStore.getState().setTypeState('pdf', {
        viewMode: current?.viewMode ?? 'slide',
        thumbsCollapsed: current?.thumbsCollapsed ?? false,
        ...(current?.itemId === item.id ? current : {}),
        itemId: item.id,
        ...partial
      })
    },
    [item.id]
  )

  const selectPage = useCallback(
    (requestedPage: number): void => {
      if (pageCount <= 0) return
      const nextPage = Math.min(pageCount, Math.max(1, requestedPage))
      if (nextPage === currentPageRef.current) return
      currentPageRef.current = nextPage
      setCurrentPage(nextPage)
      setPdfState({ currentPage: nextPage })
      sendCommand({ action: 'pdfPage', itemId: item.id, value: nextPage })
    },
    [item.id, pageCount, sendCommand, setPdfState]
  )

  useEffect(() => {
    let cancelled = false
    let revokeSource: (() => void) | null = null
    let doc: PDFDocumentProxy | null = null
    let loadingTask: PDFDocumentLoadingTask | null = null

    async function load(): Promise<void> {
      setLoading(true)
      setError(false)
      try {
        if (remoteSourceUrl === null) return
        const source = remoteSourceUrl
          ? { url: remoteSourceUrl, revoke: (): void => undefined }
          : await getFileSource(await openFileExplorerDB(), blobId, item.mimeType)
        if (cancelled) {
          source?.revoke()
          return
        }
        if (!source) {
          if (!cancelled) {
            setError(true)
            setLoading(false)
            toast.warning(t('fileExplorer.blobLoadFailed'))
          }
          return
        }

        revokeSource = source.revoke
        const pdfjsLib = await loadPdfjsLib()
        if (cancelled) return
        loadingTask = pdfjsLib.getDocument({ url: source.url })
        const pdf = await loadingTask.promise
        loadingTask = null
        if (cancelled) {
          void pdf.loadingTask.destroy()
          return
        }
        doc = pdf
        setPdfDoc(pdf)
        setPageCount(pdf.numPages)
        const saved = useMediaProjectionStore.getState().typeStates.pdf
        const page = Math.min(
          pdf.numPages,
          Math.max(1, saved?.itemId === item.id ? (saved.currentPage ?? 1) : 1)
        )
        currentPageRef.current = page
        setCurrentPage(page)
        setPdfState({
          currentPage: page,
          scrollPage: Math.min(
            Math.max(0, pdf.numPages - 0.000001),
            Math.max(0, saved?.itemId === item.id ? (saved.scrollPage ?? 0) : 0)
          )
        })
        setLoading(false)
      } catch {
        if (!cancelled) {
          setError(true)
          setLoading(false)
          toast.warning(t('fileExplorer.blobLoadFailed'))
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      revokeSource?.()
      void loadingTask?.destroy?.()
      if (doc) void doc.loadingTask.destroy()
      setPdfDoc(null)
    }
  }, [blobId, item.id, item.mimeType, remoteSourceUrl, retryToken, setPdfState, t])

  useEffect(() => {
    if (!pdfDoc || pdfViewMode !== 'slide') return
    const canvas = slideCanvasRef.current
    if (!canvas) return
    return renderPage(pdfDoc, currentPage, canvas, () => setError(true))
  }, [pdfDoc, currentPage, pdfViewMode])

  const renderedPagesRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    if (!pdfDoc || pdfViewMode !== 'scroll') return

    renderedPagesRef.current = new Set()

    const cancellations: Array<() => void> = []
    const firstCanvas = scrollCanvasRefs.current[0]
    if (firstCanvas) {
      renderedPagesRef.current.add(0)
      cancellations.push(renderPage(pdfDoc, 1, firstCanvas, () => setError(true)))
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const canvas = entry.target as HTMLCanvasElement
            const pageIndex = Number(canvas.dataset.pageIndex)
            if (!renderedPagesRef.current.has(pageIndex)) {
              renderedPagesRef.current.add(pageIndex)
              cancellations.push(renderPage(pdfDoc, pageIndex + 1, canvas, () => setError(true)))
            }
            observer.unobserve(canvas)
          }
        }
      },
      { rootMargin: '200px' }
    )

    scrollCanvasRefs.current.forEach((canvas) => {
      if (canvas) observer.observe(canvas)
    })

    let cancelled = false
    const saved = useMediaProjectionStore.getState().typeStates.pdf
    const scroll = saved?.itemId === item.id ? (saved.scrollPage ?? 0) : 0
    const targetIndex = Math.min(pageCount - 1, Math.floor(scroll))
    // Restore geometry before scrolling: unrendered canvases still have the browser's default size.
    if (scroll > 0) {
      void Promise.all(
        Array.from({ length: targetIndex + 1 }, async (_, index) => {
          const page = await pdfDoc.getPage(index + 1)
          if (cancelled) return
          const canvas = scrollCanvasRefs.current[index]
          if (!canvas) return
          const viewport = page.getViewport({ scale: 1.5 })
          Object.assign(canvas.style, {
            width: '100%',
            maxWidth: `${viewport.width}px`,
            height: 'auto',
            aspectRatio: `${viewport.width} / ${viewport.height}`
          })
        })
      )
        .then(() => {
          if (cancelled) return
          const target = scrollCanvasRefs.current[targetIndex]
          if (target && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop =
              target.offsetTop + (scroll % 1) * target.clientHeight
          }
        })
        .catch(() => {
          if (!cancelled) setError(true)
        })
    }
    return () => {
      cancelled = true
      observer.disconnect()
      cancellations.forEach((cancel) => cancel())
    }
  }, [item.id, pdfDoc, pdfViewMode, pageCount])

  useEffect(() => {
    const handleNext = (): void => selectPage(currentPageRef.current + 1)
    const handlePrev = (): void => selectPage(currentPageRef.current - 1)
    window.addEventListener('media:pdfNextPage', handleNext)
    window.addEventListener('media:pdfPrevPage', handlePrev)
    return () => {
      window.removeEventListener('media:pdfNextPage', handleNext)
      window.removeEventListener('media:pdfPrevPage', handlePrev)
    }
  }, [selectPage])

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = scrollContainerRef.current
      const canvases = scrollCanvasRefs.current
      if (!el || !canvases.length) return
      const containerTop = el.getBoundingClientRect().top
      for (let i = 0; i < canvases.length; i++) {
        const canvas = canvases[i]
        if (!canvas) continue
        const rect = canvas.getBoundingClientRect()
        if (rect.bottom > containerTop && rect.height > 0) {
          const fraction = Math.max(0, containerTop - rect.top) / rect.height
          setPdfState({ scrollPage: i + fraction })
          sendCommand({ action: 'pdfScroll', itemId: item.id, value: i + fraction })
          return
        }
      }
      const scrollPage = Math.max(0, canvases.length - 1)
      setPdfState({ scrollPage })
      sendCommand({ action: 'pdfScroll', itemId: item.id, value: scrollPage })
    })
  }, [item.id, sendCommand, setPdfState])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    if (thumbsCollapsed) return
    const el = thumbButtonRefs.current[currentPage - 1]
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [currentPage, thumbsCollapsed])

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-foreground/50">
        {t('presenter.loading')}
      </div>
    )
  }

  if (error || !pdfDoc) {
    return (
      <PreviewLoadError
        message={t('presenter.pdfLoadFailed')}
        retryLabel={t('presenter.retryPreview', 'Retry preview')}
        onRetry={() => setRetryToken((value) => value + 1)}
      />
    )
  }

  if (pdfViewMode === 'scroll') {
    return (
      <div className="w-full h-full relative bg-black">
        <div
          ref={scrollContainerRef}
          className="w-full h-full overflow-y-auto flex flex-col items-center gap-4 py-4"
          onScroll={handleScroll}
        >
          {Array.from({ length: pageCount }, (_, i) => (
            <canvas
              key={i + 1}
              ref={(el) => {
                scrollCanvasRefs.current[i] = el
              }}
              data-page-index={i}
              style={{ maxWidth: '100%' }}
            />
          ))}
        </div>
        <div className="absolute bottom-2 left-2 z-20" onMouseDown={(e) => e.stopPropagation()}>
          <button
            aria-label={t('presenter.pdfSinglePage', 'Single page')}
            className="inline-flex items-center rounded-full p-2 pdf-sidebar-bg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
            onClick={() => {
              setPdfState({ viewMode: 'slide' })
              sendCommand({ action: 'pdfViewMode', itemId: item.id, value: 'single' })
            }}
          >
            <Maximize2 size={20} aria-hidden="true" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full relative flex items-center justify-center overflow-hidden">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          transform:
            zoomLevel !== 1
              ? `scale(${zoomLevel}) translate(${(pan.x / zoomLevel) * 100}%, ${(pan.y / zoomLevel) * 100}%)`
              : undefined,
          transformOrigin: 'center center',
          transition: 'transform 0.15s ease'
        }}
      >
        <canvas
          ref={slideCanvasRef}
          style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}
        />
      </div>

      <div
        className="absolute top-0 left-0 bottom-0 z-20 overflow-hidden"
        style={{
          width: 'max(25%, 190px)',
          minWidth: 190,
          pointerEvents: thumbsCollapsed ? 'none' : 'auto'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="w-full h-full flex flex-col pdf-sidebar-bg rounded-tr-xl rounded-br-xl transition-transform duration-200 ease-in-out"
          style={{ transform: thumbsCollapsed ? 'translateX(-100%)' : 'translateX(0)' }}
        >
          <div className="flex-1 overflow-y-auto flex flex-col gap-2 p-4">
            {thumbs.map((url, i) => (
              <button
                key={i}
                ref={(el) => {
                  thumbButtonRefs.current[i] = el
                }}
                className={`relative rounded overflow-hidden border-2 transition-colors shrink-0 ${
                  currentPage === i + 1 ? 'border-white/80' : 'border-transparent'
                }`}
                onClick={() => selectPage(i + 1)}
              >
                <img src={url} alt={`page ${i + 1}`} style={{ width: '100%', display: 'block' }} />
                <span className="absolute bottom-0.5 right-1 text-white/60 text-xs">{i + 1}</span>
              </button>
            ))}
          </div>

          <div className="shrink-0 flex items-center justify-center gap-1 p-1.5 border-t border-white/10">
            <button
              className="text-white/80 hover:text-white hover:bg-white/10 rounded-full p-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label={t('presenter.previousPage', 'Previous page')}
              onClick={() => window.dispatchEvent(new CustomEvent('media:pdfPrevPage'))}
              disabled={currentPage <= 1}
            >
              <ChevronLeft size={20} />
            </button>
            <span className="text-white/70 text-sm tabular-nums px-1">
              {currentPage} / {pageCount}
            </span>
            <button
              className="text-white/80 hover:text-white hover:bg-white/10 rounded-full p-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label={t('presenter.nextPage', 'Next page')}
              onClick={() => window.dispatchEvent(new CustomEvent('media:pdfNextPage'))}
              disabled={currentPage >= pageCount}
            >
              <ChevronRight size={20} />
            </button>
            <div className="w-px h-4 bg-white/20 mx-1" />
            <button
              className="text-white/80 hover:text-white hover:bg-white/10 rounded-full p-1.5 transition-colors"
              aria-label={t('presenter.pdfContinuous', 'Continuous scrolling')}
              onClick={() => {
                setPdfState({ viewMode: 'scroll' })
                sendCommand({ action: 'pdfViewMode', itemId: item.id, value: 'continuous' })
              }}
            >
              <AlignJustify size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div
        className="absolute top-1/2 -translate-y-1/2 z-30 transition-[left] duration-200 ease-in-out"
        style={{ left: thumbsCollapsed ? 0 : 'max(25%, 190px)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="flex items-center justify-center w-5 h-10 pdf-sidebar-bg rounded-r-lg text-white/70 hover:text-white transition-colors"
          aria-label={t('presenter.toggleThumbnails', 'Toggle page thumbnails')}
          aria-expanded={!thumbsCollapsed}
          onClick={() => setPdfState({ thumbsCollapsed: !thumbsCollapsed })}
        >
          {thumbsCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-200 ${
          thumbsCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex justify-start pl-2 pb-2">
          <div className="inline-flex items-center gap-1 pl-2 pr-3 py-1.5 rounded-full pdf-sidebar-bg">
            <button
              className="text-white/80 hover:text-white hover:bg-white/10 rounded-full p-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label={t('presenter.previousPage', 'Previous page')}
              onClick={() => window.dispatchEvent(new CustomEvent('media:pdfPrevPage'))}
              disabled={currentPage <= 1}
            >
              <ChevronLeft size={20} />
            </button>
            <span className="text-white/70 text-sm tabular-nums px-1">
              {currentPage} / {pageCount}
            </span>
            <button
              className="text-white/80 hover:text-white hover:bg-white/10 rounded-full p-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label={t('presenter.nextPage', 'Next page')}
              onClick={() => window.dispatchEvent(new CustomEvent('media:pdfNextPage'))}
              disabled={currentPage >= pageCount}
            >
              <ChevronRight size={20} />
            </button>
            <div className="w-px h-4 bg-white/20 mx-1" />
            <button
              className="text-white/80 hover:text-white hover:bg-white/10 rounded-full p-1.5 transition-colors"
              aria-label={t('presenter.pdfContinuous', 'Continuous scrolling')}
              onClick={() => {
                setPdfState({ viewMode: 'scroll' })
                sendCommand({ action: 'pdfViewMode', itemId: item.id, value: 'continuous' })
              }}
            >
              <AlignJustify size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
