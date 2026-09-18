import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceAround,
  BringToFront,
  FileText,
  ImagePlus,
  Plus,
  RectangleHorizontal,
  SendToBack,
  StickyNote,
  Type,
  ZoomIn,
  ZoomOut,
  X
} from 'lucide-react'
import { AlertDialog } from '@heroui/react/alert-dialog'
import { Button } from '@heroui/react/button'
import { Spinner } from '@heroui/react/spinner'
import { toast } from '@heroui/react/toast'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import EditableSlideSurface, {
  type TextEditFinalizer,
  type EditableTextSelection
} from '@renderer/components/Common/EditableSlideSurface'
import PresentationHomeRibbon from '@renderer/components/Control/Presentation/PresentationHomeRibbon'
import {
  InspectorPanel,
  NavigatorRail,
  ResponsivePanelGroup,
  StageViewport,
  WorkspaceShell
} from '@renderer/components/Common/WorkspacePrimitives'
import { useContextMenu } from '@renderer/contexts/ContextMenuContext'
import { useHhcAuth } from '@renderer/contexts/HhcAuthContext'
import {
  addElementToSlide,
  applySlideBackgroundToAllSlides,
  CONTENT_HEIGHT_TEXT_PADDING_Y,
  createImageElement,
  createLineElement,
  createShapeElement,
  createTextElement,
  createDefaultPresentationTheme,
  convertPptxToEditablePresentation,
  DEFAULT_GRADIENT_BACKGROUND,
  duplicateElementInSlide,
  getSlideBackgroundPrimaryColor,
  getSlideBackgroundOutline,
  INSERTED_TEXT_CLICK_SIZE,
  INSERTED_TEXT_DRAG_MIN_SIZE,
  INSERTED_TEXT_FONT_SIZE_POINTS,
  insertBlankEditableSlide,
  normalizeSlideBackground,
  presentationCanvasPxToPoints,
  presentationPointsToCanvasPx,
  removeElementFromSlide,
  removeEditableSlides,
  reorderElementInSlide,
  resetSlideBackground,
  updateElementInSlide,
  updateSlideBackground,
  updateSlideNotes,
  type EditableGradientDirection,
  type EditablePresentationDocument,
  type EditablePresentationElement,
  type EditableSlideBackground,
  type EditableTextInsertFrame,
  type EditableTextParagraph,
  type EditableTextStyle
} from '@renderer/lib/editable-presentation'
import {
  applyCharacterStyle,
  changeTextCase,
  clearCharacterFormatting,
  getCharacterStyleValue,
  mapSelectedParagraphs,
  normalizeTextParagraphs
} from '@renderer/lib/presentation-rich-text'
import type { HhcLineCloudAuth } from '@renderer/lib/cloud-provider'
import { prepareHhcLinePresentationSource } from '@renderer/lib/hhc-line-connect'
import { isMac } from '@renderer/lib/env'
import {
  alignElements,
  distributeElements,
  nudgeElements,
  reorderSelectedSlides,
  selectElementsInBounds,
  snapElementPosition,
  type ElementAlignment,
  type ElementDistribution
} from '@renderer/lib/presentation-editor-commands'
import { openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import {
  getDocumentFontFamilies,
  findUnavailablePresentationFonts,
  mergeFontFamilies,
  queryLocalFontFamiliesOnce,
  supportsLocalFontAccess
} from '@renderer/lib/local-fonts'
import { useSettingsStore } from '@renderer/stores/settings'
import { usePresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import type { PresentationEditorSession } from '@renderer/lib/presentation-editor-session'
import { ensurePresentationPageDocument } from '@renderer/lib/presentation-page-document'
import { calculateFitZoomPercent } from '@renderer/lib/presentation-viewport'
import {
  createSlideClipboard,
  cutSlides,
  pasteSlideClipboard,
  type PresentationSlideClipboard
} from '@renderer/lib/presentation-slide-clipboard'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import { readPresentationArrayBuffer } from '@renderer/lib/presentation-source'
import { openPptxViewer, type PptxViewerHandle } from '@renderer/lib/pptx-renderer-service'
import { getPresentationWorkspacePath, isPresentationItem } from '@renderer/lib/presentation-media'
import {
  usePresentationWorkspaceStore,
  type PresentationWorkspaceDocument
} from '@renderer/stores/presentation-workspace'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { isFileItem, type FileItemRecord } from '@shared/types/folder'
import type { SlideHandle } from '@aiden0z/pptx-renderer'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed'
type ZoomMode = 'fit' | 'custom'

const FONT_FAMILIES = ['Inter Variable', 'Noto Sans TC Variable', 'Noto Sans SC Variable', 'Arial']
const FONT_SIZES = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96
]
const PRESENTATION_CANVAS_WIDTH = 1024
const PRESENTATION_VIEWPORT_PADDING = 64
const NATIVE_CONTROL_CLASS =
  'presentation-native-control h-7 rounded-md border border-separator bg-surface-secondary px-2 text-sm text-foreground outline-none'
const RANGE_CLASS = 'presentation-range w-full'
const RIBBON_ICON_BUTTON_ACTIVE_CLASS =
  'border-accent bg-accent text-white shadow-inner hover:border-accent hover:bg-accent/90 hover:text-white'
const RIBBON_COMMAND_BUTTON_CLASS =
  'inline-flex h-14 min-w-12 flex-col items-center justify-center gap-1 rounded-md px-1 text-xs text-muted transition-colors hover:bg-surface-secondary/80 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/50 disabled:cursor-not-allowed disabled:opacity-30'

const flattenTextParagraphs = (
  paragraphs: EditableTextParagraph[]
): EditableTextParagraph['runs'] =>
  paragraphs.flatMap((paragraph, paragraphIndex) =>
    paragraph.runs.map((run, runIndex) => ({
      ...run,
      text: `${paragraphIndex > 0 && runIndex === 0 ? '\n' : ''}${run.text}`
    }))
  )

function RibbonGroup({
  label,
  children,
  className = ''
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section
      role="group"
      aria-label={label}
      data-testid="presentation-ribbon-group"
      className={`flex h-full shrink-0 flex-col border-r border-separator px-2 py-1 last:border-r-0 ${className}`}
    >
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}

function getPptxSlideId(index: number): string {
  return `pptx-slide-${index}`
}

function getPptxSlideIndex(slideId: string | null): number {
  if (!slideId?.startsWith('pptx-slide-')) return 0
  const index = Number(slideId.slice('pptx-slide-'.length))
  return Number.isInteger(index) && index >= 0 ? index : 0
}

function SlideThumbnail({
  viewer,
  index,
  active,
  onSelect
}: {
  viewer: PptxViewerHandle
  index: number
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(() => !('IntersectionObserver' in window))

  useEffect(() => {
    const container = containerRef.current
    if (!container || isVisible) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIsVisible(true)
        observer.disconnect()
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [isVisible])

  useEffect(() => {
    if (!isVisible || !containerRef.current) return
    const container = containerRef.current
    container.innerHTML = ''
    const handle: SlideHandle | null = viewer.viewer.renderThumbnailToContainer(index, container, {
      width: 144
    })
    return () => {
      handle?.dispose()
      container.innerHTML = ''
    }
  }, [index, isVisible, viewer])

  return (
    <button
      className="flex w-full gap-2 rounded-xl px-1 py-2 text-left text-muted transition-colors hover:bg-surface-secondary"
      onClick={onSelect}
    >
      <span
        className={
          active
            ? 'w-4 pt-1 text-right text-xs tabular-nums text-foreground'
            : 'w-4 pt-1 text-right text-xs tabular-nums'
        }
      >
        {index + 1}
      </span>
      <span
        ref={containerRef}
        className={`flex h-[81px] w-36 items-center justify-center overflow-hidden border bg-white shadow-sm ${
          active ? 'border-accent ring-2 ring-accent/40' : 'border-transparent'
        }`}
      />
    </button>
  )
}

const EditableSlideThumbnail = React.memo(
  function EditableSlideThumbnail({
    document,
    slideId
  }: {
    document: EditablePresentationDocument
    slideId: string
  }): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null)
    const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === 'undefined')

    useEffect(() => {
      const container = containerRef.current
      if (!container || isVisible) return
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setIsVisible(true)
            observer.disconnect()
          }
        },
        { rootMargin: '160px 0px' }
      )
      observer.observe(container)
      return () => observer.disconnect()
    }, [isVisible])

    return (
      <div ref={containerRef} className="h-full w-full">
        {isVisible && (
          <EditableSlideSurface
            document={document}
            slideId={slideId}
            className="pointer-events-none"
          />
        )}
      </div>
    )
  },
  (previous, next) =>
    previous.slideId === next.slideId &&
    previous.document.width === next.document.width &&
    previous.document.height === next.document.height &&
    previous.document.assets === next.document.assets &&
    previous.document.slides[previous.slideId] === next.document.slides[next.slideId]
)

async function getPresentationSourceItem(itemId: string): Promise<FileItemRecord> {
  const storeItem = useFileExplorerStore.getState().items[itemId]
  if (storeItem && isFileItem(storeItem)) return storeItem

  const db = await openFileExplorerDB()
  const record = await db.get('folder-items', itemId)
  if (record && isFileItem(record)) return record
  throw new Error('Presentation source is unavailable')
}

async function withPresentationSource<T>(
  auth: HhcLineCloudAuth,
  item: FileItemRecord,
  consumeSource: (sourceItem: FileItemRecord) => Promise<T>
): Promise<T> {
  const prepared = await prepareHhcLinePresentationSource(auth, item)
  try {
    return await consumeSource(prepared ? { ...item, url: prepared.source.url } : item)
  } finally {
    if (prepared?.source.kind === 'native-lease') {
      await window.api?.hhcAssets
        ?.releaseContentLease(prepared.source.leaseId)
        .catch(() => undefined)
    }
  }
}

