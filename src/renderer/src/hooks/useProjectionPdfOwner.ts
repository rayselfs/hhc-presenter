import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { loadPdfjsLib } from '@renderer/lib/pdfjs-loader'
import { getPdfPageThumbs } from '@renderer/lib/thumbnail-db'

interface PdfState {
  document: PDFDocumentProxy
  pages: Array<HTMLCanvasElement | undefined>
  pageSizes: Array<{ width: number; height: number } | undefined>
  currentPage: number
  scrollPage: number
  viewMode: 'single' | 'continuous'
}

export const PDF_CONTINUOUS_PAGE_GAP = 16
const PDF_CONTINUOUS_PADDING = 16
export const PDF_CONTINUOUS_CANVAS_RADIUS = 2

export function getPdfPageHeight(
  size: { width: number; height: number } | undefined,
  containerWidth: number
): number {
  if (!size) return 0
  return size.height * Math.min(1, containerWidth > 0 ? containerWidth / size.width : 1)
}

interface PdfPosition {
  page: number
  scroll: number
  viewMode: 'single' | 'continuous'
}

interface ProjectionPdfOwner {
  pdfState: PdfState | null
  pdfPreviewUrls: string[]
  pdfContainerRef: RefObject<HTMLDivElement | null>
  pdfContainerWidth: number
  pdfPageCount: number
  pdfWindowCenter: number
  pdfWindowStart: number
  pdfWindowEnd: number
  disposePdf(): void
  cancelPendingPdfLoad(): void
  hasPdfDocument(): boolean
  loadPdf(
    sourceUrl: string,
    itemId: string,
    sequence: number,
    retainSurface?: boolean
  ): Promise<boolean>
  loadPdfPreviews(blobId: string, itemId: string, sequence: number): Promise<void>
  preparePdf(position: PdfPosition): void
  getPdfPosition(): PdfPosition
  resetPdfSurface(): void
  setPdfPage(page: number): void
  setPdfScroll(scroll: number): void
  setPdfViewMode(viewMode: PdfPosition['viewMode']): void
  applyPdfReplay(position: PdfPosition): void
}

