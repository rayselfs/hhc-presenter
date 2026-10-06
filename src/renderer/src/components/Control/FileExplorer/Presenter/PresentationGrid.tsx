import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SlideHandle } from '@aiden0z/pptx-renderer'
import { Button } from '@heroui/react'
import { Spinner } from '@heroui/react/spinner'
import { toast } from '@heroui/react/toast'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FileItemRecord } from '@shared/types/folder'
import EditableSlideSurface from '@renderer/components/Common/EditableSlideSurface'
import { usePresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import {
  loadEditablePresentation,
  type EditablePresentationDocument
} from '@renderer/lib/editable-presentation'
import { isEditablePresentationMimeType } from '@renderer/lib/presentation-media'
import { readPresentationArrayBuffer } from '@renderer/lib/presentation-source'
import { openPptxViewer, type PptxViewerHandle } from '@renderer/lib/pptx-renderer-service'
import {
  resolveMediaProjectionAction,
  useMediaProjectionStore
} from '@renderer/stores/media-projection'

const noSubscribe = (): (() => void) => () => {}
const emptySnapshot = (): null => null

export default function PresentationGrid({ item }: { item: FileItemRecord }): React.JSX.Element {
  const { t } = useTranslation()
  const registry = usePresentationSessionRegistry()
  const session = isEditablePresentationMimeType(item.mimeType) ? registry.get(item.id) : undefined
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.getSnapshot ?? emptySnapshot
  )
  const [storedDocument, setStoredDocument] = useState<EditablePresentationDocument | null>(null)
  const document = snapshot?.history.present ?? storedDocument
  const [viewer, setViewer] = useState<PptxViewerHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState<Set<number>>(new Set())
  const mounted = useRef(false)
  const viewport = useRef<HTMLDivElement>(null)
  const viewerHost = useRef<HTMLDivElement>(null)
  const active = useMediaProjectionStore((state) => state.typeStates.presentation?.slideIndex ?? 0)
  const [focused, setFocused] = useState(active)
  const count = document?.slideOrder.length ?? viewer?.slideCount ?? 0
  const toggleGrid = useMediaProjectionStore((state) => state.toggleGrid)
  const remoteSource = useMediaProjectionStore((state) => {
    const entry = state.snapshot?.entries.find((candidate) => candidate.itemId === item.id)
    return entry?.remoteSource ? entry.sourceUrl : undefined
  })

  useEffect(() => {
    if (session && isEditablePresentationMimeType(item.mimeType)) return
    let cancelled = false
    let opened: PptxViewerHandle | undefined
    const controller = new AbortController()
    async function load(): Promise<void> {
      await Promise.resolve()
      if (cancelled) return
      setError(null)
      setViewer(null)
      try {
        if (isEditablePresentationMimeType(item.mimeType)) {
          const loaded = await loadEditablePresentation(item)
          if (!cancelled) setStoredDocument(loaded)
          return
        }
        if (!viewerHost.current) return
        const buffer = await readPresentationArrayBuffer(
          remoteSource ? { ...item, url: remoteSource } : item
        )
        if (cancelled) return
        opened = await openPptxViewer(buffer, viewerHost.current, { signal: controller.signal })
        if (cancelled) opened.destroy()
        else setViewer(opened)
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void load()
    return () => {
      cancelled = true
      controller.abort()
      opened?.destroy()
    }
  }, [item, remoteSource, session])

  useEffect(() => {
    if (count < 1) return
    const state = useMediaProjectionStore.getState()
    if (state.currentItem()?.id !== item.id || state.currentItem()?.url !== item.url) return
    const current = state.typeStates.presentation ?? { slideIndex: 0 }
    if (current.slideCount !== count)
      state.setTypeState('presentation', {
        slideIndex: Math.min(current.slideIndex, count - 1),
        slideCount: count
      })
  }, [count, item.id, item.url])

  useEffect(() => {
    const root = viewport.current
    if (!root || count < 1) return
    const handles = new Map<number, SlideHandle>()
    const targets = new Map<number, HTMLElement>()
    let cancelled = false
    const update = (target: HTMLElement, showing: boolean): void => {
      if (cancelled) return
      const index = Number(target.dataset.slideIndex)
      if (document) {
        setVisible((old) => {
          const next = new Set(old)
          if (showing) next.add(index)
          else next.delete(index)
          return next
        })
        return
      }
      if (showing && viewer && !handles.has(index)) {
        targets.set(index, target)
        resizeObserver.observe(target)
        const width = target.clientWidth
        const height = target.clientHeight
        if (width <= 0 || height <= 0) return
        const handle = viewer.viewer.renderThumbnailToContainer(index, target, { width, height })
        if (!handle) return
        handles.set(index, handle)
        void handle.ready.catch((failure: unknown) => {
          if (!cancelled && handles.get(index) === handle)
            setError(failure instanceof Error ? failure.message : String(failure))
        })
      } else if (!showing) {
        targets.delete(index)
        resizeObserver.unobserve(target)
        handles.get(index)?.dispose()
        handles.delete(index)
        target.replaceChildren()
      }
    }
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const index = Number(target.dataset.slideIndex)
        if (cancelled || targets.get(index) !== target) continue
        handles.get(index)?.dispose()
        handles.delete(index)
        target.replaceChildren()
        update(target, true)
      }
    })
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) update(entry.target as HTMLElement, entry.isIntersecting)
      },
      { root, rootMargin: '160px' }
    )
    root
      .querySelectorAll<HTMLElement>('[data-slide-index]')
      .forEach((target) => observer.observe(target))
    return () => {
      cancelled = true
      observer.disconnect()
      resizeObserver.disconnect()
      targets.clear()
      for (const handle of handles.values()) handle.dispose()
      handles.clear()
    }
  }, [count, document, viewer])

  useEffect(() => {
    mounted.current = true
    viewport.current?.focus()
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    viewport.current
      ?.querySelector(`[data-testid="grid-slide-${focused}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const select = async (index: number): Promise<void> => {
    const outcome = await resolveMediaProjectionAction(
      useMediaProjectionStore.getState().jumpToSlide(index)
    )
    if (!mounted.current) return
    if (outcome.status === 'success') useMediaProjectionStore.setState({ showGrid: false })
    else if (outcome.status === 'blocked')
      toast.danger(t('presentationWorkspace.saveFailed', 'Unable to save presentation'))
  }

  return (
    <div className="fixed inset-0 z-10000 flex flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center border-b border-separator px-4 py-2">
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          onPress={toggleGrid}
          aria-label={t('common.close')}
        >
          <X size={18} />
        </Button>
        <span className="ml-2 truncate text-sm">{item.name}</span>
      </div>
      <div ref={viewerHost} className="hidden" aria-hidden="true" />
      <div
        ref={viewport}
        tabIndex={0}
        className="flex-1 overflow-y-auto p-6 outline-none"
        onKeyDown={(event) => {
          const columns =
            window.innerWidth >= 1024
              ? 6
              : window.innerWidth >= 768
                ? 4
                : window.innerWidth >= 640
                  ? 2
                  : 1
          const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[
            event.key
          ]
          if (delta !== undefined) {
            event.preventDefault()
            setFocused((value) => Math.max(0, Math.min(count - 1, value + delta)))
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (count) void select(focused)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            toggleGrid()
          }
        }}
      >
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : count === 0 ? (
          <Spinner />
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: count }, (_, index) => (
            <button
              key={document?.slideOrder[index] ?? index}
              type="button"
              data-testid={`grid-slide-${index}`}
              aria-label={`${item.name} · ${index + 1}`}
              aria-current={active === index ? 'page' : undefined}
              className={`relative aspect-video overflow-hidden rounded border-3 ${active === index ? 'border-accent' : focused === index ? 'border-accent/80' : 'border-transparent'}`}
              onFocus={() => setFocused(index)}
              onMouseEnter={() => setFocused(index)}
              onClick={() => void select(index)}
            >
              <div
                data-slide-index={index}
                className="pointer-events-none flex h-full w-full items-center justify-center overflow-hidden bg-white"
              >
                {document && visible.has(index) ? (
                  <EditableSlideSurface document={document} slideId={document.slideOrder[index]} />
                ) : null}
              </div>
              <span className="absolute bottom-1 right-1 rounded bg-background/80 px-1 text-xs">
                {index + 1}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