export function PptxDocumentView({
  deck
}: {
  deck: PresentationWorkspaceDocument
}): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { session, getAccessToken, getAuthGeneration, refreshAfterUnauthorized, endSession } =
    useHhcAuth()
  const hhcAuth = useMemo<HhcLineCloudAuth>(
    () => ({
      getSession: () => session,
      getAuthGeneration,
      getAccessToken,
      refreshAfterUnauthorized,
      endSession
    }),
    [endSession, getAccessToken, getAuthGeneration, refreshAfterUnauthorized, session]
  )
  const openDocument = usePresentationWorkspaceStore((state) => state.openDocument)
  const setSlideCount = usePresentationWorkspaceStore((state) => state.setSlideCount)
  const setActiveSlideId = usePresentationWorkspaceStore((state) => state.setActiveSlideId)
  const activeSlideId = usePresentationWorkspaceStore((state) =>
    state.getActiveSlideId(deck.itemId)
  )
  const activeSlide = getPptxSlideIndex(activeSlideId)
  const deckItemId = deck.itemId
  const deckUrl = deck.url
  const canvasRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PptxViewerHandle | null>(null)
  const [viewer, setViewer] = useState<PptxViewerHandle | null>(null)
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isConverting, setIsConverting] = useState(false)

  useEffect(() => {
    let cancelled = false
    const target = canvasRef.current
    if (!target) return
    const container = target
    container.innerHTML = ''
    viewerRef.current?.destroy()
    viewerRef.current = null

    async function open(): Promise<void> {
      await Promise.resolve()
      if (cancelled) return
      setViewer(null)
      setStatus('loading')
      setError(null)
      try {
        const sourceItem = await getPresentationSourceItem(deckItemId)
        const buffer = await withPresentationSource(
          hhcAuth,
          sourceItem,
          readPresentationArrayBuffer
        )
        if (cancelled) return
        const handle = await openPptxViewer(buffer, container, { renderMode: 'slide' })
        if (cancelled) {
          handle.destroy()
          return
        }
        viewerRef.current = handle
        setViewer(handle)
        setSlideCount(deckItemId, handle.slideCount)
        const storedSlideId = usePresentationWorkspaceStore.getState().getActiveSlideId(deckItemId)
        const safeSlideIndex = Math.min(
          getPptxSlideIndex(storedSlideId),
          Math.max(0, handle.slideCount - 1)
        )
        setActiveSlideId(deckItemId, getPptxSlideId(safeSlideIndex))
        void ensurePresentationPageDocument(
          { id: deckItemId, url: deckUrl },
          handle.slideCount
        ).catch(() => undefined)
        setStatus('ready')
      } catch (loadError) {
        if (cancelled) return
        setStatus('failed')
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    }

    void open()
    return () => {
      cancelled = true
      viewerRef.current?.destroy()
      viewerRef.current = null
    }
  }, [deckItemId, deckUrl, hhcAuth, setActiveSlideId, setSlideCount])

  useEffect(() => {
    const current = viewerRef.current
    if (!current || status !== 'ready') return
    void current.viewer.renderSlide(activeSlide).catch((renderError) => {
      setStatus('failed')
      setError(renderError instanceof Error ? renderError.message : String(renderError))
    })
  }, [activeSlide, status])

  const slideIndexes = useMemo(
    () => Array.from({ length: viewer?.slideCount ?? deck.slideCount ?? 0 }, (_, index) => index),
    [deck.slideCount, viewer?.slideCount]
  )

  const editCopy = async (): Promise<void> => {
    if (isConverting) return
    setIsConverting(true)
    try {
      const item = await getPresentationSourceItem(deck.itemId)
      const createdItem = await withPresentationSource(
        hhcAuth,
        item,
        convertPptxToEditablePresentation
      )
      openDocument(createdItem)
      navigate(getPresentationWorkspacePath(createdItem.id))
    } catch (conversionError) {
      toast.danger(
        conversionError instanceof Error ? conversionError.message : String(conversionError)
      )
    } finally {
      setIsConverting(false)
    }
  }

  return (
    <ResponsivePanelGroup
      navigatorWidth={220}
      navigatorLabel={t('presentationWorkspace.slides', 'Slides')}
      className="bg-background"
      navigator={
        <NavigatorRail className="h-full overflow-y-auto border-r border-separator bg-surface/40 px-2 py-3">
          <div className="space-y-2">
            {viewer &&
              slideIndexes.map((index) => (
                <SlideThumbnail
                  key={index}
                  viewer={viewer}
                  index={index}
                  active={index === activeSlide}
                  onSelect={() => setActiveSlideId(deck.itemId, getPptxSlideId(index))}
                />
              ))}
          </div>
        </NavigatorRail>
      }
      stage={
        <StageViewport className="h-full bg-[#111217]">
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-separator bg-surface/80 px-4">
            <div>
              <p className="text-sm font-semibold text-foreground">{deck.name}</p>
              <p className="text-xs text-default-400">
                {t('presentationWorkspace.readOnlyPptx', 'Read-only PPTX')}
              </p>
            </div>
            <Button variant="primary" isDisabled={isConverting} onPress={() => void editCopy()}>
              {isConverting
                ? t('presentationWorkspace.editCopyConverting', 'Creating copy...')
                : t('presentationWorkspace.editCopy', 'Edit a copy')}
            </Button>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-auto p-8">
            <div className="relative flex min-h-[360px] w-full max-w-5xl items-center justify-center rounded-2xl bg-black/30 p-4 shadow-2xl">
              <div ref={canvasRef} className="w-full" data-pptx-slide-surface />
              {status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/40">
                  <Spinner />
                </div>
              )}
              {status === 'failed' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-black/70 p-6 text-center">
                  <FileText className="mb-3 text-danger" size={36} />
                  <p className="text-sm font-semibold text-danger">
                    {t('presentationWorkspace.loadFailed')}
                  </p>
                  {error && <p className="mt-2 max-w-lg text-xs text-default-400">{error}</p>}
                </div>
              )}
            </div>
          </div>
        </StageViewport>
      }
    />
  )
}

function EditableDocumentView({
  deck,
  isBackgroundPanelOpen,
  onBackgroundPanelOpenChange,
  slideClipboard,
  onSlideClipboardChange
}: {
  deck: PresentationWorkspaceDocument
  isBackgroundPanelOpen: boolean
  onBackgroundPanelOpenChange: (open: boolean) => void
  slideClipboard: PresentationSlideClipboard | null
  onSlideClipboardChange: (clipboard: PresentationSlideClipboard) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const registry = usePresentationSessionRegistry()
  const session = useSyncExternalStore(
    registry.subscribe,
    () => registry.get(deck.itemId),
    () => registry.get(deck.itemId)
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (session) return
    let cancelled = false
    void getPresentationSourceItem(deck.itemId)
      .then((item) => registry.open(item))
      .catch((openError) => {
        if (!cancelled) {
          setError(openError instanceof Error ? openError.message : String(openError))
        }
      })
    return () => {
      cancelled = true
    }
  }, [deck.itemId, registry, session])

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <FileText className="text-danger" size={36} />
        <p className="text-sm font-semibold text-danger">{t('presentationWorkspace.loadFailed')}</p>
        <p className="max-w-lg text-xs text-default-400">{error}</p>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <EditableSessionDocumentView
      key={deck.itemId}
      deck={deck}
      session={session}
      isBackgroundPanelOpen={isBackgroundPanelOpen}
      onBackgroundPanelOpenChange={onBackgroundPanelOpenChange}
      slideClipboard={slideClipboard}
      onSlideClipboardChange={onSlideClipboardChange}
    />
  )
}