export function useProjectionPdfOwner({
  isCurrentSource,
  onInstalled,
  reportRenderStatus
}: {
  isCurrentSource: (itemId: string, sequence: number) => boolean
  onInstalled: () => void
  reportRenderStatus: (status: 'ready' | 'failed', sequence?: number) => void
}): ProjectionPdfOwner {
  const [pdfState, setPdfState] = useState<PdfState | null>(null)
  const [pdfPreviewUrls, setPdfPreviewUrls] = useState<string[]>([])
  const [pdfContainerWidth, setPdfContainerWidth] = useState(0)
  const pdfContainerRef = useRef<HTMLDivElement>(null)
  const pendingPdfRenderRef = useRef<RenderTask | null>(null)
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null)
  const pdfLoadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const pdfPagePromisesRef = useRef<Map<number, Promise<PDFPageProxy>>>(new Map())
  const pdfRenderTasksRef = useRef<Map<number, RenderTask>>(new Map())
  const pdfWindowRef = useRef<Set<number>>(new Set())
  const pdfMeasuredDocumentRef = useRef<PDFDocumentProxy | null>(null)
  const pendingPdfRef = useRef<PdfPosition>({ page: 1, scroll: 0, viewMode: 'single' })

  const disposePdf = useCallback((): void => {
    pendingPdfRenderRef.current?.cancel()
    pendingPdfRenderRef.current = null
    void pdfLoadingTaskRef.current?.destroy?.()
    pdfLoadingTaskRef.current = null
    for (const task of pdfRenderTasksRef.current.values()) task.cancel()
    pdfRenderTasksRef.current.clear()
    pdfPagePromisesRef.current.clear()
    pdfWindowRef.current.clear()
    pdfMeasuredDocumentRef.current = null
    const document = pdfDocumentRef.current
    pdfDocumentRef.current = null
    if (document) void document.loadingTask.destroy()
  }, [])

  const loadPdf = useCallback(
    async (
      sourceUrl: string,
      itemId: string,
      loadSequence: number,
      retainSurface = false
    ): Promise<boolean> => {
      const pdfjsLib = await loadPdfjsLib()
      if (!isCurrentSource(itemId, loadSequence)) return false
      const loadingTask = pdfjsLib.getDocument({ url: sourceUrl })
      pdfLoadingTaskRef.current = loadingTask
      const document = await loadingTask.promise
      if (pdfLoadingTaskRef.current === loadingTask) pdfLoadingTaskRef.current = null
      const isCurrent = (): boolean => isCurrentSource(itemId, loadSequence)
      if (!isCurrent()) {
        await document.loadingTask.destroy()
        return false
      }
      const pages = new Array<HTMLCanvasElement | undefined>(document.numPages).fill(undefined)
      const pageSizes = new Array<{ width: number; height: number } | undefined>(
        document.numPages
      ).fill(undefined)
      try {
        if (retainSurface) {
          let readyPage = 0
          const desiredPage = (): number =>
            Math.min(
              document.numPages,
              Math.max(
                1,
                pendingPdfRef.current.viewMode === 'continuous'
                  ? Math.floor(pendingPdfRef.current.scroll) + 1
                  : Math.floor(pendingPdfRef.current.page)
              )
            )
          while (isCurrent() && readyPage !== desiredPage()) {
            const pageNumber = desiredPage()
            const page = await document.getPage(pageNumber)
            if (!isCurrent()) break
            const viewport = page.getViewport({ scale: 2 })
            const canvas = window.document.createElement('canvas')
            canvas.width = Math.ceil(viewport.width)
            canvas.height = Math.ceil(viewport.height)
            const context = canvas.getContext('2d')
            if (!context) throw new Error('PDF canvas unavailable')
            const task = page.render({ canvas, canvasContext: context, viewport })
            pendingPdfRenderRef.current = task
            await task.promise
            if (pendingPdfRenderRef.current === task) pendingPdfRenderRef.current = null
            pages[pageNumber - 1] = canvas
            pageSizes[pageNumber - 1] = { width: canvas.width, height: canvas.height }
            readyPage = pageNumber
          }
        }
        if (!isCurrent()) {
          await document.loadingTask.destroy()
          return false
        }
        disposePdf()
        pdfDocumentRef.current = document
        onInstalled()
        const pending = pendingPdfRef.current
        setPdfState({
          document,
          pages,
          pageSizes,
          currentPage: Math.min(document.numPages, Math.max(1, Math.floor(pending.page))),
          scrollPage: Math.min(
            Math.max(0, document.numPages - 0.000001),
            Math.max(0, pending.scroll)
          ),
          viewMode: pending.viewMode
        })
        if (retainSurface) reportRenderStatus('ready', loadSequence)
        return true
      } catch (error) {
        await document.loadingTask.destroy()
        throw error
      }
    },
    [disposePdf, reportRenderStatus, isCurrentSource, onInstalled]
  )

  const loadPdfPreviews = useCallback(
    async (blobId: string, itemId: string, loadSequence: number): Promise<void> => {
      const urls = await getPdfPageThumbs(blobId)
      if (!isCurrentSource(itemId, loadSequence)) {
        urls.forEach((url) => URL.revokeObjectURL(url))
        return
      }
      setPdfPreviewUrls(urls)
    },
    [isCurrentSource]
  )

  useEffect(
    () => () => {
      pdfPreviewUrls.forEach((url) => URL.revokeObjectURL(url))
    },
    [pdfPreviewUrls]
  )

  const pdfPageCount = pdfState?.document.numPages ?? 0
  const pdfDocument = pdfState?.document
  const pdfViewMode = pdfState?.viewMode
  const pdfWindowCenter = pdfState
    ? pdfState.viewMode === 'continuous'
      ? Math.min(pdfPageCount, Math.max(1, Math.floor(pdfState.scrollPage) + 1))
      : Math.min(pdfPageCount, Math.max(1, Math.floor(pdfState.currentPage)))
    : 1
  const pdfWindowStart = pdfState
    ? pdfState.viewMode === 'continuous'
      ? Math.max(1, pdfWindowCenter - PDF_CONTINUOUS_CANVAS_RADIUS)
      : pdfWindowCenter
    : 1
  const pdfWindowEnd = pdfState
    ? pdfState.viewMode === 'continuous'
      ? Math.min(pdfPageCount, pdfWindowCenter + PDF_CONTINUOUS_CANVAS_RADIUS)
      : pdfWindowCenter
    : 0

  useEffect(() => {
    const document = pdfState?.document
    if (!document || pdfWindowEnd < pdfWindowStart) return

    const wantedPages = new Set<number>()
    for (let pageNumber = pdfWindowStart; pageNumber <= pdfWindowEnd; pageNumber++) {
      wantedPages.add(pageNumber)
    }
    pdfWindowRef.current = wantedPages

    for (const [pageNumber, task] of pdfRenderTasksRef.current) {
      if (!wantedPages.has(pageNumber)) {
        task.cancel()
        pdfRenderTasksRef.current.delete(pageNumber)
      }
    }
    setPdfState((previous) => {
      if (!previous || previous.document !== document) return previous
      const pages = previous.pages.map((canvas, index) =>
        wantedPages.has(index + 1) ? canvas : undefined
      )
      return pages.some((canvas, index) => canvas !== previous.pages[index])
        ? { ...previous, pages }
        : previous
    })

    const getPage = (pageNumber: number): Promise<PDFPageProxy> => {
      let promise = pdfPagePromisesRef.current.get(pageNumber)
      if (!promise) {
        promise = document.getPage(pageNumber)
        pdfPagePromisesRef.current.set(pageNumber, promise)
      }
      return promise
    }

    const renderPage = async (pageNumber: number): Promise<void> => {
      let task: RenderTask | undefined
      try {
        const page = await getPage(pageNumber)
        if (
          pdfDocumentRef.current !== document ||
          !pdfWindowRef.current.has(pageNumber) ||
          pdfRenderTasksRef.current.has(pageNumber)
        ) {
          return
        }

        const viewport = page.getViewport({ scale: 2 })
        const canvas = window.document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) return
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        task = page.render({ canvas, canvasContext: context, viewport })
        pdfRenderTasksRef.current.set(pageNumber, task)
        setPdfState((previous) => {
          if (
            !previous ||
            previous.document !== document ||
            !pdfWindowRef.current.has(pageNumber)
          ) {
            task?.cancel()
            return previous
          }
          const pageSizes = [...previous.pageSizes]
          pageSizes[pageNumber - 1] = { width: canvas.width, height: canvas.height }
          return { ...previous, pageSizes }
        })

        await task.promise
        if (pdfDocumentRef.current !== document || !pdfWindowRef.current.has(pageNumber)) return
        setPdfState((previous) => {
          if (!previous || previous.document !== document) return previous
          const pages = [...previous.pages]
          pages[pageNumber - 1] = canvas
          return { ...previous, pages }
        })
        if (pageNumber === pdfWindowCenter) reportRenderStatus('ready')
      } catch (error) {
        const errorName = (error as { name?: string })?.name
        if (
          pdfDocumentRef.current === document &&
          errorName !== 'RenderingCancelledException' &&
          errorName !== 'AbortException'
        ) {
          console.error('[file-projection] PDF page render failed', error)
          reportRenderStatus('failed')
        }
      } finally {
        if (task && pdfRenderTasksRef.current.get(pageNumber) === task) {
          pdfRenderTasksRef.current.delete(pageNumber)
        }
      }
    }

    for (const pageNumber of wantedPages) {
      if (!pdfState.pages[pageNumber - 1]) void renderPage(pageNumber)
    }

    if (pdfState.viewMode === 'continuous' && pdfMeasuredDocumentRef.current !== document) {
      pdfMeasuredDocumentRef.current = document
      void Promise.all(
        Array.from({ length: pdfPageCount }, async (_, index) => {
          const page = await getPage(index + 1)
          const viewport = page.getViewport({ scale: 2 })
          return { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) }
        })
      )
        .then((pageSizes) => {
          if (pdfDocumentRef.current === document) {
            setPdfState((previous) =>
              previous?.document === document ? { ...previous, pageSizes } : previous
            )
          }
        })
        .catch((error) => {
          if (pdfDocumentRef.current === document) {
            console.error('[file-projection] PDF page measurement failed', error)
          }
        })
    }
  }, [
    pdfPageCount,
    pdfState?.document,
    pdfState?.viewMode,
    pdfState?.pages,
    pdfWindowEnd,
    pdfWindowStart,
    pdfWindowCenter,
    reportRenderStatus
  ])

  useEffect(() => {
    const container = pdfContainerRef.current
    if (!pdfDocument || pdfViewMode !== 'continuous' || !container) return

    const updateWidth = (): void => {
      setPdfContainerWidth((previous) =>
        previous === container.clientWidth ? previous : container.clientWidth
      )
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [pdfDocument, pdfViewMode])

  useEffect(() => {
    const container = pdfContainerRef.current
    if (!pdfState || pdfState.viewMode !== 'continuous' || !container) return

    const frame = requestAnimationFrame(() => {
      const pageFloat = Math.max(0, pdfState.scrollPage)
      const pageIndex = Math.min(Math.floor(pageFloat), Math.max(0, pdfState.document.numPages - 1))
      const fraction = pageFloat - Math.floor(pageFloat)
      const fallbackSize = pdfState.pageSizes.find((size) => size !== undefined)
      let target = PDF_CONTINUOUS_PADDING
      for (let index = 0; index < pageIndex; index++) {
        target +=
          getPdfPageHeight(pdfState.pageSizes[index] ?? fallbackSize, pdfContainerWidth) +
          PDF_CONTINUOUS_PAGE_GAP
      }
      target +=
        fraction *
        getPdfPageHeight(pdfState.pageSizes[pageIndex] ?? fallbackSize, pdfContainerWidth)
      container.scrollTop = target
    })
    return () => cancelAnimationFrame(frame)
  }, [pdfContainerWidth, pdfState])

  const hasPdfDocument = useCallback((): boolean => pdfDocumentRef.current !== null, [])
  const cancelPendingPdfLoad = useCallback((): void => {
    pendingPdfRenderRef.current?.cancel()
    pendingPdfRenderRef.current = null
    void pdfLoadingTaskRef.current?.destroy?.()
    pdfLoadingTaskRef.current = null
  }, [])
  const preparePdf = useCallback((position: PdfPosition): void => {
    pendingPdfRef.current = position
  }, [])
  const resetPdfSurface = useCallback((): void => {
    setPdfState(null)
    setPdfPreviewUrls([])
  }, [])
  const setPdfPage = useCallback((page: number): void => {
    pendingPdfRef.current.page = page
    setPdfState((previous) =>
      previous
        ? {
            ...previous,
            currentPage: Math.min(previous.document.numPages, Math.max(1, Math.floor(page)))
          }
        : previous
    )
  }, [])
  const setPdfScroll = useCallback((scroll: number): void => {
    pendingPdfRef.current.scroll = scroll
    setPdfState((previous) =>
      previous
        ? {
            ...previous,
            scrollPage: Math.min(
              Math.max(0, previous.document.numPages - 0.000001),
              Math.max(0, scroll)
            )
          }
        : previous
    )
  }, [])
  const setPdfViewMode = useCallback((viewMode: PdfPosition['viewMode']): void => {
    pendingPdfRef.current.viewMode = viewMode
    setPdfState((previous) => (previous ? { ...previous, viewMode } : previous))
  }, [])
  const applyPdfReplay = useCallback((position: PdfPosition): void => {
    pendingPdfRef.current = { ...position }
    setPdfState((previous) =>
      previous
        ? {
            ...previous,
            currentPage: Math.min(
              previous.document.numPages,
              Math.max(1, Math.floor(position.page))
            ),
            scrollPage: Math.min(
              Math.max(0, previous.document.numPages - 0.000001),
              Math.max(0, position.scroll)
            ),
            viewMode: position.viewMode
          }
        : previous
    )
  }, [])

  return {
    pdfState,
    pdfPreviewUrls,
    pdfContainerRef,
    pdfContainerWidth,
    pdfPageCount,
    pdfWindowCenter,
    pdfWindowStart,
    pdfWindowEnd,
    disposePdf,
    cancelPendingPdfLoad,
    hasPdfDocument,
    loadPdf,
    loadPdfPreviews,
    preparePdf,
    getPdfPosition: () => pendingPdfRef.current,
    resetPdfSurface,
    setPdfPage,
    setPdfScroll,
    setPdfViewMode,
    applyPdfReplay
  }
}