function EditableSessionDocumentView({
  deck,
  session,
  isBackgroundPanelOpen,
  onBackgroundPanelOpenChange,
  slideClipboard,
  onSlideClipboardChange
}: {
  deck: PresentationWorkspaceDocument
  session: PresentationEditorSession
  isBackgroundPanelOpen: boolean
  onBackgroundPanelOpenChange: (open: boolean) => void
  slideClipboard: PresentationSlideClipboard | null
  onSlideClipboardChange: (clipboard: PresentationSlideClipboard) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { showMenu } = useContextMenu()
  const registry = usePresentationSessionRegistry()
  const setSlideCount = usePresentationWorkspaceStore((state) => state.setSlideCount)
  const setActiveSlideId = usePresentationWorkspaceStore((state) => state.setActiveSlideId)
  const storedActiveSlideId = usePresentationWorkspaceStore((state) =>
    state.getActiveSlideId(deck.itemId)
  )
  const sessionSnapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  )
  const document = sessionSnapshot.renderedDocument
  const storedActiveSlideIndex = document.slideOrder.indexOf(storedActiveSlideId ?? '')
  const [lastActiveSlideIndex, setLastActiveSlideIndex] = useState(() =>
    Math.max(0, storedActiveSlideIndex)
  )
  const activeSlideIndex =
    storedActiveSlideIndex >= 0
      ? storedActiveSlideIndex
      : Math.min(lastActiveSlideIndex, Math.max(0, document.slideOrder.length - 1))
  const activeSlideId = document.slideOrder[activeSlideIndex] ?? null
  const imageInputRef = useRef<HTMLInputElement>(null)
  const canvasViewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const textDraftStartedAtRef = useRef<number | null>(null)
  const textCommitTimerRef = useRef<number | null>(null)
  const textEditorFinalizerRef = useRef<TextEditFinalizer | null>(null)
  const pendingZoomAnchorRef = useRef<{
    clientX: number
    clientY: number
    logicalX: number
    logicalY: number
    nextZoom: number
  } | null>(null)
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const newEmptyTextRef = useRef<string | null>(null)
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(() => new Set())
  const [copiedElement, setCopiedElement] = useState<EditablePresentationElement | null>(null)
  const [selectedSlideIds, setSelectedSlideIds] = useState<Set<string>>(() => new Set())
  const [selectionAnchorIndex, setSelectionAnchorIndex] = useState(0)
  const [insertionIndex, setInsertionIndex] = useState<number | null>(null)
  const [isLineSpacingOptionsOpen, setIsLineSpacingOptionsOpen] = useState(false)
  const [lineSpacingDraft, setLineSpacingDraft] = useState(1.15)
  const [editingElementId, setEditingElementId] = useState<string | null>(null)
  const [textSelection, setTextSelection] = useState<EditableTextSelection | null>(null)
  const [isTextInsertMode, setIsTextInsertMode] = useState(false)
  const [localFontFamilies, setLocalFontFamilies] = useState<string[]>([])
  const [localFontStatus, setLocalFontStatus] = useState<
    'idle' | 'loading' | 'ready' | 'failed' | 'unsupported'
  >('idle')
  const recentFonts = useSettingsStore((state) => state.recentPresentationFonts)
  const rememberFont = useSettingsStore((state) => state.rememberPresentationFont)
  const hasRequestedLocalFontsRef = useRef(false)
  const [draggingSlideIds, setDraggingSlideIds] = useState<string[]>([])
  const [railWidth, setRailWidth] = useState(240)
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit')
  const [customZoomPercent, setZoomPercent] = useState(100)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const zoomPercent =
    zoomMode === 'fit' && viewportSize.width > 0 && viewportSize.height > 0
      ? calculateFitZoomPercent(
          viewportSize.width,
          viewportSize.height,
          PRESENTATION_CANVAS_WIDTH,
          (PRESENTATION_CANVAS_WIDTH * document.height) / document.width,
          PRESENTATION_VIEWPORT_PADDING
        )
      : customZoomPercent
  const [isNotesOpen, setIsNotesOpen] = useState(false)
  const [compactOverlay, setCompactOverlay] = useState<'navigator' | 'inspector' | null>(null)
  const formatBackgroundTriggerRef = useRef<HTMLElement>(null)
  const [snapGuides, setSnapGuides] = useState<{
    vertical?: number
    horizontal?: number
  }>({})

  const finalizeTextEditor = useCallback(
    (): boolean => textEditorFinalizerRef.current?.() ?? true,
    []
  )
  const setTextEditorFinalizer = useCallback(
    (finalize: TextEditFinalizer | null): void => {
      textEditorFinalizerRef.current = finalize
      registry.notifyEditorLifecycle?.(deck.itemId)
    },
    [deck.itemId, registry]
  )

  useEffect(
    () =>
      registry.registerEditorFinalizer?.(
        deck.itemId,
        finalizeTextEditor,
        () => textEditorFinalizerRef.current?.hasUnsafeWork?.() ?? false,
        () => textEditorFinalizerRef.current !== null,
        () => textEditorFinalizerRef.current?.isComposing?.() ?? false
      ),
    [deck.itemId, finalizeTextEditor, registry]
  )
  const projectionPlaylist = useMediaProjectionStore((state) => state.playlist)
  const projectionIndex = useMediaProjectionStore((state) => state.currentIndex)
  const isPresenting = useMediaProjectionStore((state) => state.isPresenting)
  const projectedPresentationState = useMediaProjectionStore(
    (state) => state.typeStates.presentation
  )

  const closeBackgroundPanel = (): void => {
    onBackgroundPanelOpenChange(false)
    setCompactOverlay(null)
    queueMicrotask(() => formatBackgroundTriggerRef.current?.focus())
  }

  useEffect(
    () => () => {
      if (textCommitTimerRef.current !== null) {
        window.clearTimeout(textCommitTimerRef.current)
      }
    },
    []
  )

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

  useEffect(() => {
    setSlideCount(deck.itemId, document.slideOrder.length)
    if (activeSlideId !== storedActiveSlideId) {
      setActiveSlideId(deck.itemId, activeSlideId)
    }
  }, [
    activeSlideId,
    activeSlideIndex,
    deck.itemId,
    document.slideOrder.length,
    setActiveSlideId,
    setSlideCount,
    storedActiveSlideId
  ])

  const activateSlide = (slideId: string | null): boolean => {
    if (!finalizeTextEditor()) return false
    commitNotes()
    if (slideId) {
      const index = document.slideOrder.indexOf(slideId)
      if (index >= 0) setLastActiveSlideIndex(index)
    }
    setActiveSlideId(deck.itemId, slideId)
    return true
  }

  const activeSlide = activeSlideId ? document.slides[activeSlideId] : null
  const selectedElement =
    activeSlide && selectedElementId ? activeSlide.elements[selectedElementId] : null
  const projectedItem = projectionPlaylist[projectionIndex]
  const projectedSlideIndex =
    isPresenting && projectedItem?.id === deck.itemId
      ? (projectedPresentationState?.slideIndex ?? 0)
      : -1

  const notesDraft = activeSlide?.notes ?? ''

  useEffect(
    () => () => {
      if (session.getSnapshot().draftKind === 'notes') session.commitDraft()
    },
    [session]
  )

  const onTextLayoutChange = useCallback<
    NonNullable<React.ComponentProps<typeof EditableSlideSurface>['onTextLayoutChange']>
  >((slideId, elementId, size) => session.reflowText(slideId, elementId, size), [session])

  const clearTextCommitTimer = useCallback((resetDeadline = true): void => {
    if (resetDeadline) textDraftStartedAtRef.current = null
    if (textCommitTimerRef.current === null) return
    window.clearTimeout(textCommitTimerRef.current)
    textCommitTimerRef.current = null
  }, [])

  const commitTextDraft = (): void => {
    clearTextCommitTimer()
    if (newEmptyTextRef.current) return
    if (session.getSnapshot().draftKind === 'text') session.commitDraft()
  }

  const finalizeDocumentMutation = (): EditablePresentationDocument | null => {
    if (!finalizeTextEditor()) return null
    clearTextCommitTimer()
    return session.getSnapshot().renderedDocument
  }

  const commitDocument = (
    update: (currentDocument: EditablePresentationDocument) => EditablePresentationDocument
  ): boolean => {
    const currentDocument = finalizeDocumentMutation()
    if (!currentDocument) return false
    session.commit(update(currentDocument))
    return true
  }

  function commitNotes(): void {
    if (session.getSnapshot().draftKind === 'notes') session.commitDraft()
  }

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

  const previewTextElement = useCallback(
    (slideId: string, elementId: string, updates: Partial<EditablePresentationElement>): void => {
      const preview = session.getSnapshot().renderedDocument
      if (
        newEmptyTextRef.current === elementId &&
        'text' in updates &&
        updates.text?.replace(/[\u200b\ufeff]/g, '').trim()
      ) {
        newEmptyTextRef.current = null
      }
      const current = preview.slides[slideId]?.elements[elementId]
      if (
        current &&
        Object.entries(updates).every(
          ([key, value]) => current[key as keyof typeof current] === value
        )
      ) {
        return
      }
      textDraftStartedAtRef.current ??= Date.now()
      if (session.getSnapshot().draftKind !== 'text') session.beginDraft('text')
      session.previewDraft(updateElementInSlide(preview, slideId, elementId, updates))
      clearTextCommitTimer(false)
      if (newEmptyTextRef.current === elementId) return
      if (
        Date.now() - (textDraftStartedAtRef.current ?? Date.now()) >= 4000 &&
        !textEditorFinalizerRef.current?.isComposing?.()
      ) {
        session.commitDraft()
        textDraftStartedAtRef.current = null
        return
      }
      textCommitTimerRef.current = window.setTimeout(function commitWhenReady() {
        textCommitTimerRef.current = null
        if (textEditorFinalizerRef.current?.isComposing?.()) {
          textCommitTimerRef.current = window.setTimeout(commitWhenReady, 750)
          return
        }
        textDraftStartedAtRef.current = null
        if (session.getSnapshot().draftKind === 'text') session.commitDraft()
      }, 750)
    },
    [session, clearTextCommitTimer]
  )

  const selectElement = (
    elementId: string | null,
    event?: React.MouseEvent | React.PointerEvent
  ): void => {
    if (!elementId) {
      setSelectedElementId(null)
      setSelectedElementIds(new Set())
      return
    }
    const additive = Boolean(event?.metaKey || event?.ctrlKey)
    if (!additive) {
      setSelectedElementId(elementId)
      setSelectedElementIds(new Set([elementId]))
    } else {
      setSelectedElementIds((current) => {
        const next = new Set(current)
        if (next.has(elementId)) {
          next.delete(elementId)
        } else {
          next.add(elementId)
        }
        setSelectedElementId(next.has(elementId) ? elementId : (next.values().next().value ?? null))
        return next
      })
    }
    if (elementId !== editingElementId) setEditingElementId(null)
    setIsTextInsertMode(false)
  }

  const addShape = (shape: 'rectangle' | 'ellipse'): void => {
    if (!activeSlideId) return
    const element = createShapeElement(shape)
    if (!commitDocument((current) => addElementToSlide(current, activeSlideId, element))) return
    setSelectedElementId(element.id)
    setSelectedElementIds(new Set([element.id]))
  }

  const addLine = (): void => {
    if (!activeSlideId) return
    const element = createLineElement()
    if (!commitDocument((current) => addElementToSlide(current, activeSlideId, element))) return
    setSelectedElementId(element.id)
    setSelectedElementIds(new Set([element.id]))
  }

  const applyElementAlignment = (alignment: ElementAlignment): void => {
    if (!activeSlideId) return
    const ids = [...selectedElementIds]
    if (ids.length < 2) return
    commitDocument((current) => alignElements(current, activeSlideId, ids, alignment))
  }

  const applyElementDistribution = (distribution: ElementDistribution): void => {
    if (!activeSlideId) return
    const ids = [...selectedElementIds]
    if (ids.length < 3) return
    commitDocument((current) => distributeElements(current, activeSlideId, ids, distribution))
  }

  const moveSelectedSlides = (targetIndex: number): void => {
    const ids = draggingSlideIds.length > 0 ? draggingSlideIds : getSelectedSlideIds()
    commitDocument((current) => reorderSelectedSlides(current, ids, targetIndex))
    setDraggingSlideIds([])
    setInsertionIndex(null)
  }

  const setActiveSlideBackground = (background: EditableSlideBackground): void => {
    if (!document || !activeSlideId) return
    commitDocument((current) => updateSlideBackground(current, activeSlideId, background))
  }

  const applyActiveBackgroundToAllSlides = (): void => {
    if (!document || !activeSlide) return
    commitDocument((current) =>
      applySlideBackgroundToAllSlides(
        current,
        current.slides[activeSlideId]?.background ?? activeSlide.background
      )
    )
  }

  const resetActiveSlideBackground = (): void => {
    if (!document || !activeSlideId) return
    commitDocument((current) => resetSlideBackground(current, activeSlideId))
  }

  const addTextElement = (frame?: EditableTextInsertFrame): void => {
    if (!document || !activeSlideId) return
    const autoSize = frame?.autoSize ?? 'content'
    const autoWidth = frame?.autoWidth ?? true
    const nextFrame = frame ?? {
      x: 260,
      y: 220,
      width: INSERTED_TEXT_CLICK_SIZE.width,
      height: INSERTED_TEXT_CLICK_SIZE.height,
      autoSize,
      autoWidth
    }
    const width =
      autoSize === 'content'
        ? nextFrame.width
        : Math.max(INSERTED_TEXT_DRAG_MIN_SIZE.width, nextFrame.width)
    const height =
      autoSize === 'content'
        ? nextFrame.height
        : Math.max(INSERTED_TEXT_DRAG_MIN_SIZE.height, nextFrame.height)
    const currentDocument = finalizeDocumentMutation()
    if (!currentDocument) return
    const fontSize = presentationPointsToCanvasPx(
      INSERTED_TEXT_FONT_SIZE_POINTS,
      currentDocument.width
    )
    const textHeight = Math.max(
      height,
      Math.ceil(fontSize * 1.15) + CONTENT_HEIGHT_TEXT_PADDING_Y * 2
    )
    const element = createTextElement({
      x: Math.max(0, Math.min(currentDocument.width - width, nextFrame.x)),
      y: Math.max(0, Math.min(currentDocument.height - textHeight, nextFrame.y)),
      width,
      height: textHeight,
      autoWidth: nextFrame.autoWidth,
      autoSize,
      fontSize,
      text: ''
    })
    newEmptyTextRef.current = element.id
    session.beginDraft('text')
    session.previewDraft(addElementToSlide(currentDocument, activeSlideId, element))
    setSelectedElementId(element.id)
    setSelectedElementIds(new Set([element.id]))
    setEditingElementId(element.id)
    setIsTextInsertMode(false)
  }

  const addSlide = (): void => {
    if (!document) return
    const currentDocument = finalizeDocumentMutation()
    if (!currentDocument) return
    const result = insertBlankEditableSlide(currentDocument, currentDocument.slideOrder.length)
    session.commit(result.document)
    activateSlide(result.slideId)
    setSelectedSlideIds(new Set([result.slideId]))
    setSelectedElementId(null)
    setSelectedElementIds(new Set())
  }

  const addSlideAfter = (index: number): void => {
    if (!document) return
    const currentDocument = finalizeDocumentMutation()
    if (!currentDocument) return
    const result = insertBlankEditableSlide(currentDocument, index + 1)
    session.commit(result.document)
    activateSlide(result.slideId)
    setSelectedSlideIds(new Set([result.slideId]))
    setSelectionAnchorIndex(index + 1)
    setSelectedElementId(null)
    setSelectedElementIds(new Set())
    setInsertionIndex(null)
  }

  const selectSlide = (index: number, event: React.MouseEvent | React.KeyboardEvent): void => {
    const slideId = document.slideOrder[index]
    if (!slideId) return
    if (!finalizeTextEditor()) return
    commitTextDraft()

    if (event.shiftKey) {
      const start = Math.min(selectionAnchorIndex, index)
      const end = Math.max(selectionAnchorIndex, index)
      setSelectedSlideIds(new Set(document.slideOrder.slice(start, end + 1)))
      setSelectedElementId(null)
      setSelectedElementIds(new Set())
      setEditingElementId(null)
      setIsTextInsertMode(false)
      setInsertionIndex(null)
      return
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedSlideIds((current) => {
        const next = new Set(current)
        if (next.has(slideId)) {
          next.delete(slideId)
        } else {
          next.add(slideId)
        }
        if (next.size === 0) next.add(slideId)
        return next
      })
      setSelectedElementId(null)
      setSelectedElementIds(new Set())
      setEditingElementId(null)
      setIsTextInsertMode(false)
      setInsertionIndex(null)
      return
    } else {
      setSelectedSlideIds(new Set([slideId]))
      setSelectionAnchorIndex(index)
    }

    activateSlide(slideId)
    setSelectedElementId(null)
    setSelectedElementIds(new Set())
    setIsTextInsertMode(false)
    setInsertionIndex(null)
  }

  const showSlideSidebarMenu = (event: React.MouseEvent): void => {
    const target = event.target as HTMLElement
    const item = target.closest<HTMLElement>('[data-slide-option]')
    const divider = target.closest<HTMLElement>('[data-slide-divider]')
    const itemIndex = item ? Number(item.dataset.slideIndex) : null
    const dividerIndex = divider ? Number(divider.dataset.slideIndex) : null
    let contextSlideIds: string[] = []
    if (itemIndex !== null && Number.isFinite(itemIndex)) {
      const slideId = document.slideOrder[itemIndex]
      if (slideId) {
        contextSlideIds = selectedSlideIds.has(slideId) ? getSelectedSlideIds() : [slideId]
        if (!selectedSlideIds.has(slideId)) selectSlide(itemIndex, event)
      }
    }
    const itemCommands =
      itemIndex === null
        ? []
        : [
            {
              id: 'copy-slide',
              label: t('common.copy', 'Copy'),
              onAction: () => copySelectedSlides(contextSlideIds)
            },
            {
              id: 'cut-slide',
              label: t('common.cut', 'Cut'),
              onAction: () => cutSelectedSlides(contextSlideIds)
            },
            {
              id: 'delete-slide',
              label: t('common.delete', 'Delete'),
              variant: 'danger' as const,
              disabled: contextSlideIds.length >= document.slideOrder.length,
              onAction: () => deleteSlide(contextSlideIds)
            }
          ]
    showMenu(
      [
        {
          id: 'new-slide',
          label: t('presentationWorkspace.newSlide'),
          icon: <Plus size={16} />,
          onAction: () =>
            dividerIndex === null ? addSlide() : addSlideAfter(Math.max(-1, dividerIndex - 1))
        },
        'separator',
        ...itemCommands,
        {
          id: 'paste-slide',
          label: t('common.paste', 'Paste'),
          disabled: !slideClipboard,
          onAction: () =>
            pasteSlide(dividerIndex ?? (itemIndex === null ? undefined : itemIndex + 1))
        }
      ],
      event
    )
  }

  const getSelectedSlideIds = (): string[] => {
    if (!document) return []
    const selected = document.slideOrder.filter((slideId) => selectedSlideIds.has(slideId))
    if (selected.length > 0) return selected
    return activeSlideId ? [activeSlideId] : []
  }

  const pasteSlide = (requestedIndex?: number): void => {
    if (!slideClipboard || !document) return
    const currentDocument = finalizeDocumentMutation()
    if (!currentDocument) return
    const targetIndex =
      requestedIndex ??
      insertionIndex ??
      currentDocument.slideOrder.indexOf(activeSlideId ?? '') + 1
    const result = pasteSlideClipboard(currentDocument, slideClipboard, targetIndex)
    if (result.slideIds.length === 0) return
    session.commit(result.document)
    setSelectedSlideIds(new Set(result.slideIds))
    activateSlide(result.slideIds[0])
    setInsertionIndex(null)
    setSelectedElementId(null)
    setSelectedElementIds(new Set())
  }

  const copySelectedSlides = (requestedSlideIds?: string[]): void => {
    const slideIds = requestedSlideIds ?? getSelectedSlideIds()
    if (slideIds.length === 0) return
    const current = finalizeDocumentMutation()
    if (!current) return
    onSlideClipboardChange(createSlideClipboard(current, slideIds))
    setCopiedElement(null)
  }

  const cutSelectedSlides = (requestedSlideIds?: string[]): void => {
    const slideIds = requestedSlideIds ?? getSelectedSlideIds()
    if (slideIds.length === 0) return
    const current = finalizeDocumentMutation()
    if (!current) return
    onSlideClipboardChange(createSlideClipboard(current, slideIds))
    const nextDocument = cutSlides(current, slideIds)
    session.commit(nextDocument)
    const nextSlideId =
      nextDocument.slideOrder[Math.min(activeSlideIndex, nextDocument.slideOrder.length - 1)]
    activateSlide(nextSlideId)
    setSelectedSlideIds(new Set(nextSlideId ? [nextSlideId] : []))
    setCopiedElement(null)
  }

  const deleteSlide = (slideIds = getSelectedSlideIds()): void => {
    if (!document || document.slideOrder.length <= 1) return
    if (!finalizeTextEditor()) return
    const currentDocument = session.getSnapshot().renderedDocument
    const removingIds = currentDocument.slideOrder.filter((slideId) => slideIds.includes(slideId))
    if (removingIds.length === 0 && activeSlideId) removingIds.push(activeSlideId)
    if (removingIds.length === 0 || removingIds.length >= currentDocument.slideOrder.length) return
    const nextDocument = removeEditableSlides(currentDocument, removingIds)
    const nextIndex = Math.min(activeSlideIndex, Math.max(0, nextDocument.slideOrder.length - 1))
    const nextSlideId = nextDocument.slideOrder[nextIndex]
    session.commit(nextDocument)
    activateSlide(nextSlideId ?? null)
    setSelectedSlideIds(nextSlideId ? new Set([nextSlideId]) : new Set())
    setSelectedElementId(null)
    setSelectedElementIds(new Set())
    setInsertionIndex(null)
  }

  const deleteElement = (): void => {
    if (!document || !activeSlideId || selectedElementIds.size === 0) return
    if (!finalizeTextEditor()) return
    const nextDocument = [...selectedElementIds].reduce(
      (current, elementId) => removeElementFromSlide(current, activeSlideId, elementId),
      session.getSnapshot().renderedDocument
    )
    session.commit(nextDocument)
    setSelectedElementId(null)
    setSelectedElementIds(new Set())
  }

  const pasteElement = (): void => {
    if (!copiedElement || !document || !activeSlideId) return
    const element = {
      ...copiedElement,
      id: crypto.randomUUID(),
      x: copiedElement.x + 24,
      y: copiedElement.y + 24
    } as EditablePresentationElement
    if (!commitDocument((current) => addElementToSlide(current, activeSlideId, element))) return
    setSelectedElementId(element.id)
    setSelectedElementIds(new Set([element.id]))
  }

  const duplicateSelectedElement = (): void => {
    if (!activeSlideId || !selectedElementId) return
    const currentDocument = finalizeDocumentMutation()
    if (!currentDocument) return
    const result = duplicateElementInSlide(currentDocument, activeSlideId, selectedElementId)
    if (result.document === currentDocument) return
    session.commit(result.document)
    setSelectedElementId(result.elementId)
    setSelectedElementIds(new Set([result.elementId]))
  }

  const reorderElement = (
    elementId: string,
    action: 'bring-forward' | 'bring-to-front' | 'send-backward' | 'send-to-back'
  ): void => {
    if (!document || !activeSlideId) return
    commitDocument((current) => reorderElementInSlide(current, activeSlideId, elementId, action))
  }

  const showElementContextMenu = (
    event: React.MouseEvent,
    element: EditablePresentationElement
  ): void => {
    if (!selectedElementIds.has(element.id)) {
      setSelectedElementId(element.id)
      setSelectedElementIds(new Set([element.id]))
    }
    showMenu(
      [
        {
          id: 'bring-to-front',
          label: t('presentationWorkspace.bringToFront', 'Bring to Front'),
          onAction: () => reorderElement(element.id, 'bring-to-front')
        },
        {
          id: 'bring-forward',
          label: t('presentationWorkspace.bringForward', 'Bring Forward'),
          onAction: () => reorderElement(element.id, 'bring-forward')
        },
        'separator',
        {
          id: 'send-backward',
          label: t('presentationWorkspace.sendBackward', 'Send Backward'),
          onAction: () => reorderElement(element.id, 'send-backward')
        },
        {
          id: 'send-to-back',
          label: t('presentationWorkspace.sendToBack', 'Send to Back'),
          onAction: () => reorderElement(element.id, 'send-to-back')
        }
      ],
      event
    )
  }

  const showCanvasContextMenu = (event: React.MouseEvent): void => {
    const surface = event.currentTarget as HTMLElement
    surface.focus({ preventScroll: true })
    formatBackgroundTriggerRef.current = surface
    showMenu(
      [
        {
          id: 'format-background',
          label: t('presentationWorkspace.formatBackground', 'Format Background'),
          onAction: () => {
            onBackgroundPanelOpenChange(true)
            setCompactOverlay('inspector')
          }
        }
      ],
      event
    )
  }

  const addImage = async (file: File): Promise<void> => {
    if (!document || !activeSlideId) return
    const targetSlideId = activeSlideId
    const { dataUrl, width, height } = await readImageFile(file)
    if (registry.get(deck.itemId) !== session) return
    const currentDocument = finalizeDocumentMutation()
    if (!currentDocument || !currentDocument.slides[targetSlideId]) return
    const assetId = crypto.randomUUID()
    const nextDocument: EditablePresentationDocument = {
      ...currentDocument,
      assets: {
        ...currentDocument.assets,
        [assetId]: {
          id: assetId,
          name: file.name,
          mimeType: file.type || 'image/*',
          dataUrl
        }
      }
    }
    const element = createImageElement({
      assetId,
      slideWidth: currentDocument.width,
      slideHeight: currentDocument.height,
      sourceWidth: width,
      sourceHeight: height
    })
    session.commit(addElementToSlide(nextDocument, targetSlideId, element))
    setSelectedElementId(element.id)
    setSelectedElementIds(new Set([element.id]))
    setIsTextInsertMode(false)
  }

  const selectedTextElement = selectedElement?.type === 'text' ? selectedElement : null
  const documentFonts = useMemo(() => getDocumentFontFamilies(document), [document])
  const [unavailableFonts, setUnavailableFonts] = useState<string[]>([])
  const fontKey = documentFonts.join('\0')
  useEffect(() => {
    if (!deck.personalOwnerId) return
    let active = true
    void findUnavailablePresentationFonts(fontKey ? fontKey.split('\0') : [])
      .then((fonts) => {
        if (active) setUnavailableFonts(fonts)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [deck.personalOwnerId, fontKey])
  const fontFamilies = useMemo(
    () => mergeFontFamilies(recentFonts, documentFonts, FONT_FAMILIES, localFontFamilies),
    [recentFonts, documentFonts, localFontFamilies]
  )

  const updateSelectedTextElement = (
    change:
      | Partial<Extract<EditablePresentationElement, { type: 'text' }>>
      | ((
          element: Extract<EditablePresentationElement, { type: 'text' }>
        ) => Partial<Extract<EditablePresentationElement, { type: 'text' }>>)
  ): void => {
    if (!activeSlideId || !selectedElementId) return
    if (textEditorFinalizerRef.current?.flush?.() === false) return
    commitTextDraft()
    const current = session.getSnapshot().renderedDocument
    const element = current.slides[activeSlideId]?.elements[selectedElementId]
    if (element?.type !== 'text') return
    let updates = typeof change === 'function' ? change(element) : change
    if (!updates.paragraphs) {
      const characterPatch = Object.fromEntries(
        (
          [
            'fontFamily',
            'fontSize',
            'bold',
            'italic',
            'underline',
            'strikethrough',
            'baseline',
            'characterSpacing',
            'color',
            'highlightColor'
          ] as const
        ).flatMap((key) => (updates[key] === undefined ? [] : [[key, updates[key]]]))
      ) as Partial<EditableTextStyle>
      let paragraphs = normalizeTextParagraphs(element)
      if (Object.keys(characterPatch).length > 0) {
        paragraphs = applyCharacterStyle(paragraphs, 0, element.text.length, characterPatch)
      }
      if (updates.align !== undefined || updates.lineHeight !== undefined) {
        paragraphs = paragraphs.map((paragraph) => ({
          ...paragraph,
          align: updates.align ?? paragraph.align,
          lineSpacing:
            updates.lineHeight === undefined
              ? paragraph.lineSpacing
              : { kind: 'multiple', value: updates.lineHeight }
        }))
      }
      updates = {
        ...updates,
        paragraphs,
        runs: paragraphs.flatMap((paragraph, paragraphIndex) =>
          paragraph.runs.map((run, runIndex) => ({
            ...run,
            text: `${paragraphIndex > 0 && runIndex === 0 ? '\n' : ''}${run.text}`
          }))
        )
      }
    }
    const next = updateElementInSlide(current, activeSlideId, element.id, updates)
    if (newEmptyTextRef.current === element.id) session.previewDraft(next)
    else session.commit(next)
  }

  const finishFormatting = (): void => {
    window.requestAnimationFrame(() => {
      const focused = window.document.activeElement
      if (focused?.closest('[data-ribbon-surface], [data-presentation-text-tool]')) {
        textEditorFinalizerRef.current?.restoreSelection?.()
      }
    })
  }

  const getTextCommandRange = (
    element: Extract<EditablePresentationElement, { type: 'text' }>
  ): { start: number; end: number } => {
    const selection = textEditorFinalizerRef.current?.getSelection?.() ?? textSelection
    return selection?.elementId === element.id ? selection : { start: 0, end: element.text.length }
  }

  const patchCharacterStyle = (patch: Partial<EditableTextStyle>): void => {
    updateSelectedTextElement((element) => {
      const range = getTextCommandRange(element)
      const paragraphs = applyCharacterStyle(
        normalizeTextParagraphs(element),
        range.start,
        range.end,
        patch
      )
      return {
        ...patch,
        paragraphs,
        runs: flattenTextParagraphs(paragraphs)
      }
    })
  }
  const patchParagraphs = (
    update: (paragraph: EditableTextParagraph) => EditableTextParagraph
  ): void => {
    updateSelectedTextElement((element) => {
      const range = getTextCommandRange(element)
      const paragraphs = mapSelectedParagraphs(
        normalizeTextParagraphs(element),
        range.start,
        range.end,
        update
      )
      return {
        paragraphs,
        runs: flattenTextParagraphs(paragraphs),
        align: paragraphs[0]?.align ?? element.align,
        lineHeight:
          paragraphs[0]?.lineSpacing.kind === 'multiple'
            ? paragraphs[0].lineSpacing.value
            : element.lineHeight
      }
    })
  }

  const toggleCharacterStyle = (key: 'bold' | 'italic' | 'underline'): void => {
    if (!selectedTextElement) return
    const range = getTextCommandRange(selectedTextElement)
    const value = getCharacterStyleValue(
      normalizeTextParagraphs(selectedTextElement),
      range.start,
      range.end,
      key
    )
    patchCharacterStyle({ [key]: value !== true })
  }

  const changeSelectedTextIndent = (direction: -1 | 1): void => {
    patchParagraphs((paragraph) => ({
      ...paragraph,
      marginLeft: Math.max(0, paragraph.marginLeft + direction * 32),
      list: paragraph.list
        ? { ...paragraph.list, level: Math.max(0, paragraph.list.level + direction) }
        : null
    }))
  }

  const loadLocalFonts = async (): Promise<void> => {
    if (!supportsLocalFontAccess()) {
      setLocalFontStatus('unsupported')
      return
    }
    setLocalFontStatus('loading')
    try {
      setLocalFontFamilies(await queryLocalFontFamiliesOnce())
      setLocalFontStatus('ready')
    } catch {
      hasRequestedLocalFontsRef.current = false
      setLocalFontStatus('failed')
      toast.warning(
        t(
          'presentationWorkspace.localFontsLoadFailed',
          'Unable to load local fonts. Check the font access permission.'
        )
      )
    }
  }

  const loadLocalFontsOnFirstGesture = (): void => {
    if (hasRequestedLocalFontsRef.current) return
    hasRequestedLocalFontsRef.current = true
    void loadLocalFonts()
  }

  const openLineSpacingOptions = (): void => {
    setLineSpacingDraft(selectedTextElement?.lineHeight ?? 1.15)
    setIsLineSpacingOptionsOpen(true)
  }

  const showShapeMenu = (event: React.MouseEvent): void => {
    showMenu(
      [
        {
          id: 'insert-rectangle',
          label: t('presentationWorkspace.rectangle', 'Rectangle'),
          onAction: () => addShape('rectangle')
        },
        {
          id: 'insert-ellipse',
          label: t('presentationWorkspace.ellipse', 'Ellipse'),
          onAction: () => addShape('ellipse')
        },
        {
          id: 'insert-line',
          label: t('presentationWorkspace.line', 'Line'),
          onAction: addLine
        }
      ],
      event
    )
  }

  const collapseSlideSelectionToActive = (): void => {
    if (!activeSlideId || selectedSlideIds.size <= 1) return
    setSelectedSlideIds(new Set([activeSlideId]))
  }

  const startRailResize = (event: React.PointerEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = railWidth
    const move = (moveEvent: PointerEvent): void => {
      setRailWidth(Math.max(184, Math.min(360, startWidth + moveEvent.clientX - startX)))
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }

  const renderRibbon = (): React.JSX.Element => {
    const textDisabled = !selectedTextElement
    const activeTheme =
      document.themes?.[activeSlide?.themeId ?? document.defaultThemeId ?? ''] ??
      createDefaultPresentationTheme(document.width)
    const selectedParagraphs = selectedTextElement
      ? normalizeTextParagraphs(selectedTextElement)
      : null
    const selectedRange =
      selectedTextElement && textSelection?.elementId === selectedTextElement.id
        ? textSelection
        : selectedTextElement
          ? { start: 0, end: selectedTextElement.text.length }
          : null
    const characterValue = <K extends keyof EditableTextStyle>(
      key: K,
      fallback: EditableTextStyle[K]
    ): EditableTextStyle[K] | 'mixed' => {
      if (!selectedParagraphs || !selectedRange) return fallback
      return (
        getCharacterStyleValue(selectedParagraphs, selectedRange.start, selectedRange.end, key) ??
        fallback
      )
    }
    const toggleState = (
      key: 'bold' | 'italic' | 'underline' | 'strikethrough',
      fallback: boolean
    ): boolean | 'mixed' => characterValue(key, fallback)
    const touchedParagraphs: EditableTextParagraph[] = []
    if (selectedParagraphs && selectedRange) {
      mapSelectedParagraphs(
        selectedParagraphs,
        selectedRange.start,
        selectedRange.end,
        (paragraph) => {
          touchedParagraphs.push(paragraph)
          return paragraph
        }
      )
    }
    const alignment = touchedParagraphs.every(
      (paragraph) => paragraph.align === touchedParagraphs[0]?.align
    )
      ? (touchedParagraphs[0]?.align ?? 'left')
      : 'mixed'
    const listState = (kind: 'bullet' | 'number'): boolean | 'mixed' => {
      const values = touchedParagraphs.map((paragraph) => paragraph.list?.kind === kind)
      return values.every((value) => value === values[0]) ? (values[0] ?? false) : 'mixed'
    }
    const selectedFontSize = characterValue(
      'fontSize',
      selectedTextElement?.fontSize ?? activeTheme.defaultTextStyle.fontSize
    )
    const changeFontSize = (direction: -1 | 1): void => {
      if (!selectedTextElement || !document) return
      const currentPoints = presentationCanvasPxToPoints(
        selectedTextElement.fontSize,
        document.width
      )
      const currentIndex = FONT_SIZES.findIndex((size) => size >= currentPoints)
      const nextIndex = Math.max(0, Math.min(FONT_SIZES.length - 1, currentIndex + direction))
      patchCharacterStyle({
        fontSize: presentationPointsToCanvasPx(FONT_SIZES[nextIndex], document.width)
      })
    }
    const clearTextFormatting = (): void => {
      updateSelectedTextElement((element) => {
        const defaults = activeTheme.defaultTextStyle
        const range = getTextCommandRange(element)
        const paragraphs = clearCharacterFormatting(
          normalizeTextParagraphs(element),
          range.start,
          range.end,
          defaults
        )
        return {
          ...defaults,
          paragraphs,
          runs: flattenTextParagraphs(paragraphs)
        }
      })
    }

    return (
      <div
        data-ribbon-surface
        className="flex h-full min-w-0 w-full items-stretch overflow-x-auto overflow-y-hidden border-b border-separator bg-surface/95"
      >
        <RibbonGroup label={t('presentationWorkspace.slides', 'Slides')} className="w-20">
          <div className="flex h-full items-center justify-center">
            <button type="button" className={RIBBON_COMMAND_BUTTON_CLASS} onClick={addSlide}>
              <Plus size={18} />
              {t('presentationWorkspace.newSlide', 'New Slide')}
            </button>
          </div>
        </RibbonGroup>

        <PresentationHomeRibbon
          disabled={textDisabled}
          onFinishFormatting={finishFormatting}
          fontFamilies={fontFamilies}
          documentFonts={documentFonts}
          recentFonts={recentFonts}
          localFonts={localFontFamilies}
          localFontStatus={localFontStatus}
          fontFamily={characterValue(
            'fontFamily',
            selectedTextElement?.fontFamily ?? activeTheme.defaultTextStyle.fontFamily
          )}
          fontSize={
            selectedFontSize === 'mixed'
              ? 'mixed'
              : presentationCanvasPxToPoints(selectedFontSize, document.width)
          }
          bold={toggleState('bold', Boolean(selectedTextElement?.bold))}
          italic={toggleState('italic', Boolean(selectedTextElement?.italic))}
          underline={toggleState('underline', Boolean(selectedTextElement?.underline))}
          strikethrough={toggleState('strikethrough', Boolean(selectedTextElement?.strikethrough))}
          baseline={characterValue('baseline', selectedTextElement?.baseline ?? 'normal')}
          color={characterValue(
            'color',
            selectedTextElement?.color ?? activeTheme.defaultTextStyle.color
          )}
          highlightColor={characterValue(
            'highlightColor',
            selectedTextElement?.highlightColor ?? null
          )}
          align={alignment}
          bullets={listState('bullet')}
          numbering={listState('number')}
          characterSpacing={characterValue(
            'characterSpacing',
            selectedTextElement?.characterSpacing ?? 0
          )}
          lineSpacing={
            touchedParagraphs.every(
              (paragraph) =>
                JSON.stringify(paragraph.lineSpacing) ===
                JSON.stringify(touchedParagraphs[0]?.lineSpacing)
            ) && touchedParagraphs[0]?.lineSpacing.kind === 'multiple'
              ? touchedParagraphs[0].lineSpacing.value
              : 'mixed'
          }
          theme={activeTheme}
          onFontAccess={loadLocalFontsOnFirstGesture}
          onFontFamilyChange={(fontFamily) => {
            patchCharacterStyle({ fontFamily })
            rememberFont(fontFamily)
          }}
          onFontSizeChange={(fontSize) => {
            if (!Number.isFinite(fontSize) || fontSize <= 0) return
            patchCharacterStyle({
              fontSize: presentationPointsToCanvasPx(fontSize, document.width)
            })
          }}
          onGrowFont={() => changeFontSize(1)}
          onShrinkFont={() => changeFontSize(-1)}
          onCharacterStyle={patchCharacterStyle}
          onChangeCase={(textCase) => {
            updateSelectedTextElement((element) => {
              const range = getTextCommandRange(element)
              const paragraphs = changeTextCase(
                normalizeTextParagraphs(element),
                range.start,
                range.end,
                textCase
              )
              return {
                text: paragraphs
                  .map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
                  .join('\n'),
                paragraphs,
                runs: flattenTextParagraphs(paragraphs)
              }
            })
          }}
          onReset={clearTextFormatting}
          onAlign={(align) => patchParagraphs((paragraph) => ({ ...paragraph, align }))}
          onBullets={(char) =>
            patchParagraphs((paragraph) => ({
              ...paragraph,
              list:
                char === undefined && listState('bullet') === true
                  ? null
                  : { kind: 'bullet', level: paragraph.list?.level ?? 0, char: char ?? '•' }
            }))
          }
          onNumbering={(format) =>
            patchParagraphs((paragraph) => ({
              ...paragraph,
              list:
                format === undefined && listState('number') === true
                  ? null
                  : {
                      kind: 'number',
                      level: paragraph.list?.level ?? 0,
                      format: format ?? 'arabicPeriod',
                      startAt: 1
                    }
            }))
          }
          onDecreaseIndent={() =>
            patchParagraphs((paragraph) => ({
              ...paragraph,
              marginLeft: Math.max(0, paragraph.marginLeft - 32),
              list: paragraph.list
                ? { ...paragraph.list, level: Math.max(0, paragraph.list.level - 1) }
                : null
            }))
          }
          onIncreaseIndent={() =>
            patchParagraphs((paragraph) => ({
              ...paragraph,
              marginLeft: paragraph.marginLeft + 32,
              list: paragraph.list ? { ...paragraph.list, level: paragraph.list.level + 1 } : null
            }))
          }
          onLineSpacing={openLineSpacingOptions}
          onLineSpacingValue={(value) =>
            patchParagraphs((paragraph) => ({
              ...paragraph,
              lineSpacing: { kind: 'multiple', value }
            }))
          }
          onAutoWidth={() =>
            updateSelectedTextElement({
              autoWidth: !selectedTextElement?.autoWidth,
              autoSize: selectedTextElement?.autoWidth ? 'fixed' : 'content'
            })
          }
        />

        <RibbonGroup
          label={t('presentationWorkspace.ribbonGroups.insert', 'Insert')}
          className="w-44"
        >
          <div className="flex h-full items-center gap-1">
            <button
              type="button"
              className={RIBBON_COMMAND_BUTTON_CLASS}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImagePlus size={18} />
              {t('presentationWorkspace.picture', 'Picture')}
            </button>
            <button
              type="button"
              className={RIBBON_COMMAND_BUTTON_CLASS}
              onClick={showShapeMenu}
              aria-haspopup="menu"
            >
              <RectangleHorizontal size={18} />
              {t('presentationWorkspace.shapes', 'Shapes')}
            </button>
            <button
              type="button"
              className={`${RIBBON_COMMAND_BUTTON_CLASS} ${
                isTextInsertMode ? RIBBON_ICON_BUTTON_ACTIVE_CLASS : ''
              }`}
              aria-pressed={isTextInsertMode}
              onClick={() => setIsTextInsertMode((enabled) => !enabled)}
            >
              <Type size={18} />
              {t('presentationWorkspace.text', 'Text')}
            </button>
          </div>
        </RibbonGroup>

        <RibbonGroup label={t('presentationWorkspace.ribbonGroups.arrange', 'Arrange')}>
          <button
            type="button"
            className={RIBBON_COMMAND_BUTTON_CLASS}
            aria-haspopup="menu"
            title={t('presentationWorkspace.ribbonGroups.arrange', 'Arrange')}
            onClick={(event) =>
              showMenu(
                [
                  {
                    id: 'bring-forward',
                    label: t('presentationWorkspace.bringForward'),
                    icon: <BringToFront size={17} />,
                    disabled: !selectedElement,
                    onAction: () =>
                      selectedElement && reorderElement(selectedElement.id, 'bring-forward')
                  },
                  {
                    id: 'send-backward',
                    label: t('presentationWorkspace.sendBackward'),
                    icon: <SendToBack size={17} />,
                    disabled: !selectedElement,
                    onAction: () =>
                      selectedElement && reorderElement(selectedElement.id, 'send-backward')
                  },
                  'separator',
                  ...(
                    [
                      ['left', AlignHorizontalJustifyStart],
                      ['center', AlignHorizontalJustifyCenter],
                      ['right', AlignHorizontalJustifyEnd],
                      ['top', AlignVerticalJustifyStart],
                      ['middle', AlignVerticalJustifyCenter],
                      ['bottom', AlignVerticalJustifyEnd]
                    ] as const
                  ).map(([alignment, Icon]) => ({
                    id: alignment,
                    label: t(`presentationWorkspace.objectAlign.${alignment}`),
                    icon: <Icon size={17} />,
                    disabled: selectedElementIds.size < 2,
                    onAction: () => applyElementAlignment(alignment)
                  })),
                  'separator',
                  ...(
                    [
                      ['horizontal', AlignHorizontalSpaceAround],
                      ['vertical', AlignVerticalSpaceAround]
                    ] as const
                  ).map(([direction, Icon]) => ({
                    id: direction,
                    label: t(`presentationWorkspace.distribute.${direction}`),
                    icon: <Icon size={17} />,
                    disabled: selectedElementIds.size < 3,
                    onAction: () => applyElementDistribution(direction)
                  }))
                ],
                event
              )
            }
          >
            <BringToFront size={18} />
            {t('presentationWorkspace.ribbonGroups.arrange', 'Arrange')}
          </button>
        </RibbonGroup>
      </div>
    )
  }

  useKeyboardShortcuts(
    [
      {
        id: 'presentation-new-slide',
        config: SHORTCUTS.PRESENTATION.NEW_SLIDE,
        description: t('presentationWorkspace.newSlide', 'New Slide'),
        handler: addSlide
      },
      {
        id: 'presentation-duplicate-object',
        config: SHORTCUTS.PRESENTATION.DUPLICATE,
        description: t('presentationWorkspace.duplicateElement', 'Duplicate object'),
        handler: duplicateSelectedElement
      },
      {
        id: 'presentation-zoom-in',
        config: SHORTCUTS.PRESENTATION.ZOOM_IN,
        description: t('presentationWorkspace.zoomIn', 'Zoom in'),
        handler: () => setCustomZoom(zoomPercent + 25)
      },
      {
        id: 'presentation-zoom-in-alt',
        config: SHORTCUTS.PRESENTATION.ZOOM_IN_ALT,
        description: t('presentationWorkspace.zoomIn', 'Zoom in'),
        handler: () => setCustomZoom(zoomPercent + 25)
      },
      {
        id: 'presentation-zoom-out',
        config: SHORTCUTS.PRESENTATION.ZOOM_OUT,
        description: t('presentationWorkspace.zoomOut', 'Zoom out'),
        handler: () => setCustomZoom(zoomPercent - 25)
      },
      {
        id: 'presentation-zoom-fit',
        config: SHORTCUTS.PRESENTATION.ZOOM_FIT,
        description: t('presentationWorkspace.fit', 'Fit'),
        handler: () => setZoomMode('fit')
      },
      {
        id: 'presentation-bold',
        config: SHORTCUTS.PRESENTATION.BOLD,
        description: t('presentationWorkspace.bold', 'Bold'),
        handler: () => {
          toggleCharacterStyle('bold')
        }
      },
      {
        id: 'presentation-italic',
        config: SHORTCUTS.PRESENTATION.ITALIC,
        description: t('presentationWorkspace.italic', 'Italic'),
        handler: () => {
          toggleCharacterStyle('italic')
        }
      },
      {
        id: 'presentation-underline',
        config: SHORTCUTS.PRESENTATION.UNDERLINE,
        description: t('presentationWorkspace.underline', 'Underline'),
        handler: () => {
          toggleCharacterStyle('underline')
        }
      }
    ],
    { sectionKey: 'presentation' }
  )

  const handleClipboardCommand = (
    command: 'copy' | 'cut' | 'paste',
    target: Element | null
  ): boolean => {
    if (
      target?.closest(
        'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]'
      )
    )
      return false
    const inSlides = Boolean(target?.closest('[data-slide-sidebar]'))
    if (!inSlides && target !== window.document.body && !target?.closest('.presentation-stage'))
      return false
    if (command === 'paste') {
      if (!inSlides && copiedElement) pasteElement()
      else pasteSlide()
    } else if (!inSlides && selectedElement) {
      setCopiedElement(selectedElement)
      if (command === 'cut') deleteElement()
    } else if (command === 'copy') copySelectedSlides()
    else cutSelectedSlides()
    return true
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[role="menu"], [role="dialog"]')) return
      const isFormControl = Boolean(target?.closest('input, select, textarea'))
      if (isFormControl) return
      const isSlideSidebar = Boolean(target?.closest('[data-slide-sidebar]'))
      const command = event.metaKey || event.ctrlKey
      const isSlideClipboardCommand =
        isSlideSidebar && command && ['c', 'x', 'v'].includes(event.key.toLowerCase())
      const isActionControl = Boolean(
        target?.closest('button, a[href], [role="button"], [role="link"], [role="tab"]')
      )
      const isTabDelete =
        isSlideSidebar &&
        Boolean(target?.closest('[data-slide-option]')) &&
        (event.key === 'Delete' || event.key === 'Backspace')
      if (isActionControl && !isTabDelete && !isSlideClipboardCommand) return
      const isContentEditable =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.getAttribute('contenteditable') === 'true')
      if (isContentEditable && command && !event.altKey && !event.shiftKey && !event.isComposing) {
        const styleKey = { b: 'bold', i: 'italic', u: 'underline' } as const
        const key = event.key.toLowerCase()
        if (key === 'b' || key === 'i' || key === 'u') {
          event.preventDefault()
          toggleCharacterStyle(styleKey[key])
          return
        }
      }
      if (isContentEditable && event.key !== 'Escape') return

      if (event.key === 'Escape') {
        if (event.isComposing || event.keyCode === 229) return
        if (editingElementId) {
          event.preventDefault()
          if (!finalizeTextEditor()) return
          commitTextDraft()
          return
        }
        if (session.getSnapshot().draftKind !== null) {
          event.preventDefault()
          session.cancelDraft()
          return
        }
        if (selectedElementIds.size > 0) {
          event.preventDefault()
          selectElement(null)
          return
        }
        if (isTextInsertMode) {
          event.preventDefault()
          setIsTextInsertMode(false)
        }
        return
      }

      if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault()
        const nextIndex = Math.max(
          0,
          Math.min(
            document.slideOrder.length - 1,
            activeSlideIndex + (event.key === 'PageUp' ? -1 : 1)
          )
        )
        const nextSlideId = document.slideOrder[nextIndex]
        if (nextSlideId && nextSlideId !== activeSlideId) {
          if (!finalizeTextEditor()) return
          commitTextDraft()
          activateSlide(nextSlideId)
          setSelectedSlideIds(new Set([nextSlideId]))
          setSelectionAnchorIndex(nextIndex)
          setSelectedElementId(null)
          setSelectedElementIds(new Set())
          setEditingElementId(null)
          setIsTextInsertMode(false)
          setInsertionIndex(null)
        }
        return
      }

      if (
        event.key === 'Enter' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        selectedTextElement &&
        !selectedTextElement.locked
      ) {
        event.preventDefault()
        setEditingElementId(selectedTextElement.id)
        return
      }

      if (
        activeSlideId &&
        selectedElementIds.size > 0 &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      ) {
        event.preventDefault()
        const amount = event.altKey ? 1 : event.shiftKey ? 10 : 5
        const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0
        const dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0
        commitDocument((current) =>
          nudgeElements(current, activeSlideId, [...selectedElementIds], dx, dy)
        )
        return
      }
      if (isSlideSidebar && command && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        if (document) {
          setSelectedSlideIds(new Set(document.slideOrder))
          setCopiedElement(null)
          setSelectedElementId(null)
        }
        return
      }
      if (command && !event.altKey && ['c', 'x', 'v'].includes(event.key.toLowerCase())) {
        const action =
          event.key.toLowerCase() === 'c'
            ? 'copy'
            : event.key.toLowerCase() === 'x'
              ? 'cut'
              : 'paste'
        if (handleClipboardCommand(action, target)) event.preventDefault()
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (isSlideSidebar) {
          event.preventDefault()
          deleteSlide()
        } else if (selectedElementId) {
          event.preventDefault()
          deleteElement()
        }
      }
    }

    const handleClipboard = (event: ClipboardEvent): void => {
      if (event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : window.document.activeElement
      if (
        (event.type === 'copy' || event.type === 'cut' || event.type === 'paste') &&
        handleClipboardCommand(event.type, target)
      )
        event.preventDefault()
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('copy', handleClipboard)
    window.addEventListener('cut', handleClipboard)
    window.addEventListener('paste', handleClipboard)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('copy', handleClipboard)
      window.removeEventListener('cut', handleClipboard)
      window.removeEventListener('paste', handleClipboard)
    }
  })

  if (!activeSlideId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <FileText className="text-danger" size={36} />
        <p className="text-sm font-semibold text-danger">{t('presentationWorkspace.loadFailed')}</p>
      </div>
    )
  }

  const ribbonHeightClass = 'h-24'

  return (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col bg-background"
        onPointerDownCapture={(event) => {
          const target = event.target as HTMLElement | null
          if (target?.closest('[data-slide-sidebar]')) return
          collapseSlideSelectionToActive()
        }}
      >
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) {
              void addImage(file).catch((imageError) => {
                toast.danger(imageError instanceof Error ? imageError.message : String(imageError))
              })
            }
          }}
        />
        <div
          id="presentation-ribbon-panel"
          role="toolbar"
          aria-label={t('presentationWorkspace.home', 'Home')}
          data-testid="presentation-ribbon-frame"
          className={`shrink-0 overflow-hidden ${ribbonHeightClass}`}
        >
          {renderRibbon()}
        </div>
        {unavailableFonts.length ? (
          <p role="status" className="shrink-0 px-3 py-1 text-xs text-warning">
            {t('personalCloud.missingFonts', { fonts: unavailableFonts.join(', ') })}
          </p>
        ) : null}
        <ResponsivePanelGroup
          navigatorWidth={railWidth}
          navigatorLabel={t('presentationWorkspace.slides', 'Slides')}
          inspectorLabel={t('presentationWorkspace.formatBackground', 'Format Background')}
          overlay={compactOverlay === 'inspector' && !isBackgroundPanelOpen ? null : compactOverlay}
          inspectorReturnFocusRef={formatBackgroundTriggerRef}
          onOverlayChange={(overlay) => {
            setCompactOverlay(overlay)
            if (overlay === 'navigator' || (overlay === null && compactOverlay === 'inspector')) {
              onBackgroundPanelOpenChange(false)
            }
          }}
          navigator={
            <NavigatorRail
              data-slide-sidebar
              role="listbox"
              aria-multiselectable="true"
              className="presentation-slide-rail relative min-h-0 overflow-y-auto border-r border-separator bg-surface/40 px-2 py-3"
              onContextMenu={showSlideSidebarMenu}
            >
              <div className="space-y-1" role="presentation">
                {document.slideOrder.map((slideId, index) => {
                  const isSelected =
                    selectedSlideIds.size === 0
                      ? index === activeSlideIndex
                      : selectedSlideIds.has(slideId)
                  const slide = document.slides[slideId]
                  const hasBackdropImage = slide.elementOrder.some((id) => {
                    const element = slide.elements[id]
                    return (
                      (element.type === 'image' || element.type === 'locked') &&
                      element.x <= 0 &&
                      element.y <= 0 &&
                      element.x + element.width >= document.width &&
                      element.y + element.height >= document.height
                    )
                  })
                  const outline = hasBackdropImage
                    ? 'mixed'
                    : getSlideBackgroundOutline(slide.background)
                  return (
                    <React.Fragment key={slideId}>
                      <button
                        type="button"
                        data-slide-divider
                        data-slide-index={index}
                        className="group flex h-5 w-full items-center px-1"
                        onClick={() => setInsertionIndex(index)}
                        onDragOver={(event) => {
                          event.preventDefault()
                          setInsertionIndex(index)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          moveSelectedSlides(index)
                        }}
                        aria-label={t('presentationWorkspace.insertBeforeSlide', {
                          number: index + 1
                        })}
                      >
                        <span
                          className={`w-full rounded-full ${
                            insertionIndex === index
                              ? 'h-[2px] presentation-insertion-line bg-[#f59e0b]'
                              : 'h-px bg-transparent group-focus-visible:bg-[#f59e0b]/70'
                          }`}
                        />
                      </button>
                      <button
                        draggable
                        data-slide-option
                        data-slide-index={index}
                        role="option"
                        aria-selected={isSelected}
                        className="flex w-full gap-2 rounded-md px-1 py-2 text-left text-muted transition-colors hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500"
                        onClick={(event) => selectSlide(index, event)}
                        onDragStart={(event) => {
                          const ids = selectedSlideIds.has(slideId)
                            ? getSelectedSlideIds()
                            : [slideId]
                          setDraggingSlideIds(ids)
                          setSelectedSlideIds(new Set(ids))
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', ids.join(','))
                        }}
                        onDragEnd={() => {
                          setDraggingSlideIds([])
                          setInsertionIndex(null)
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.altKey &&
                            (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                          ) {
                            event.preventDefault()
                            const target = event.key === 'ArrowUp' ? index - 1 : index + 2
                            const ids = selectedSlideIds.has(slideId)
                              ? getSelectedSlideIds()
                              : [slideId]
                            commitDocument((current) => reorderSelectedSlides(current, ids, target))
                            return
                          }
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            addSlideAfter(index)
                          }
                        }}
                      >
                        <span
                          className={
                            isSelected
                              ? 'w-4 pt-1 text-right text-xs tabular-nums text-foreground'
                              : 'w-4 pt-1 text-right text-xs tabular-nums'
                          }
                        >
                          {index + 1}
                        </span>
                        <span
                          className={`relative flex aspect-video w-full min-w-0 overflow-hidden border bg-black shadow-sm ${`${outline === 'dark' ? 'border-neutral-500' : 'border-white'} ${
                            isSelected ? 'ring-2 ring-[#f59e0b]' : ''
                          } ${outline === 'mixed' ? 'outline outline-1 outline-neutral-600' : ''}`}`}
                        >
                          <EditableSlideThumbnail document={document} slideId={slideId} />
                          {index === projectedSlideIndex && (
                            <span
                              className="absolute inset-y-0 left-0 w-1 bg-success"
                              aria-label={t(
                                'presentationWorkspace.projectedSlide',
                                'Projected slide'
                              )}
                            />
                          )}
                          {index === projectedSlideIndex + 1 && projectedSlideIndex >= 0 && (
                            <span
                              className="absolute bottom-1 right-1 rounded bg-success/90 px-1 text-[10px] font-semibold text-white"
                              aria-label={t('presentationWorkspace.nextSlide', 'Next slide')}
                            >
                              {t('presentationWorkspace.next', 'Next')}
                            </span>
                          )}
                        </span>
                      </button>
                    </React.Fragment>
                  )
                })}
                <button
                  type="button"
                  data-slide-divider
                  data-slide-index={document.slideOrder.length}
                  className="group flex h-5 w-full items-center px-1"
                  onClick={() => setInsertionIndex(document.slideOrder.length)}
                  onDragOver={(event) => {
                    event.preventDefault()
                    setInsertionIndex(document.slideOrder.length)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    moveSelectedSlides(document.slideOrder.length)
                  }}
                  aria-label={t('presentationWorkspace.insertAfterLastSlide')}
                >
                  <span
                    className={`w-full rounded-full ${
                      insertionIndex === document.slideOrder.length
                        ? 'h-[2px] presentation-insertion-line bg-[#f59e0b]'
                        : 'h-px bg-transparent group-focus-visible:bg-[#f59e0b]/70'
                    }`}
                  />
                </button>
              </div>
              <button
                type="button"
                className="absolute inset-y-0 right-0 w-1 cursor-col-resize bg-transparent hover:bg-accent/50 focus-visible:bg-accent"
                onPointerDown={startRailResize}
                aria-label={t('presentationWorkspace.resizeSlideRail', 'Resize slide rail')}
              />
            </NavigatorRail>
          }
          stage={
            <StageViewport className="presentation-stage relative flex min-h-0 flex-col bg-[#111217]">
              <div
                ref={canvasViewportRef}
                data-testid="presentation-canvas-viewport"
                className="min-h-0 flex-1 overflow-auto"
              >
                <div className="flex h-max min-h-full w-max min-w-full p-8">
                  <div
                    ref={canvasRef}
                    data-testid="presentation-canvas"
                    className="relative m-auto max-w-none shrink-0"
                    style={{ width: `${PRESENTATION_CANVAS_WIDTH * (zoomPercent / 100)}px` }}
                  >
                    <EditableSlideSurface
                      document={document}
                      slideId={activeSlideId}
                      editable
                      showBorder
                      selectedElementId={selectedElementId}
                      selectedElementIds={selectedElementIds}
                      editingElementId={editingElementId}
                      isTextInsertMode={isTextInsertMode}
                      onSelectElement={selectElement}
                      onMarqueeSelect={(bounds, additive) => {
                        if (!activeSlide) return
                        const matches = selectElementsInBounds(activeSlide, bounds)
                        setSelectedElementIds((current) => {
                          const next = additive ? new Set(current) : new Set<string>()
                          matches.forEach((elementId) => next.add(elementId))
                          setSelectedElementId(
                            matches.at(-1) ?? (additive ? selectedElementId : null)
                          )
                          return next
                        })
                      }}
                      onEditingElementChange={(elementId) => {
                        if (elementId === null) {
                          if (newEmptyTextRef.current) {
                            newEmptyTextRef.current = null
                            clearTextCommitTimer()
                            session.cancelDraft()
                            setSelectedElementId(null)
                            setSelectedElementIds(new Set())
                          }
                          commitTextDraft()
                          setTextSelection(null)
                        }
                        setEditingElementId(elementId)
                      }}
                      onTextEditFinalizerChange={setTextEditorFinalizer}
                      onTextSelectionChange={setTextSelection}
                      onTextLayoutChange={onTextLayoutChange}
                      onTextIndent={changeSelectedTextIndent}
                      onInsertText={addTextElement}
                      onElementContextMenu={showElementContextMenu}
                      onCanvasContextMenu={showCanvasContextMenu}
                      onTransformStart={(elementId) => {
                        const current =
                          session.getSnapshot().renderedDocument.slides[activeSlideId]?.elements[
                            elementId
                          ]
                        if (!current) return undefined
                        session.beginDraft('pointer')
                        return current
                      }}
                      onTransformPreview={(elementId, updates) => {
                        const snapshot = session.getSnapshot()
                        const base = snapshot.history.present
                        const current = base.slides[activeSlideId]?.elements[elementId]
                        let nextUpdates = updates
                        if (current && (updates.x !== undefined || updates.y !== undefined)) {
                          const snapped = snapElementPosition(
                            { ...current, ...updates },
                            { width: base.width, height: base.height },
                            8
                          )
                          nextUpdates = { ...updates, x: snapped.x, y: snapped.y }
                          setSnapGuides({
                            vertical: snapped.verticalGuide,
                            horizontal: snapped.horizontalGuide
                          })
                        }
                        if (
                          current &&
                          selectedElementIds.size > 1 &&
                          updates.width === undefined &&
                          updates.height === undefined &&
                          (nextUpdates.x !== undefined || nextUpdates.y !== undefined)
                        ) {
                          return session.previewDraft(
                            nudgeElements(
                              base,
                              activeSlideId,
                              [...selectedElementIds],
                              (nextUpdates.x ?? current.x) - current.x,
                              (nextUpdates.y ?? current.y) - current.y
                            )
                          )
                        }
                        return session.previewDraft(
                          updateElementInSlide(base, activeSlideId, elementId, nextUpdates)
                        )
                      }}
                      onTransformCommit={() => {
                        setSnapGuides({})
                        session.commitDraft()
                      }}
                      onTransformCancel={() => {
                        setSnapGuides({})
                        session.cancelDraft()
                      }}
                      onUpdateElement={previewTextElement}
                    />
                    {snapGuides.vertical !== undefined && (
                      <span
                        className="pointer-events-none absolute inset-y-0 w-px bg-accent"
                        style={{ left: `${(snapGuides.vertical / document.width) * 100}%` }}
                      />
                    )}
                    {snapGuides.horizontal !== undefined && (
                      <span
                        className="pointer-events-none absolute inset-x-0 h-px bg-accent"
                        style={{ top: `${(snapGuides.horizontal / document.height) * 100}%` }}
                      />
                    )}
                  </div>
                </div>
              </div>
              {isNotesOpen && (
                <section
                  id="presentation-notes-region"
                  aria-label={t('presentationWorkspace.notes', 'Notes')}
                  className="border-t border-separator bg-surface/95 px-4 py-2 text-xs text-muted"
                >
                  <label>
                    <span className="sr-only">{t('presentationWorkspace.notes', 'Notes')}</span>
                    <textarea
                      className="h-20 w-full resize-none rounded-lg border border-separator bg-surface-secondary p-2 text-sm text-foreground outline-none focus:border-accent"
                      value={notesDraft}
                      onChange={(event) => {
                        if (!activeSlideId) return
                        const snapshot = session.getSnapshot()
                        const nextNotes = event.currentTarget.value
                        const storedNotes =
                          snapshot.history.present.slides[activeSlideId]?.notes ?? ''
                        if (nextNotes === storedNotes) {
                          if (snapshot.draftKind === 'notes') session.cancelDraft()
                          return
                        }
                        if (snapshot.draftKind !== 'notes') {
                          session.beginDraft('notes')
                        }
                        session.previewDraft(
                          updateSlideNotes(
                            session.getSnapshot().renderedDocument,
                            activeSlideId,
                            nextNotes
                          )
                        )
                      }}
                      onBlur={() => commitNotes()}
                      aria-label={t('presentationWorkspace.notes', 'Notes')}
                      placeholder={t(
                        'presentationWorkspace.notesPlaceholder',
                        'Add speaker notes for this slide'
                      )}
                    />
                  </label>
                </section>
              )}
              <div
                data-testid="presentation-status-bar"
                className="flex h-8 items-center gap-3 border-t border-separator bg-surface px-3 text-xs text-muted"
              >
                <span>
                  {t('presentationWorkspace.slide', 'Slide')} {activeSlideIndex + 1} /{' '}
                  {document.slideOrder.length}
                </span>
                <span>
                  {t('presentationWorkspace.selectedObjects', 'Selected objects')}:{' '}
                  {selectedElementIds.size}
                </span>
                {projectedSlideIndex >= 0 && (
                  <span className="text-success">
                    {t('presentationWorkspace.projectingSlide', 'Projecting slide')}{' '}
                    {projectedSlideIndex + 1}
                  </span>
                )}
                <Button
                  size="sm"
                  variant={isNotesOpen ? 'primary' : 'ghost'}
                  onPress={() => {
                    if (isNotesOpen) commitNotes()
                    setIsNotesOpen((open) => !open)
                  }}
                  aria-label={t('presentationWorkspace.toggleNotes', 'Toggle Notes')}
                  aria-controls="presentation-notes-region"
                  aria-expanded={isNotesOpen}
                >
                  <StickyNote size={14} />
                  <span className="hidden lg:inline">
                    {t('presentationWorkspace.notes', 'Notes')}
                  </span>
                </Button>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={() => setCustomZoom(zoomPercent - 25)}
                    aria-label={t('presentationWorkspace.zoomOut', 'Zoom out')}
                  >
                    <ZoomOut size={14} />
                  </Button>
                  <input
                    className="w-28 accent-primary"
                    type="range"
                    min={25}
                    max={200}
                    step={1}
                    value={zoomPercent}
                    onChange={(event) => setCustomZoom(Number(event.currentTarget.value))}
                    aria-label={t('presentationWorkspace.zoom', 'Zoom')}
                  />
                  <button
                    type="button"
                    className="w-11 rounded px-1 text-right tabular-nums hover:bg-surface-secondary"
                    onClick={() => setCustomZoom(100)}
                    aria-label={t('presentationWorkspace.resetZoom', 'Reset zoom')}
                  >
                    {zoomPercent}%
                  </button>
                  <Button
                    size="sm"
                    variant={zoomMode === 'fit' ? 'primary' : 'ghost'}
                    onPress={() => setZoomMode('fit')}
                    aria-pressed={zoomMode === 'fit'}
                  >
                    {t('presentationWorkspace.fit', 'Fit')}
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={() => setCustomZoom(zoomPercent + 25)}
                    aria-label={t('presentationWorkspace.zoomIn', 'Zoom in')}
                  >
                    <ZoomIn size={14} />
                  </Button>
                </div>
              </div>
            </StageViewport>
          }
          inspector={
            isBackgroundPanelOpen && activeSlide ? (
              <InspectorPanel className="presentation-inspector">
                <FormatBackgroundPanel
                  background={activeSlide.background}
                  onChange={setActiveSlideBackground}
                  onApplyToAll={applyActiveBackgroundToAllSlides}
                  onReset={resetActiveSlideBackground}
                  onClose={closeBackgroundPanel}
                />
              </InspectorPanel>
            ) : undefined
          }
        />
      </div>
      <LineSpacingOptionsDialog
        isOpen={isLineSpacingOptionsOpen}
        value={lineSpacingDraft}
        onValueChange={setLineSpacingDraft}
        onClose={() => setIsLineSpacingOptionsOpen(false)}
        onApply={() => {
          const nextLineHeight = Math.max(
            0.5,
            Math.min(4, Number.isFinite(lineSpacingDraft) ? lineSpacingDraft : 1.15)
          )
          patchParagraphs((paragraph) => ({
            ...paragraph,
            lineSpacing: { kind: 'multiple', value: nextLineHeight }
          }))
          setIsLineSpacingOptionsOpen(false)
        }}
      />
    </>
  )
}

function LineSpacingOptionsDialog({
  isOpen,
  value,
  onValueChange,
  onClose,
  onApply
}: {
  isOpen: boolean
  value: number
  onValueChange: (value: number) => void
  onClose: () => void
  onApply: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <AlertDialog.Backdrop isOpen={isOpen} isDismissable onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog data-presentation-text-tool className="p-5">
          <AlertDialog.Header>
            <AlertDialog.Heading>
              {t('presentationWorkspace.lineSpacingOptions', 'Line Spacing Options')}
            </AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <div className="space-y-4">
              <label className="block text-sm text-muted">
                <span>{t('presentationWorkspace.lineSpacing', 'Line spacing')}</span>
                <input
                  className={`mt-2 h-10 w-full ${NATIVE_CONTROL_CLASS}`}
                  type="number"
                  min={0.5}
                  max={4}
                  step={0.05}
                  value={value}
                  onChange={(event) => onValueChange(Number(event.currentTarget.value))}
                />
              </label>
              <input
                className={RANGE_CLASS}
                type="range"
                min={0.5}
                max={4}
                step={0.05}
                value={value}
                onChange={(event) => onValueChange(Number(event.currentTarget.value))}
              />
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" onPress={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onPress={onApply}>
              {t('common.confirm')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )
}

function FormatBackgroundPanel({
  background,
  onChange,
  onApplyToAll,
  onReset,
  onClose
}: {
  background: EditableSlideBackground
  onChange: (background: EditableSlideBackground) => void
  onApplyToAll: () => void
  onReset: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [selectedStopIndex, setSelectedStopIndex] = useState(0)
  const normalized = normalizeSlideBackground(background)
  const isModernGradient = normalized.type === 'gradient' && 'stops' in normalized
  const fillType = isModernGradient ? 'gradient' : 'solid'
  const gradient = isModernGradient
    ? normalized
    : {
        ...DEFAULT_GRADIENT_BACKGROUND,
        stops: [
          {
            ...DEFAULT_GRADIENT_BACKGROUND.stops[0],
            color: getSlideBackgroundPrimaryColor(normalized)
          },
          { ...DEFAULT_GRADIENT_BACKGROUND.stops[1] }
        ]
      }
  const selectedStop = gradient.stops[Math.min(selectedStopIndex, gradient.stops.length - 1)]

  const setFillType = (type: 'solid' | 'gradient'): void => {
    if (type === fillType) return
    if (type === 'solid') {
      onChange({
        type: 'solid',
        color: getSlideBackgroundPrimaryColor(normalized),
        transparency: 0
      })
      return
    }
    onChange({
      ...DEFAULT_GRADIENT_BACKGROUND,
      stops: [
        {
          ...DEFAULT_GRADIENT_BACKGROUND.stops[0],
          color: getSlideBackgroundPrimaryColor(normalized)
        },
        { ...DEFAULT_GRADIENT_BACKGROUND.stops[1] }
      ]
    })
    setSelectedStopIndex(0)
  }

  const updateSolid = (
    updates: Partial<Extract<EditableSlideBackground, { type: 'solid' }>>
  ): void => {
    const solid =
      normalized.type === 'solid'
        ? normalized
        : {
            type: 'solid' as const,
            color: getSlideBackgroundPrimaryColor(normalized),
            transparency: 0
          }
    onChange({ ...solid, ...updates })
  }

  const updateGradient = (
    updates: Partial<Extract<EditableSlideBackground, { type: 'gradient'; stops: unknown[] }>>
  ): void => {
    onChange({ ...gradient, ...updates })
  }

  const updateSelectedStop = (updates: Partial<(typeof gradient.stops)[number]>): void => {
    const stops = gradient.stops.map((stop, index) =>
      index === selectedStopIndex ? { ...stop, ...updates } : stop
    )
    updateGradient({ stops })
  }

  const addGradientStop = (): void => {
    const nextStop = { color: '#ffffff', position: 50, transparency: 0, brightness: 0 }
    const stops = [...gradient.stops, nextStop].sort((a, b) => a.position - b.position)
    updateGradient({ stops })
    setSelectedStopIndex(stops.indexOf(nextStop))
  }

  const removeSelectedStop = (): void => {
    if (gradient.stops.length <= 2) return
    const stops = gradient.stops.filter((_stop, index) => index !== selectedStopIndex)
    updateGradient({ stops })
    setSelectedStopIndex(Math.max(0, selectedStopIndex - 1))
  }

  return (
    <aside className="flex min-h-0 flex-col border-l border-separator bg-surface/80">
      <div className="flex items-center justify-between border-b border-separator px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">
          {t('presentationWorkspace.formatBackground', 'Format Background')}
        </h2>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          className="workspace-inspector-content-close"
          onPress={onClose}
          aria-label={t('common.close')}
        >
          <X size={16} />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <div role="radiogroup" className="space-y-2 text-sm text-muted">
          {(['solid', 'gradient'] as const).map((type) => (
            <label
              key={type}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-secondary"
            >
              <input
                type="radio"
                name="presentation-background-fill"
                checked={fillType === type}
                onChange={() => setFillType(type)}
              />
              {type === 'solid'
                ? t('presentationWorkspace.solidFill', 'Solid fill')
                : t('presentationWorkspace.gradientFill', 'Gradient fill')}
            </label>
          ))}
        </div>

        {fillType === 'solid' ? (
          <div className="space-y-4 text-sm text-muted">
            <label className="flex items-center justify-between gap-3">
              <span>{t('presentationWorkspace.fillColor', 'Color')}</span>
              <input
                className="h-9 w-14 rounded bg-transparent"
                type="color"
                value={
                  normalized.type === 'solid'
                    ? normalized.color
                    : getSlideBackgroundPrimaryColor(normalized)
                }
                onChange={(event) => updateSolid({ color: event.currentTarget.value })}
              />
            </label>
            <ControlSlider
              label={t('presentationWorkspace.transparency', 'Transparency')}
              value={normalized.type === 'solid' ? normalized.transparency : 0}
              min={0}
              max={100}
              suffix="%"
              onChange={(value) => updateSolid({ transparency: value })}
            />
          </div>
        ) : (
          <div className="space-y-4 text-sm text-muted">
            <label className="block">
              <span>{t('presentationWorkspace.gradientType', 'Type')}</span>
              <select className={`mt-2 h-9 w-full ${NATIVE_CONTROL_CLASS}`} value="linear" disabled>
                <option value="linear">{t('presentationWorkspace.linearGradient')}</option>
              </select>
            </label>
            <label className="block">
              <span>{t('presentationWorkspace.gradientDirection', 'Direction')}</span>
              <select
                className={`mt-2 h-9 w-full ${NATIVE_CONTROL_CLASS}`}
                value={gradient.direction}
                onChange={(event) =>
                  updateGradient({
                    direction: event.currentTarget.value as EditableGradientDirection,
                    angle: getAngleForDirection(
                      event.currentTarget.value as EditableGradientDirection
                    )
                  })
                }
              >
                <option value="left-right">
                  {t('presentationWorkspace.gradientLeftRight', 'Left to right')}
                </option>
                <option value="top-bottom">
                  {t('presentationWorkspace.gradientTopBottom', 'Top to bottom')}
                </option>
                <option value="diagonal">
                  {t('presentationWorkspace.gradientDiagonal', 'Diagonal')}
                </option>
              </select>
            </label>
            <ControlSlider
              label={t('presentationWorkspace.gradientAngle', 'Angle')}
              value={gradient.angle}
              min={0}
              max={360}
              suffix="°"
              onChange={(value) => updateGradient({ angle: value })}
            />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span>{t('presentationWorkspace.gradientStops', 'Gradient stops')}</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onPress={addGradientStop}>
                    +
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={gradient.stops.length <= 2}
                    onPress={removeSelectedStop}
                  >
                    -
                  </Button>
                </div>
              </div>
              <div className="flex gap-2">
                {gradient.stops.map((stop, index) => (
                  <button
                    key={`${stop.color}-${stop.position}-${index}`}
                    type="button"
                    className={`h-7 flex-1 rounded border ${
                      selectedStopIndex === index ? 'border-accent' : 'border-separator'
                    }`}
                    style={{ backgroundColor: stop.color }}
                    onClick={() => setSelectedStopIndex(index)}
                    aria-label={`${t('presentationWorkspace.gradientStop', 'Gradient stop')} ${index + 1}`}
                  />
                ))}
              </div>
            </div>
            {selectedStop && (
              <div className="space-y-4 rounded-xl border border-separator bg-surface-secondary/50 p-3">
                <label className="flex items-center justify-between gap-3">
                  <span>{t('presentationWorkspace.fillColor', 'Color')}</span>
                  <input
                    className="h-9 w-14 rounded bg-transparent"
                    type="color"
                    value={selectedStop.color}
                    onChange={(event) => updateSelectedStop({ color: event.currentTarget.value })}
                  />
                </label>
                <ControlSlider
                  label={t('presentationWorkspace.positionPercent', 'Position')}
                  value={selectedStop.position}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(value) => updateSelectedStop({ position: value })}
                />
                <ControlSlider
                  label={t('presentationWorkspace.transparency', 'Transparency')}
                  value={selectedStop.transparency}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(value) => updateSelectedStop({ transparency: value })}
                />
                <ControlSlider
                  label={t('presentationWorkspace.brightness', 'Brightness')}
                  value={selectedStop.brightness}
                  min={-100}
                  max={100}
                  suffix="%"
                  onChange={(value) => updateSelectedStop({ brightness: value })}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-separator p-4">
        <Button variant="primary" onPress={onApplyToAll}>
          {t('presentationWorkspace.applyToAll', 'Apply to All')}
        </Button>
        <Button variant="tertiary" onPress={onReset}>
          {t('presentationWorkspace.resetBackground', 'Reset Background')}
        </Button>
      </div>
    </aside>
  )
}

function ControlSlider({
  label,
  value,
  min,
  max,
  suffix,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  suffix: string
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <label className="block space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="text-xs tabular-nums text-default-400">
          {value}
          {suffix}
        </span>
      </div>
      <input
        className={RANGE_CLASS}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  )
}

function getAngleForDirection(direction: EditableGradientDirection): number {
  if (direction === 'left-right') return 90
  if (direction === 'diagonal') return 135
  return 180
}

async function readImageFile(
  file: File
): Promise<{ dataUrl: string; width: number; height: number }> {
  const dataUrl = await readFileAsDataUrl(file)
  const size = await readImageSize(dataUrl)
  return { dataUrl, ...size }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

function readImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const width = image.naturalWidth
      const height = image.naturalHeight
      if (width <= 0 || height <= 0) {
        reject(new Error('Unable to read image dimensions'))
        return
      }
      resolve({ width, height })
    }
    image.onerror = () => reject(new Error('Unable to read image dimensions'))
    image.src = dataUrl
  })
}

export default function PresentationWorkspacePage(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { itemId } = useParams()
  const openDocument = usePresentationWorkspaceStore((state) => state.openDocument)
  const activeDocument = usePresentationWorkspaceStore((state) => state.getActiveDocument())
  const [backgroundPanel, setBackgroundPanel] = useState({
    itemId: activeDocument?.itemId ?? null,
    isOpen: false
  })
  const [slideClipboard, setSlideClipboard] = useState<PresentationSlideClipboard | null>(null)
  const activeItemId = activeDocument?.itemId ?? null
  if (backgroundPanel.itemId !== activeItemId) {
    setBackgroundPanel({ itemId: activeItemId, isOpen: false })
  }
  useEffect(() => {
    if (!itemId) return
    const routeItemId = itemId
    let cancelled = false
    async function loadRouteDocument(): Promise<void> {
      await useFileExplorerStore.getState().initialize()
      const db = await openFileExplorerDB()
      const item = await db.get('folder-items', routeItemId)
      if (cancelled || !item || !isFileItem(item) || !isPresentationItem(item)) return
      openDocument(item)
    }
    void loadRouteDocument()
    return () => {
      cancelled = true
    }
  }, [itemId, openDocument])

  return (
    <WorkspaceShell className="w-0 min-w-full bg-background text-foreground">
      {activeDocument ? (
        activeDocument.mode === 'editable' ? (
          <EditableDocumentView
            deck={activeDocument}
            isBackgroundPanelOpen={backgroundPanel.isOpen}
            onBackgroundPanelOpenChange={(isOpen) =>
              setBackgroundPanel({ itemId: activeDocument.itemId, isOpen })
            }
            slideClipboard={slideClipboard}
            onSlideClipboardChange={setSlideClipboard}
          />
        ) : (
          <PptxDocumentView deck={activeDocument} />
        )
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <FileText size={44} className="text-default-400" />
          <div>
            <p className="text-base font-semibold">{t('presentationWorkspace.emptyTitle')}</p>
            <p className="mt-1 text-sm text-default-400">
              {t('presentationWorkspace.emptyDescription')}
            </p>
          </div>
          <Button variant="tertiary" onPress={() => navigate('/files')}>
            {t('presentationWorkspace.backToFiles')}
          </Button>
        </div>
      )}
    </WorkspaceShell>
  )
}
