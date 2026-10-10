import { useTranslation } from 'react-i18next'
import { loadPresentationFont } from '@renderer/lib/font-loader'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  EditablePresentationDocument,
  EditablePresentationElement,
  EditablePresentationSlide,
  EditableTextInsertFrame,
  EditableTextParagraph,
  EditableTextRun,
  EditableTextStyle
} from '@renderer/lib/editable-presentation'
import {
  CONTENT_HEIGHT_TEXT_PADDING_X,
  CONTENT_HEIGHT_TEXT_PADDING_Y,
  INSERTED_TEXT_CLICK_SIZE,
  INSERTED_TEXT_DRAG_MIN_SIZE,
  hasContentHeight,
  getSlideBackgroundCss,
  getSlideBackgroundPrimaryColor
} from '@renderer/lib/editable-presentation'
import {
  getPlainText,
  normalizeTextParagraphs,
  resolveTypingStyle
} from '@renderer/lib/presentation-rich-text'

interface EditableSlideSurfaceProps {
  document: EditablePresentationDocument
  slideId: string
  editable?: boolean
  showBorder?: boolean
  selectedElementId?: string | null
  selectedElementIds?: ReadonlySet<string>
  editingElementId?: string | null
  cropElementId?: string | null
  isTextInsertMode?: boolean
  className?: string
  onSelectElement?: (
    elementId: string | null,
    event?: React.MouseEvent | React.PointerEvent
  ) => void
  onMarqueeSelect?: (
    bounds: { x: number; y: number; width: number; height: number },
    additive: boolean
  ) => void
  onEditingElementChange?: (elementId: string | null) => void
  onTextEditFinalizerChange?: (finalize: TextEditFinalizer | null) => void
  onTextSelectionChange?: (selection: EditableTextSelection | null) => void
  onTextLayoutChange?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void
  onTextIndent?: (direction: -1 | 1) => void
  onInsertText?: (frame: EditableTextInsertFrame) => void
  onElementContextMenu?: (event: React.MouseEvent, element: EditablePresentationElement) => void
  onCanvasContextMenu?: (event: React.MouseEvent) => void
  onTransformStart?: (elementId: string) => EditablePresentationElement | undefined
  onTransformPreview?: (
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => boolean | void
  onTransformCommit?: () => void
  onTransformCancel?: () => void
  onUpdateElement?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void
}

export interface EditableTextSelection {
  elementId: string
  start: number
  end: number
}

export type TextEditFinalizer = (() => boolean) & {
  flush?: () => boolean
  restoreSelection?: () => void
  getSelection?: () => EditableTextSelection | null
  hasUnsafeWork?: () => boolean
  isComposing?: () => boolean
}

interface DragState {
  elementId: string
  mode: 'move' | 'resize' | 'crop' | 'rotate'
  handle?: ResizeHandle
  rotationOrigin?: { x: number; y: number; angle: number }
  startX: number
  startY: number
  original: EditablePresentationElement
  hasPersistedChanges: boolean
}

interface TextInsertState {
  pointerId: number
  startX: number
  startY: number
}

interface MarqueeState {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
}

type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const TEXT_MIN_WIDTH = 60
const TEXT_MIN_HEIGHT = 24
const TEXT_AUTO_MIN_WIDTH = INSERTED_TEXT_CLICK_SIZE.width
const TEXT_FRAME_HIT_AREA = 6
const MIN_ELEMENT_SIZE = 20
const MAX_CROP_TOTAL = 95
const RESIZE_HIT_TARGET_SIZE = 25
const RESIZE_INDICATOR_HIT_SIZE = 4
const TEXT_HANDLE_SIZE = 10
const IMAGE_HANDLE_SIZE = 16
const GENERIC_HANDLE_SIZE = 20

const IMAGE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CONTENT_TEXT_HANDLES: ResizeHandle[] = ['nw', 'w', 'sw', 'ne', 'e', 'se']
const FIXED_TEXT_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export default function EditableSlideSurface({
  document,
  slideId,
  editable = false,
  showBorder = false,
  selectedElementId = null,
  selectedElementIds,
  editingElementId = null,
  cropElementId = null,
  isTextInsertMode = false,
  className,
  onSelectElement,
  onMarqueeSelect,
  onEditingElementChange,
  onTextEditFinalizerChange,
  onTextSelectionChange,
  onTextLayoutChange,
  onTextIndent,
  onInsertText,
  onElementContextMenu,
  onCanvasContextMenu,
  onTransformStart,
  onTransformPreview,
  onTransformCommit,
  onTransformCancel,
  onUpdateElement
}: EditableSlideSurfaceProps): React.JSX.Element {
  const slide = document.slides[slideId]
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const textInsertRef = useRef<TextInsertState | null>(null)
  const marqueeRef = useRef<MarqueeState | null>(null)
  const textEditFinalizerRef = useRef<(() => boolean) | null>(null)
  const scaleRef = useRef({ x: 1, y: 1 })
  const [surfaceScale, setSurfaceScale] = useState(1)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)

  const setTextEditFinalizer = useCallback(
    (finalize: (() => boolean) | null): void => {
      textEditFinalizerRef.current = finalize
      onTextEditFinalizerChange?.(finalize)
    },
    [onTextEditFinalizerChange]
  )

  const finalizeTextEdit = (): boolean => textEditFinalizerRef.current?.() ?? true

  const orderedElements = useMemo(() => {
    if (!slide) return []
    return slide.elementOrder
      .map((elementId) => slide.elements[elementId])
      .filter((element): element is EditablePresentationElement => Boolean(element))
  }, [slide])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const updateScale = (): void => {
      const rect = surface.getBoundingClientRect()
      setSurfaceScale(normalizeSurfaceScale(rect.width / document.width))
    }
    updateScale()
    if (!('ResizeObserver' in window)) return
    const observer = new ResizeObserver(updateScale)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [document.width])

  if (!slide) {
    return <div className={`h-full w-full bg-black ${className ?? ''}`} />
  }

  const borderColor = getReadableBorderColor(getSlideBackgroundPrimaryColor(slide.background))

  const startDrag = (
    event: React.PointerEvent,
    element: EditablePresentationElement,
    mode: DragState['mode'],
    handle?: ResizeHandle
  ): void => {
    if (!editable || element.locked) return
    if (!finalizeTextEdit()) return
    event.preventDefault()
    event.stopPropagation()
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      scaleRef.current = {
        x: document.width / rect.width,
        y: document.height / rect.height
      }
    }
    onEditingElementChange?.(null)
    const original = onTransformStart ? onTransformStart(element.id) : element
    if (!original) return
    onSelectElement?.(element.id, event)
    dragRef.current = {
      elementId: element.id,
      mode,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      original,
      hasPersistedChanges: false,
      rotationOrigin: rect
        ? {
            x: rect.left + (original.x + original.width / 2) / scaleRef.current.x,
            y: rect.top + (original.y + original.height / 2) / scaleRef.current.y,
            angle: Math.atan2(
              event.clientY - rect.top - (original.y + original.height / 2) / scaleRef.current.y,
              event.clientX - rect.left - (original.x + original.width / 2) / scaleRef.current.x
            )
          }
        : undefined
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const updateDrag = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    event.preventDefault()
    const dx = (event.clientX - drag.startX) * scaleRef.current.x
    const dy = (event.clientY - drag.startY) * scaleRef.current.y
    let updates: Partial<EditablePresentationElement>
    if (drag.mode === 'rotate' && drag.rotationOrigin) {
      const origin = drag.rotationOrigin
      const angle = Math.atan2(event.clientY - origin.y, event.clientX - origin.x)
      const degrees = drag.original.rotation + ((angle - origin.angle) * 180) / Math.PI
      const rotation = event.shiftKey
        ? Math.round(degrees / 15) * 15
        : Math.round(degrees * 100) / 100
      updates = { rotation: ((rotation % 360) + 360) % 360 }
    } else if (drag.mode === 'move') {
      updates = {
        x: drag.original.x + dx,
        y: drag.original.y + dy
      } as Partial<EditablePresentationElement>
    } else if (drag.mode === 'crop' && drag.original.type === 'image' && drag.handle) {
      updates = {
        crop: calculateImageCrop(drag.original.crop, drag.handle, dx, dy, drag.original)
      } as Partial<EditablePresentationElement>
    } else if (drag.original.type === 'text' && drag.handle) {
      updates = {
        ...calculateTextResize(drag.original, drag.handle, dx, dy),
        autoWidth: false,
        autoSize: hasContentHeight(drag.original) ? 'content' : 'fixed'
      } as Partial<EditablePresentationElement>
    } else if (drag.original.type === 'image' && drag.handle) {
      updates = calculateImageResize(
        drag.original,
        drag.handle,
        dx,
        dy
      ) as Partial<EditablePresentationElement>
    } else {
      updates = {
        width: Math.max(MIN_ELEMENT_SIZE, drag.original.width + dx),
        height: Math.max(MIN_ELEMENT_SIZE, drag.original.height + dy)
      } as Partial<EditablePresentationElement>
    }
    const rawHasPersistedChanges = hasElementPatchChanges(drag.original, updates)
    if (onTransformPreview) {
      drag.hasPersistedChanges =
        onTransformPreview(drag.elementId, updates) ?? rawHasPersistedChanges
    } else if (rawHasPersistedChanges) {
      drag.hasPersistedChanges = true
      onUpdateElement?.(slideId, drag.elementId, updates)
    } else {
      drag.hasPersistedChanges = false
    }
  }

  const resizeWithKeyboard = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    element: EditablePresentationElement,
    handle: ResizeHandle,
    mode: 'resize' | 'crop'
  ): void => {
    const delta = getKeyboardResizeDelta(
      event,
      handle,
      element.type === 'text' && hasContentHeight(element)
    )
    if (!delta || !finalizeTextEdit()) return
    const original = onTransformStart ? onTransformStart(element.id) : element
    if (!original) return

    let updates: Partial<EditablePresentationElement>
    if (mode === 'crop' && original.type === 'image') {
      updates = {
        crop: calculateImageCrop(original.crop, handle, delta.dx, delta.dy, original)
      } as Partial<EditablePresentationElement>
    } else if (original.type === 'text') {
      updates = {
        ...calculateTextResize(
          original,
          handle,
          delta.dx * Math.cos((original.rotation * Math.PI) / 180) -
            delta.dy * Math.sin((original.rotation * Math.PI) / 180),
          delta.dx * Math.sin((original.rotation * Math.PI) / 180) +
            delta.dy * Math.cos((original.rotation * Math.PI) / 180)
        ),
        autoWidth: false,
        autoSize: hasContentHeight(original) ? 'content' : 'fixed'
      } as Partial<EditablePresentationElement>
    } else if (original.type === 'image') {
      updates = calculateImageResize(
        original,
        handle,
        delta.dx,
        delta.dy
      ) as Partial<EditablePresentationElement>
    } else {
      updates = {
        width: Math.max(MIN_ELEMENT_SIZE, original.width + delta.dx),
        height: Math.max(MIN_ELEMENT_SIZE, original.height + delta.dy)
      } as Partial<EditablePresentationElement>
    }

    event.preventDefault()
    event.stopPropagation()
    onEditingElementChange?.(null)
    const rawHasPersistedChanges = hasElementPatchChanges(original, updates)
    const hasPersistedChanges = onTransformPreview
      ? (onTransformPreview(element.id, updates) ?? rawHasPersistedChanges)
      : rawHasPersistedChanges
    if (!hasPersistedChanges) {
      onTransformCancel?.()
      return
    }
    if (!onTransformPreview) onUpdateElement?.(slideId, element.id, updates)
    onTransformCommit?.()
  }

  const endDrag = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.hasPersistedChanges) onTransformCommit?.()
    else onTransformCancel?.()
  }

  const cancelDrag = (event: React.PointerEvent): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onTransformCancel?.()
  }

  const getCanvasPoint = (
    event: React.PointerEvent | React.MouseEvent
  ): { x: number; y: number } | null => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    const scaleX = document.width / rect.width
    const scaleY = document.height / rect.height
    return {
      x: Math.max(0, Math.min(document.width, (event.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(document.height, (event.clientY - rect.top) * scaleY))
    }
  }

  const startTextInsert = (event: React.PointerEvent): boolean => {
    if (!editable || !isTextInsertMode || !onInsertText) return false
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-slide-element]')) return false
    const point = getCanvasPoint(event)
    if (!point) return false

    if (!finalizeTextEdit()) return true

    event.preventDefault()
    event.stopPropagation()
    textInsertRef.current = { pointerId: event.pointerId, startX: point.x, startY: point.y }
    onEditingElementChange?.(null)
    onSelectElement?.(null)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    return true
  }

  const finishTextInsert = (event: React.PointerEvent): void => {
    const insert = textInsertRef.current
    if (!insert || insert.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    textInsertRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const point = getCanvasPoint(event)
    if (!point) return
    const dx = point.x - insert.startX
    const dy = point.y - insert.startY
    const isDrag = Math.abs(dx) >= 1 || Math.abs(dy) >= 1
    if (!isDrag) {
      onInsertText?.({
        x: Math.max(0, Math.min(document.width - INSERTED_TEXT_CLICK_SIZE.width, insert.startX)),
        y: Math.max(0, Math.min(document.height - INSERTED_TEXT_CLICK_SIZE.height, insert.startY)),
        width: INSERTED_TEXT_CLICK_SIZE.width,
        height: INSERTED_TEXT_CLICK_SIZE.height,
        autoSize: 'content',
        autoWidth: true
      })
      return
    }

    const width = Math.max(INSERTED_TEXT_DRAG_MIN_SIZE.width, Math.abs(dx))
    const height = Math.max(INSERTED_TEXT_DRAG_MIN_SIZE.height, Math.abs(dy))
    const x = dx < 0 ? insert.startX - width : insert.startX
    const y = dy < 0 ? insert.startY - height : insert.startY
    onInsertText?.({
      x: Math.max(0, Math.min(document.width - width, x)),
      y: Math.max(0, Math.min(document.height - height, y)),
      width,
      height,
      autoSize: 'content',
      autoWidth: false
    })
  }

  const startMarquee = (event: React.PointerEvent): void => {
    if (!editable || !onMarqueeSelect || isTextInsertMode) return
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-slide-element]')) return
    const point = getCanvasPoint(event)
    if (!point) return
    const next: MarqueeState = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      additive: event.metaKey || event.ctrlKey
    }
    marqueeRef.current = next
    setMarquee(next)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const updateMarquee = (event: React.PointerEvent): void => {
    const current = marqueeRef.current
    if (!current || current.pointerId !== event.pointerId) return
    const point = getCanvasPoint(event)
    if (!point) return
    const next = { ...current, currentX: point.x, currentY: point.y }
    marqueeRef.current = next
    setMarquee(next)
  }

  const finishMarquee = (event: React.PointerEvent): void => {
    const current = marqueeRef.current
    if (!current || current.pointerId !== event.pointerId) return
    marqueeRef.current = null
    setMarquee(null)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const x = Math.min(current.startX, current.currentX)
    const y = Math.min(current.startY, current.currentY)
    const width = Math.abs(current.currentX - current.startX)
    const height = Math.abs(current.currentY - current.startY)
    if (width >= 4 || height >= 4) {
      onMarqueeSelect?.({ x, y, width, height }, current.additive)
    }
  }

  const insertTextAtPointer = (event: React.MouseEvent): void => {
    if (!editable || !onInsertText) return
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-slide-element]')) return
    const point = getCanvasPoint(event)
    if (!point) return
    event.preventDefault()
    onInsertText({
      x: Math.max(0, Math.min(document.width - INSERTED_TEXT_CLICK_SIZE.width, point.x)),
      y: Math.max(0, Math.min(document.height - INSERTED_TEXT_CLICK_SIZE.height, point.y)),
      width: INSERTED_TEXT_CLICK_SIZE.width,
      height: INSERTED_TEXT_CLICK_SIZE.height,
      autoSize: 'content',
      autoWidth: true
    })
  }

  return (
    <div
      data-slide-surface
      ref={surfaceRef}
      tabIndex={-1}
      className={`relative aspect-video w-full overflow-visible bg-black ${
        isTextInsertMode ? 'cursor-crosshair' : ''
      } ${className ?? ''}`}
      style={{
        background: getSlideBackgroundCss(slide.background),
        aspectRatio: `${document.width} / ${document.height}`,
        border: showBorder ? `1px solid ${borderColor}` : undefined
      }}
      onPointerDown={(event) => {
        if (!editable) return
        if (startTextInsert(event)) return
        if (!finalizeTextEdit()) return
        onEditingElementChange?.(null)
        if (!(event.metaKey || event.ctrlKey)) onSelectElement?.(null, event)
        startMarquee(event)
      }}
      onPointerMove={updateMarquee}
      onPointerUp={(event) => {
        finishTextInsert(event)
        finishMarquee(event)
      }}
      onPointerCancel={(event) => {
        marqueeRef.current = null
        setMarquee(null)
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onDoubleClick={insertTextAtPointer}
      onContextMenu={onCanvasContextMenu}
    >
      <div
        data-slide-content
        className="absolute inset-0 overflow-hidden"
        style={{ borderRadius: 'inherit' }}
      >
        <div
          className="absolute left-0 top-0"
          style={{
            width: document.width,
            height: document.height,
            transform: `scale(${surfaceScale})`,
            transformOrigin: 'top left'
          }}
        >
          {orderedElements.map((element) => (
            <SlideElement
              key={element.id}
              document={document}
              slide={slide}
              element={element}
              editable={editable}
              editing={element.id === editingElementId}
              onSelect={(event) => onSelectElement?.(element.id, event)}
              onPointerDown={(event) => startDrag(event, element, 'move')}
              onPointerMove={updateDrag}
              onPointerUp={endDrag}
              onPointerCancel={cancelDrag}
              onContextMenu={(event) => onElementContextMenu?.(event, element)}
              onUpdateElement={onUpdateElement}
              onStartTextEdit={() => {
                onSelectElement?.(element.id)
                onEditingElementChange?.(element.id)
              }}
              onFinishTextEdit={() => onEditingElementChange?.(null)}
              onTextEditFinalizerChange={setTextEditFinalizer}
              onTextSelectionChange={onTextSelectionChange}
              onTextLayoutChange={onTextLayoutChange}
              onTextIndent={onTextIndent}
            />
          ))}
          {marquee && (
            <div
              data-testid="element-marquee"
              className="pointer-events-none absolute border border-accent bg-accent/15"
              style={{
                left: Math.min(marquee.startX, marquee.currentX),
                top: Math.min(marquee.startY, marquee.currentY),
                width: Math.abs(marquee.currentX - marquee.startX),
                height: Math.abs(marquee.currentY - marquee.startY)
              }}
            />
          )}
        </div>
      </div>
      <div
        data-selection-layer
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        style={{
          width: document.width,
          height: document.height,
          transform: `scale(${surfaceScale})`,
          transformOrigin: 'top left'
        }}
      >
        {orderedElements.map((element) => {
          const selected =
            element.id === selectedElementId || Boolean(selectedElementIds?.has(element.id))
          if (!selected) return null
          return (
            <SelectionChrome
              key={`selection-${element.id}`}
              element={element}
              cropMode={element.id === cropElementId}
              surfaceScale={surfaceScale}
              showHandles={editable && element.id === selectedElementId && !element.locked}
              onRotatePointerDown={(event) => startDrag(event, element, 'rotate')}
              onRotateKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !finalizeTextEdit()) return
                event.preventDefault()
                event.stopPropagation()
                const original = onTransformStart ? onTransformStart(element.id) : element
                if (!original) return
                const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 15 : 1)
                const updates = { rotation: (original.rotation + delta + 360) % 360 }
                if (onTransformPreview) {
                  onTransformPreview(element.id, updates)
                  onTransformCommit?.()
                } else onUpdateElement?.(slideId, element.id, updates)
              }}
              onMovePointerDown={(event) => startDrag(event, element, 'move')}
              onResizePointerDown={(event, handle) => startDrag(event, element, 'resize', handle)}
              onCropPointerDown={(event, handle) => startDrag(event, element, 'crop', handle)}
              onResizeKeyDown={(event, handle) =>
                resizeWithKeyboard(event, element, handle, 'resize')
              }
              onCropKeyDown={(event, handle) => resizeWithKeyboard(event, element, handle, 'crop')}
              onPointerMove={updateDrag}
              onPointerUp={endDrag}
              onPointerCancel={cancelDrag}
            />
          )
        })}
      </div>
    </div>
  )
}

function getReadableBorderColor(color: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color.trim())
  if (!match) return '#ffffff'
  const red = parseInt(match[1], 16)
  const green = parseInt(match[2], 16)
  const blue = parseInt(match[3], 16)
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  return luminance > 0.55 ? '#000000' : '#ffffff'
}

function SlideElement({
  document,
  slide,
  element,
  editable,
  editing,
  onSelect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onContextMenu,
  onUpdateElement,
  onStartTextEdit,
  onFinishTextEdit,
  onTextEditFinalizerChange,
  onTextSelectionChange,
  onTextLayoutChange,
  onTextIndent
}: {
  document: EditablePresentationDocument
  slide: EditablePresentationSlide
  element: EditablePresentationElement
  editable: boolean
  editing: boolean
  onSelect: (event: React.MouseEvent) => void
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onPointerCancel: (event: React.PointerEvent) => void
  onContextMenu?: (event: React.MouseEvent) => void
  onUpdateElement?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void
  onStartTextEdit: () => void
  onFinishTextEdit: () => void
  onTextEditFinalizerChange: (finalize: TextEditFinalizer | null) => void
  onTextSelectionChange?: (selection: EditableTextSelection | null) => void
  onTextLayoutChange?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void
  onTextIndent?: (direction: -1 | 1) => void
}): React.JSX.Element {
  const commonStyle: React.CSSProperties = {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: `rotate(${element.rotation}deg)`,
    opacity: element.opacity
  }

  return (
    <div
      data-slide-element
      className={`absolute ${editable ? 'cursor-move' : ''}`}
      style={commonStyle}
      onPointerDown={(event) => {
        if (editing) return
        onPointerDown(event)
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(event) => {
        event.stopPropagation()
        onContextMenu?.(event)
      }}
      onClick={(event) => {
        if (!editable) return
        event.stopPropagation()
        onSelect(event)
      }}
    >
      {renderElementContent(
        element,
        document,
        slide.id,
        editable,
        editing,
        onUpdateElement,
        onStartTextEdit,
        onFinishTextEdit,
        onTextEditFinalizerChange,
        onTextSelectionChange,
        onTextLayoutChange,
        onTextIndent
      )}
    </div>
  )
}

function SelectionChrome({
  element,
  cropMode,
  surfaceScale,
  showHandles,
  onRotatePointerDown,
  onRotateKeyDown,
  onMovePointerDown,
  onResizePointerDown,
  onCropPointerDown,
  onResizeKeyDown,
  onCropKeyDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel
}: {
  element: EditablePresentationElement
  cropMode: boolean
  surfaceScale: number
  showHandles: boolean
  onRotatePointerDown: (event: React.PointerEvent) => void
  onRotateKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  onMovePointerDown: (event: React.PointerEvent) => void
  onResizePointerDown: (event: React.PointerEvent, handle: ResizeHandle) => void
  onCropPointerDown: (event: React.PointerEvent, handle: ResizeHandle) => void
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, handle: ResizeHandle) => void
  onCropKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, handle: ResizeHandle) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onPointerCancel: (event: React.PointerEvent) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      data-selection-chrome
      className="pointer-events-none absolute outline-solid"
      style={{
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
        transform: `rotate(${element.rotation}deg)`,
        outlineWidth: 1 / surfaceScale,
        outlineOffset: `${2 / surfaceScale}px`,
        outlineColor: '#737373'
      }}
      onPointerDownCapture={(event) => {
        const handle = getNearestResizeHandle(event)
        if (!handle) return
        if (cropMode && element.type === 'image') onCropPointerDown(event, handle)
        else onResizePointerDown(event, handle)
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {showHandles && !cropMode && (
        <>
          <span
            aria-hidden="true"
            className="absolute bg-neutral-500"
            style={{
              left: '50%',
              top: -24 / surfaceScale,
              width: 1 / surfaceScale,
              height: 24 / surfaceScale
            }}
          />
          <button
            type="button"
            data-rotation-handle
            aria-label={t('presentationWorkspace.rotateObject', 'Rotate object')}
            className="pointer-events-auto absolute flex cursor-grab items-center justify-center rounded-full border border-neutral-500 bg-white text-neutral-600 shadow-sm"
            style={{
              left: '50%',
              top: -34 / surfaceScale,
              width: 20 / surfaceScale,
              height: 20 / surfaceScale,
              fontSize: 17 / surfaceScale,
              transform: 'translateX(-50%)',
              touchAction: 'none'
            }}
            onPointerDown={onRotatePointerDown}
            onKeyDown={onRotateKeyDown}
          >
            ↻
          </button>
        </>
      )}
      {showHandles && (
        <ElementHandles
          element={element}
          cropMode={cropMode}
          surfaceScale={surfaceScale}
          onMovePointerDown={onMovePointerDown}
          onResizeKeyDown={onResizeKeyDown}
          onCropKeyDown={onCropKeyDown}
        />
      )}
    </div>
  )
}

function ElementHandles({
  element,
  cropMode,
  surfaceScale,
  onMovePointerDown,
  onResizeKeyDown,
  onCropKeyDown
}: {
  element: EditablePresentationElement
  cropMode: boolean
  surfaceScale: number
  onMovePointerDown: (event: React.PointerEvent) => void
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, handle: ResizeHandle) => void
  onCropKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, handle: ResizeHandle) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (element.type === 'text') {
    const handles = hasContentHeight(element) ? CONTENT_TEXT_HANDLES : FIXED_TEXT_HANDLES
    const edgeSize = TEXT_FRAME_HIT_AREA / surfaceScale
    const hitTargetSize = RESIZE_HIT_TARGET_SIZE / surfaceScale
    const indicatorHitSize = RESIZE_INDICATOR_HIT_SIZE / surfaceScale
    const handleSize = TEXT_HANDLE_SIZE / surfaceScale
    const borderWidth = 1 / surfaceScale
    return (
      <>
        {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
          <div
            key={`move-text-${edge}`}
            data-text-frame-edge={edge}
            data-testid={`text-frame-edge-${edge}`}
            className="pointer-events-auto absolute cursor-move"
            style={{
              zIndex: 10,
              touchAction: 'none',
              ...(edge === 'top' || edge === 'bottom'
                ? {
                    left: 0,
                    width: '100%',
                    height: edgeSize,
                    [edge]: -edgeSize
                  }
                : {
                    top: 0,
                    width: edgeSize,
                    height: '100%',
                    [edge]: -edgeSize
                  })
            }}
            onPointerDown={onMovePointerDown}
          />
        ))}
        {handles.map((handle) => (
          <button
            key={`resize-text-${handle}`}
            type="button"
            data-resize-handle={handle}
            className={`${hasContentHeight(element) ? 'cursor-ew-resize' : getHandleCursorClass(handle)} pointer-events-auto absolute flex items-center justify-center`}
            aria-label={t('presentationWorkspace.resizeTextBox', {
              direction: t(`presentationWorkspace.handleDirection.${handle}`)
            })}
            style={{
              ...getTextHandlePositionStyle(handle, hitTargetSize),
              zIndex: 20,
              width: hitTargetSize,
              height: hitTargetSize,
              touchAction: 'none'
            }}
            onKeyDown={(event) => onResizeKeyDown(event, handle)}
          >
            <span
              data-resize-handle-indicator
              aria-hidden="true"
              className="pointer-events-auto absolute"
              style={{
                ...getHandleIndicatorPositionStyle(handle, indicatorHitSize),
                width: indicatorHitSize,
                height: indicatorHitSize
              }}
            >
              <span
                data-resize-handle-visual
                className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border-neutral-500 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
                style={{ width: handleSize, height: handleSize, borderWidth }}
              />
            </span>
          </button>
        ))}
      </>
    )
  }

  if (element.type === 'image') {
    const hitTargetSize = RESIZE_HIT_TARGET_SIZE / surfaceScale
    const indicatorHitSize = RESIZE_INDICATOR_HIT_SIZE / surfaceScale
    const handleSize = IMAGE_HANDLE_SIZE / surfaceScale
    const borderWidth = 1 / surfaceScale
    return (
      <>
        {cropMode && (
          <div className="pointer-events-none absolute inset-0 border border-dashed border-warning" />
        )}
        {IMAGE_HANDLES.map((handle) => (
          <button
            key={`${cropMode ? 'crop' : 'resize'}-${handle}`}
            type="button"
            data-resize-handle={handle}
            className={`${getHandleCursorClass(handle)} pointer-events-auto absolute flex items-center justify-center rounded-full`}
            aria-label={t(
              cropMode ? 'presentationWorkspace.cropImage' : 'presentationWorkspace.resizeImage',
              { direction: t(`presentationWorkspace.handleDirection.${handle}`) }
            )}
            style={{
              ...getTextHandlePositionStyle(handle, hitTargetSize),
              zIndex: 20,
              width: hitTargetSize,
              height: hitTargetSize,
              touchAction: 'none'
            }}
            onKeyDown={(event) =>
              cropMode ? onCropKeyDown(event, handle) : onResizeKeyDown(event, handle)
            }
          >
            <span
              data-resize-handle-indicator
              aria-hidden="true"
              className="pointer-events-auto absolute"
              style={{
                ...getHandleIndicatorPositionStyle(handle, indicatorHitSize),
                width: indicatorHitSize,
                height: indicatorHitSize
              }}
            >
              <span
                data-resize-handle-visual
                className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white ${
                  cropMode ? 'bg-warning' : 'bg-accent'
                }`}
                style={{ width: handleSize, height: handleSize, borderWidth }}
              />
            </span>
          </button>
        ))}
      </>
    )
  }

  const hitTargetSize = RESIZE_HIT_TARGET_SIZE / surfaceScale
  const indicatorHitSize = RESIZE_INDICATOR_HIT_SIZE / surfaceScale
  const handleSize = GENERIC_HANDLE_SIZE / surfaceScale
  const borderWidth = 1 / surfaceScale
  return (
    <button
      type="button"
      data-resize-handle="se"
      className="pointer-events-auto absolute flex cursor-nwse-resize items-center justify-center rounded-full"
      aria-label={t('presentationWorkspace.resizeElement')}
      style={{
        ...getTextHandlePositionStyle('se', hitTargetSize),
        zIndex: 20,
        width: hitTargetSize,
        height: hitTargetSize,
        touchAction: 'none'
      }}
      onKeyDown={(event) => onResizeKeyDown(event, 'se')}
    >
      <span
        data-resize-handle-indicator
        aria-hidden="true"
        className="pointer-events-auto absolute"
        style={{
          ...getHandleIndicatorPositionStyle('se', indicatorHitSize),
          width: indicatorHitSize,
          height: indicatorHitSize
        }}
      >
        <span
          data-resize-handle-visual
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-accent"
          style={{ width: handleSize, height: handleSize, borderWidth }}
        />
      </span>
    </button>
  )
}

function renderElementContent(
  element: EditablePresentationElement,
  document: EditablePresentationDocument,
  slideId: string,
  editable: boolean,
  editing: boolean,
  onUpdateElement?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void,
  onStartTextEdit?: () => void,
  onFinishTextEdit?: () => void,
  onTextEditFinalizerChange?: (finalize: TextEditFinalizer | null) => void,
  onTextSelectionChange?: (selection: EditableTextSelection | null) => void,
  onTextLayoutChange?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void,
  onTextIndent?: (direction: -1 | 1) => void
): React.ReactNode {
  if (element.type === 'text') {
    return (
      <TextElementContent
        element={element}
        slideId={slideId}
        editable={editable}
        editing={editing}
        onUpdateElement={onUpdateElement}
        onStartTextEdit={onStartTextEdit}
        onFinishTextEdit={onFinishTextEdit}
        onTextEditFinalizerChange={onTextEditFinalizerChange}
        onTextSelectionChange={onTextSelectionChange}
        onTextLayoutChange={onTextLayoutChange}
        onTextIndent={onTextIndent}
      />
    )
  }

  if (element.type === 'image') {
    const asset = document.assets[element.assetId]
    return asset ? (
      <ImageElementContent element={element} asset={asset} />
    ) : (
      <div className="flex h-full w-full items-center justify-center bg-default-100 text-xs text-default-500">
        Missing image
      </div>
    )
  }

  if (element.type === 'shape') {
    return (
      <div
        className="h-full w-full"
        style={{
          backgroundColor: element.fillColor,
          border: `${element.strokeWidth}px solid ${element.strokeColor}`,
          borderRadius: element.shape === 'ellipse' ? '9999px' : 0
        }}
      />
    )
  }

  if (element.type === 'line') {
    return (
      <div
        className="absolute left-0 top-1/2 w-full"
        style={{
          borderTop: `${element.strokeWidth}px solid ${element.strokeColor}`
        }}
      />
    )
  }

  return (
    <div className="flex h-full w-full items-center justify-center rounded border border-dashed border-warning bg-warning/20 p-2 text-center text-xs text-warning-foreground">
      {element.label}
    </div>
  )
}

function ImageElementContent({
  element,
  asset
}: {
  element: Extract<EditablePresentationElement, { type: 'image' }>
  asset: { name: string; dataUrl: string }
}): React.JSX.Element {
  const crop = normalizeImageCrop(element.crop)
  const visibleWidth = Math.max(1, 100 - crop.left - crop.right)
  const visibleHeight = Math.max(1, 100 - crop.top - crop.bottom)

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        border:
          element.borderWidth && element.borderWidth > 0
            ? `${element.borderWidth}px solid ${element.borderColor ?? '#ffffff'}`
            : undefined,
        boxShadow: getImageShadow(element.shadow)
      }}
    >
      <img
        src={asset.dataUrl}
        alt={asset.name}
        className="absolute max-w-none object-fill"
        draggable={false}
        style={{
          left: `${-(crop.left / visibleWidth) * 100}%`,
          top: `${-(crop.top / visibleHeight) * 100}%`,
          width: `${(100 / visibleWidth) * 100}%`,
          height: `${(100 / visibleHeight) * 100}%`
        }}
      />
    </div>
  )
}

function calculateTextResize(
  element: Extract<EditablePresentationElement, { type: 'text' }>,
  handle: ResizeHandle,
  dx: number,
  dy: number
): Partial<EditablePresentationElement> {
  const radians = (element.rotation * Math.PI) / 180
  const localX = dx * Math.cos(radians) + dy * Math.sin(radians)
  const localY = -dx * Math.sin(radians) + dy * Math.cos(radians)
  const hasWest = handle.includes('w')
  const hasEast = handle.includes('e')
  const hasNorth = handle.includes('n')
  const hasSouth = handle.includes('s')
  const width = Math.max(TEXT_MIN_WIDTH, element.width + (hasEast ? localX : hasWest ? -localX : 0))
  const height = hasContentHeight(element)
    ? element.height
    : Math.max(TEXT_MIN_HEIGHT, element.height + (hasSouth ? localY : hasNorth ? -localY : 0))
  const centerX = ((width - element.width) / 2) * (hasWest ? -1 : 1)
  const centerY = ((height - element.height) / 2) * (hasNorth ? -1 : 1)
  return {
    x:
      element.x +
      element.width / 2 +
      centerX * Math.cos(radians) -
      centerY * Math.sin(radians) -
      width / 2,
    ...(hasContentHeight(element) && element.rotation === 0
      ? {}
      : {
          y:
            element.y +
            element.height / 2 +
            centerX * Math.sin(radians) +
            centerY * Math.cos(radians) -
            height / 2
        }),
    width,
    ...(hasContentHeight(element) ? {} : { height })
  }
}

function hasElementPatchChanges(
  element: EditablePresentationElement,
  updates: Partial<EditablePresentationElement>
): boolean {
  return Object.entries(updates).some(([key, value]) => {
    if (key !== 'crop') {
      return !Object.is(element[key as keyof EditablePresentationElement], value)
    }
    if (element.type !== 'image') return true
    const current = normalizeImageCrop(element.crop)
    const next = normalizeImageCrop(
      value as Extract<EditablePresentationElement, { type: 'image' }>['crop']
    )
    return (
      current.top !== next.top ||
      current.right !== next.right ||
      current.bottom !== next.bottom ||
      current.left !== next.left
    )
  })
}

function isContentAutoSizedText(
  element: Extract<EditablePresentationElement, { type: 'text' }>
): boolean {
  return hasContentHeight(element)
}

function measureAutoSizedTextElement(
  source: HTMLDivElement | null,
  element: Extract<EditablePresentationElement, { type: 'text' }>,
  text: string
): Partial<EditablePresentationElement> {
  if (!source || !window.document.body) return {}
  const measure = source.cloneNode(true) as HTMLDivElement
  if (!measure.childNodes.length) measure.textContent = text || ' '
  Object.assign(measure.style, {
    position: 'absolute',
    left: '-10000px',
    top: '-10000px',
    width: 'auto',
    height: 'auto',
    minWidth: '0',
    maxWidth: 'none',
    overflow: 'visible',
    pointerEvents: 'none',
    visibility: 'hidden',
    whiteSpace: 'pre'
  })
  window.document.body.appendChild(measure)

  const width =
    element.autoWidth === true
      ? Math.max(TEXT_AUTO_MIN_WIDTH, Math.ceil(measure.scrollWidth))
      : element.width
  measure.style.width = `${width}px`
  measure.style.whiteSpace = 'pre-wrap'
  measure.style.overflowWrap = 'break-word'
  const height = Math.max(
    Math.ceil(element.fontSize * element.lineHeight),
    Math.ceil(measure.scrollHeight)
  )
  measure.remove()

  const updates: Partial<EditablePresentationElement> = {}
  if (element.autoWidth === true && Math.abs(width - element.width) >= 1) updates.width = width
  if (hasContentHeight(element) && Math.abs(height - element.height) >= 1) {
    updates.height = height
  }
  return updates
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

function createCaretRangeFromPoint(x: number, y: number, content: HTMLElement): Range | null {
  const ownerDocument = window.document as CaretDocument
  const position = ownerDocument.caretPositionFromPoint?.(x, y)
  if (position && content.contains(position.offsetNode)) {
    const range = ownerDocument.createRange()
    range.setStart(position.offsetNode, position.offset)
    range.collapse(true)
    return range
  }

  const range = ownerDocument.caretRangeFromPoint?.(x, y) ?? null
  return range && content.contains(range.startContainer) ? range : null
}

function TextElementContent({
  element,
  slideId,
  editable,
  editing,
  onUpdateElement,
  onStartTextEdit,
  onFinishTextEdit,
  onTextEditFinalizerChange,
  onTextSelectionChange,
  onTextLayoutChange,
  onTextIndent
}: {
  element: Extract<EditablePresentationElement, { type: 'text' }>
  slideId: string
  editable: boolean
  editing: boolean
  onUpdateElement?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void
  onStartTextEdit?: () => void
  onFinishTextEdit?: () => void
  onTextEditFinalizerChange?: (finalize: TextEditFinalizer | null) => void
  onTextSelectionChange?: (selection: EditableTextSelection | null) => void
  onTextLayoutChange?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void
  onTextIndent?: (direction: -1 | 1) => void
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const editingRef = useRef(editing)
  const finalizeTextEditRef = useRef<() => boolean>(() => true)
  const flushTextRef = useRef<() => boolean>(() => true)
  const initializedEditingElementRef = useRef<string | null>(null)
  const blurFrameRef = useRef<number | null>(null)
  const textFrameRef = useRef<number | null>(null)
  const pendingBlurTextRef = useRef<string | null>(null)
  const hasPendingTextRef = useRef(false)
  const pendingCaretPointRef = useRef<{ x: number; y: number } | null>(null)
  const registeredFinalizerRef = useRef<TextEditFinalizer | null>(null)
  const measuredLayoutRef = useRef<unknown[]>([])
  const contentHeight = hasContentHeight(element)
  const paragraphs = useMemo(() => normalizeTextParagraphs(element), [element])
  const hasRichText = Boolean(element.paragraphs?.length || element.runs?.length)
  const [template] = useState(() => window.document.createElement('div'))
  const domParagraphsRef = useRef(paragraphs)
  const domModelRef = useRef<string | null>(null)
  const retainedSelectionRef = useRef<{ anchor: number; focus: number } | null>(null)

  const fontKey = JSON.stringify([
    ...new Set([
      element.fontFamily,
      ...paragraphs.flatMap((paragraph) => paragraph.runs.map((run) => run.fontFamily))
    ])
  ])
  const [loadedFontKey, setLoadedFontKey] = useState('')
  useEffect(() => {
    let active = true
    const families: string[] = JSON.parse(fontKey)
    void Promise.allSettled(families.map(loadPresentationFont)).then(() => {
      if (active) setLoadedFontKey(fontKey)
    })
    return () => {
      active = false
    }
  }, [fontKey])

  const notifyTextEditLifecycle = useCallback((): void => {
    onTextEditFinalizerChange?.(registeredFinalizerRef.current)
  }, [onTextEditFinalizerChange])

  const settlePendingText = (): void => {
    if (isComposingRef.current || !hasPendingTextRef.current) return
    scheduleTextCommit()
  }

  const cancelPendingBlur = (): void => {
    if (blurFrameRef.current == null) return
    window.cancelAnimationFrame(blurFrameRef.current)
    blurFrameRef.current = null
    pendingBlurTextRef.current = null
    settlePendingText()
  }

  const commitText = (): void => {
    const content = contentRef.current
    if (!content) return
    if (!hasPendingTextRef.current) {
      notifyTextEditLifecycle()
      return
    }
    const nextParagraphs = serializeTextContent(content, domParagraphsRef.current)
    const text = getPlainText(nextParagraphs)
    if (text === element.text && JSON.stringify(nextParagraphs) === JSON.stringify(paragraphs)) {
      hasPendingTextRef.current = false
      notifyTextEditLifecycle()
      return
    }
    if (
      nextParagraphs.length === domParagraphsRef.current.length &&
      !domParagraphsRef.current.some((paragraph) => paragraph.typingStyleCaret !== undefined)
    ) {
      domModelRef.current = JSON.stringify(nextParagraphs)
    }
    onUpdateElement?.(slideId, element.id, {
      text,
      runs: nextParagraphs.flatMap((paragraph, index) =>
        paragraph.runs.map((run, runIndex) => ({
          ...run,
          text: `${index > 0 && runIndex === 0 ? '\n' : ''}${run.text}`
        }))
      ),
      paragraphs: nextParagraphs,
      ...(isContentAutoSizedText(element)
        ? measureAutoSizedTextElement(contentRef.current, element, text)
        : {})
    } as Partial<EditablePresentationElement>)
    hasPendingTextRef.current = false
    notifyTextEditLifecycle()
  }

  const cancelPendingTextCommit = (): void => {
    if (textFrameRef.current == null) return
    window.cancelAnimationFrame(textFrameRef.current)
    textFrameRef.current = null
  }

  const scheduleTextCommit = (): void => {
    cancelPendingTextCommit()
    textFrameRef.current = window.requestAnimationFrame(() => {
      textFrameRef.current = null
      if (isComposingRef.current) return
      const content = contentRef.current
      if (content) commitText()
    })
  }

  const scheduleBlurCommit = (): void => {
    if (blurFrameRef.current != null) window.cancelAnimationFrame(blurFrameRef.current)
    blurFrameRef.current = window.requestAnimationFrame(() => {
      blurFrameRef.current = null
      const content = contentRef.current
      if (!editingRef.current || !content) return
      const active = window.document.activeElement
      if (
        active === content ||
        active?.closest('[data-ribbon-surface], [data-presentation-text-tool]')
      ) {
        pendingBlurTextRef.current = null
        settlePendingText()
        return
      }
      if (isComposingRef.current) return
      pendingBlurTextRef.current = null
      commitText()
      onFinishTextEdit?.()
    })
  }

  const focusEditableContent = (
    content: HTMLDivElement,
    point: { x: number; y: number } | null = null
  ): void => {
    content.focus()
    const range = point ? createCaretRangeFromPoint(point.x, point.y, content) : null
    const selection = window.getSelection()
    if (!selection) return
    const nextRange = range ?? window.document.createRange()
    if (!range) {
      nextRange.selectNodeContents(content)
      nextRange.collapse(false)
    }
    selection.removeAllRanges()
    selection.addRange(nextRange)
  }

  useLayoutEffect(() => {
    editingRef.current = editing
  }, [editing])

  useLayoutEffect(() => {
    flushTextRef.current = (): boolean => {
      if (isComposingRef.current) return false
      cancelPendingTextCommit()
      commitText()
      return true
    }
    finalizeTextEditRef.current = (): boolean => {
      if (!editingRef.current) return true
      if (isComposingRef.current) return false
      const content = contentRef.current
      if (!content) {
        hasPendingTextRef.current = false
        return true
      }
      cancelPendingBlur()
      cancelPendingTextCommit()
      registeredFinalizerRef.current = null
      notifyTextEditLifecycle()
      commitText()
      onFinishTextEdit?.()
      return true
    }
  })

  useLayoutEffect(() => {
    if (!editing) return
    const finalize: TextEditFinalizer = () => finalizeTextEditRef.current()
    finalize.getSelection = () => {
      const content = contentRef.current
      const selection =
        content && window.document.activeElement === content
          ? (readTextSelection(content) ?? retainedSelectionRef.current)
          : retainedSelectionRef.current
      return selection
        ? {
            elementId: element.id,
            start: Math.min(selection.anchor, selection.focus),
            end: Math.max(selection.anchor, selection.focus)
          }
        : null
    }
    finalize.restoreSelection = () => {
      const content = contentRef.current
      if (!content || !editingRef.current) return
      content.focus({ preventScroll: true })
      if (retainedSelectionRef.current) restoreTextSelection(content, retainedSelectionRef.current)
    }
    finalize.flush = () => flushTextRef.current()
    finalize.hasUnsafeWork = () => hasPendingTextRef.current
    finalize.isComposing = () => isComposingRef.current
    registeredFinalizerRef.current = finalize
    notifyTextEditLifecycle()
    return () => {
      if (registeredFinalizerRef.current === finalize) {
        registeredFinalizerRef.current = null
        notifyTextEditLifecycle()
      }
    }
  }, [editing, element.id, notifyTextEditLifecycle])

  useLayoutEffect(() => {
    if (!editing) {
      domModelRef.current = null
      retainedSelectionRef.current = null
      return
    }
    const content = contentRef.current
    if (!content || isComposingRef.current) return
    const model = JSON.stringify(paragraphs)
    if (domModelRef.current === model) return
    const selection =
      window.document.activeElement === content
        ? (readTextSelection(content) ?? retainedSelectionRef.current)
        : retainedSelectionRef.current
    // React owns the detached template; only this owner writes the browser-editable subtree.
    content.replaceChildren(...Array.from(template.childNodes, (node) => node.cloneNode(true)))
    domParagraphsRef.current = paragraphs
    domModelRef.current = model
    if (selection) {
      const focused = window.document.activeElement
      restoreTextSelection(content, selection)
      if (focused instanceof HTMLElement && focused !== content)
        focused.focus({ preventScroll: true })
    }
  }, [editing, paragraphs, template])

  useLayoutEffect(() => {
    if (
      !editable ||
      !hasContentHeight(element) ||
      loadedFontKey !== fontKey ||
      isComposingRef.current
    )
      return
    const layout = [
      element.id,
      element.text,
      element.runs,
      element.paragraphs,
      element.width,
      element.height,
      element.autoSize,
      element.autoWidth,
      element.fontFamily,
      element.fontSize,
      element.bold,
      element.italic,
      element.baseline,
      element.characterSpacing,
      element.align,
      element.lineHeight,
      loadedFontKey,
      slideId
    ]
    if (layout.every((value, index) => value === measuredLayoutRef.current[index])) return
    measuredLayoutRef.current = layout
    const updates = measureAutoSizedTextElement(contentRef.current, element, element.text)
    if (Object.keys(updates).length) onTextLayoutChange?.(slideId, element.id, updates)
  }, [editable, element, fontKey, loadedFontKey, onTextLayoutChange, slideId])

  useLayoutEffect(() => {
    if (!editing || element.locked) return
    const content = contentRef.current
    if (!content) return
    if (initializedEditingElementRef.current === element.id) return
    initializedEditingElementRef.current = element.id
    focusEditableContent(content, pendingCaretPointRef.current)
    pendingCaretPointRef.current = null
  }, [editing, element.id, element.locked, element.text])

  useLayoutEffect(() => {
    if (editing) return
    initializedEditingElementRef.current = null
    cancelPendingTextCommit()
    hasPendingTextRef.current = false
  }, [editing])

  useEffect(() => {
    return () => {
      if (blurFrameRef.current != null) window.cancelAnimationFrame(blurFrameRef.current)
      if (textFrameRef.current != null) window.cancelAnimationFrame(textFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (!editing) return
    const reportSelection = (): void => {
      const content = contentRef.current
      const selection = window.getSelection()
      if (
        !content ||
        window.document.activeElement !== content ||
        !selection ||
        selection.rangeCount === 0
      )
        return
      const range = selection.getRangeAt(0)
      if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return
      retainedSelectionRef.current = readTextSelection(content)
      onTextSelectionChange?.({
        elementId: element.id,
        start: getTextOffset(content, range.startContainer, range.startOffset),
        end: getTextOffset(content, range.endContainer, range.endOffset)
      })
    }
    window.document.addEventListener('selectionchange', reportSelection)
    reportSelection()
    return () => window.document.removeEventListener('selectionchange', reportSelection)
  }, [editing, element.id, onTextSelectionChange])

  useEffect(() => {
    if (!editing || typeof Highlight === 'undefined' || !CSS.highlights) return
    const updateHighlight = (): void => {
      const content = contentRef.current
      const selected = retainedSelectionRef.current
      CSS.highlights.delete('presenter-text-selection')
      if (
        !content ||
        !selected ||
        window.document.activeElement === content ||
        selected.anchor === selected.focus
      )
        return
      const points = getTextSelectionPoints(content, selected)
      const range = window.document.createRange()
      const [start, end] =
        selected.anchor < selected.focus
          ? [points.anchor, points.focus]
          : [points.focus, points.anchor]
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      CSS.highlights.set('presenter-text-selection', new Highlight(range))
    }
    window.document.addEventListener('focusin', updateHighlight)
    window.document.addEventListener('selectionchange', updateHighlight)
    updateHighlight()
    return () => {
      window.document.removeEventListener('focusin', updateHighlight)
      window.document.removeEventListener('selectionchange', updateHighlight)
      CSS.highlights.delete('presenter-text-selection')
    }
  }, [editing, paragraphs])

  const renderedText =
    !hasRichText && !editing
      ? element.text
      : paragraphs.map((paragraph, paragraphIndex) => (
          <div
            key={paragraphIndex}
            data-text-paragraph={paragraphIndex}
            data-list-marker={getListMarker(paragraph, paragraphIndex)}
            className={
              paragraph.list ? 'before:mr-2 before:content-[attr(data-list-marker)]' : undefined
            }
            style={{
              minHeight: '1em',
              flexShrink: 0,
              textAlign: paragraph.align,
              lineHeight:
                paragraph.lineSpacing.kind === 'multiple'
                  ? paragraph.lineSpacing.value
                  : `${paragraph.lineSpacing.points}pt`,
              marginLeft: paragraph.marginLeft,
              textIndent: paragraph.textIndent
            }}
          >
            {paragraph.runs.map((run, runIndex) => (
              <span
                key={runIndex}
                data-text-run={runIndex}
                data-source-paragraph={paragraphIndex}
                style={{
                  color: run.color,
                  backgroundColor: run.highlightColor ?? undefined,
                  fontFamily: run.fontFamily,
                  fontSize: `${run.fontSize}px`,
                  fontWeight: run.bold ? 700 : 400,
                  fontStyle: run.italic ? 'italic' : 'normal',
                  textDecoration:
                    [run.underline && 'underline', run.strikethrough && 'line-through']
                      .filter(Boolean)
                      .join(' ') || 'none',
                  verticalAlign:
                    run.baseline === 'superscript'
                      ? 'super'
                      : run.baseline === 'subscript'
                        ? 'sub'
                        : 'baseline',
                  letterSpacing: run.characterSpacing ? `${run.characterSpacing}px` : undefined
                }}
              >
                {run.text}
              </span>
            ))}
            {paragraph.runs.length === 0 ? <br /> : null}
          </div>
        ))

  return (
    <>
      {editing ? createPortal(renderedText, template) : null}
      <div
        key={editing ? 'editing' : 'preview'}
        data-text-content
        ref={contentRef}
        role="textbox"
        className={`h-full w-full whitespace-pre-wrap break-words outline-none ${
          editable ? 'cursor-text' : ''
        }`}
        contentEditable={editing && !element.locked}
        suppressContentEditableWarning
        style={{
          color: element.color,
          fontFamily: element.fontFamily,
          fontSize: `${element.fontSize}px`,
          fontWeight: element.bold ? 700 : 400,
          fontStyle: element.italic ? 'italic' : 'normal',
          textDecoration: element.underline ? 'underline' : 'none',
          textAlign: element.align,
          lineHeight: element.lineHeight,
          display: element.verticalAlign ? 'flex' : undefined,
          flexDirection: element.verticalAlign ? 'column' : undefined,
          justifyContent:
            element.verticalAlign === 'center'
              ? 'center'
              : element.verticalAlign === 'bottom'
                ? 'flex-end'
                : undefined,
          boxSizing: contentHeight || element.textInsets ? 'border-box' : undefined,
          padding: element.textInsets
            ? `${element.textInsets.top}px ${element.textInsets.right}px ${element.textInsets.bottom}px ${element.textInsets.left}px`
            : contentHeight
              ? `${CONTENT_HEIGHT_TEXT_PADDING_Y}px ${CONTENT_HEIGHT_TEXT_PADDING_X}px`
              : undefined,
          width: editing && element.autoWidth === true ? 'max-content' : undefined,
          minWidth: editing && element.autoWidth === true ? '100%' : undefined,
          height: editing && element.autoWidth === true ? 'auto' : undefined,
          whiteSpace: editing && element.autoWidth === true ? 'pre' : 'pre-wrap',
          overflowWrap: editing && element.autoWidth === true ? 'normal' : 'break-word'
        }}
        onInput={() => {
          if (!editing) return
          hasPendingTextRef.current = true
          notifyTextEditLifecycle()
          if (isComposingRef.current) return
          scheduleTextCommit()
        }}
        onCompositionStart={() => {
          isComposingRef.current = true
          hasPendingTextRef.current = true
          notifyTextEditLifecycle()
          cancelPendingTextCommit()
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false
          notifyTextEditLifecycle()
          if (!editing) return
          if (pendingBlurTextRef.current !== null) scheduleBlurCommit()
          else scheduleTextCommit()
        }}
        onKeyDown={(event) => {
          if (!editing || isComposingRef.current || event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && !event.shiftKey) {
            const content = contentRef.current
            const selection = window.getSelection()
            if (content && selection?.isCollapsed && selection.anchorNode) {
              const index = Array.from(content.children).findIndex((node) =>
                node.contains(selection.anchorNode)
              )
              const currentParagraphs = serializeTextContent(content, domParagraphsRef.current)
              const paragraph = currentParagraphs[index]
              if (
                paragraph?.list &&
                !getPlainText([paragraph])
                  .replace(/[\u200b\ufeff]/g, '')
                  .trim()
              ) {
                event.preventDefault()
                cancelPendingTextCommit()
                hasPendingTextRef.current = false
                const nextParagraphs = currentParagraphs.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, list: null, marginLeft: 0, textIndent: 0 } : item
                )
                onUpdateElement?.(slideId, element.id, {
                  text: getPlainText(nextParagraphs),
                  paragraphs: nextParagraphs
                })
                return
              }
            }
          }
          if (event.key !== 'Tab' || !onTextIndent) return
          event.preventDefault()
          event.stopPropagation()
          onTextIndent(event.shiftKey ? -1 : 1)
        }}
        onPointerDown={(event) => {
          if (!editable) return
          cancelPendingBlur()
          event.stopPropagation()
          if (!editing && !element.locked) {
            // The preview is replaced below; do not let the browser focus that detached target.
            event.preventDefault()
            pendingCaretPointRef.current = { x: event.clientX, y: event.clientY }
            onStartTextEdit?.()
          }
        }}
        onClick={(event) => {
          if (!editable) return
          event.stopPropagation()
          if (element.locked) return
          cancelPendingBlur()
          if (!editing) {
            pendingCaretPointRef.current = { x: event.clientX, y: event.clientY }
            onStartTextEdit?.()
          }
        }}
        onBlur={(event) => {
          retainedSelectionRef.current =
            readTextSelection(event.currentTarget) ?? retainedSelectionRef.current
          cancelPendingTextCommit()
          pendingBlurTextRef.current = event.currentTarget.textContent ?? ''
          scheduleBlurCommit()
        }}
      >
        {editing ? null : renderedText}
      </div>
    </>
  )
}

function readTextSelection(content: HTMLElement): { anchor: number; focus: number } | null {
  const selection = window.getSelection()
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !content.contains(selection.anchorNode) ||
    !content.contains(selection.focusNode)
  )
    return null
  return {
    anchor: getTextOffset(content, selection.anchorNode, selection.anchorOffset),
    focus: getTextOffset(content, selection.focusNode, selection.focusOffset)
  }
}

function getTextSelectionPoints(
  content: HTMLElement,
  selection: { anchor: number; focus: number }
): { anchor: { node: Node; offset: number }; focus: { node: Node; offset: number } } {
  const locate = (position: number): { node: Node; offset: number } => {
    let remaining = Math.max(0, position)
    const paragraphs = Array.from(content.children)
    for (const [index, paragraph] of paragraphs.entries()) {
      const length = getEditableNodeText(paragraph).length
      if (remaining <= length || index === paragraphs.length - 1) {
        const walker = window.document.createTreeWalker(
          paragraph,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
        )
        let node: Node | null
        while ((node = walker.nextNode())) {
          if (node instanceof Text) {
            if (remaining <= node.length) return { node, offset: remaining }
            remaining -= node.length
          } else if (node instanceof HTMLBRElement) {
            if (remaining === 0)
              return { node: paragraph, offset: Array.from(paragraph.childNodes).indexOf(node) }
            remaining--
          }
        }
        return { node: paragraph, offset: paragraph.childNodes.length }
      }
      remaining -= length + 1
    }
    return { node: content, offset: 0 }
  }
  return { anchor: locate(selection.anchor), focus: locate(selection.focus) }
}

function restoreTextSelection(
  content: HTMLElement,
  selection: { anchor: number; focus: number }
): void {
  const { anchor, focus } = getTextSelectionPoints(content, selection)
  window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
}

function getTextOffset(content: HTMLElement, node: Node, nodeOffset: number): number {
  const paragraph =
    node instanceof Element
      ? node.closest<HTMLElement>('[data-text-paragraph]')
      : node.parentElement?.closest<HTMLElement>('[data-text-paragraph]')
  if (!paragraph || !content.contains(paragraph)) {
    const range = window.document.createRange()
    range.selectNodeContents(content)
    range.setEnd(node, nodeOffset)
    return range.toString().length
  }

  const paragraphs = Array.from(
    content.querySelectorAll<HTMLElement>(':scope > [data-text-paragraph]')
  )
  const paragraphIndex = paragraphs.indexOf(paragraph)
  const offsetBefore = paragraphs
    .slice(0, paragraphIndex)
    .reduce((length, item) => length + (item.textContent?.length ?? 0) + 1, 0)
  const range = window.document.createRange()
  range.selectNodeContents(paragraph)
  range.setEnd(node, nodeOffset)
  return offsetBefore + range.toString().length
}

function serializeTextContent(
  content: HTMLDivElement,
  sourceParagraphs: ReturnType<typeof normalizeTextParagraphs>
): ReturnType<typeof normalizeTextParagraphs> {
  const paragraphNodes = Array.from(content.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement
  )
  if (paragraphNodes.length === 0) {
    const style = resolveTypingStyle(sourceParagraphs, 0)
    return [
      {
        ...sourceParagraphs[0],
        runs: style && content.textContent ? [{ text: content.textContent, ...style }] : [],
        typingStyle: style
      }
    ]
  }
  let previousSourceParagraph = sourceParagraphs[0]
  const resolvedSourceParagraphs = paragraphNodes.map((paragraphNode) => {
    const sourceParagraphIndex = Number(paragraphNode.dataset.textParagraph)
    const sourceParagraph =
      (Number.isInteger(sourceParagraphIndex) && sourceParagraphIndex >= 0
        ? sourceParagraphs[sourceParagraphIndex]
        : undefined) ??
      previousSourceParagraph ??
      sourceParagraphs.at(-1)!
    previousSourceParagraph = sourceParagraph
    return sourceParagraph
  })
  const selectionNode = window.getSelection()?.anchorNode
  const activeParagraphNode = selectionNode
    ? paragraphNodes.find((paragraphNode) => paragraphNode.contains(selectionNode))
    : undefined
  const typingStyleOwners = new Map<EditableTextParagraph, HTMLElement>()
  for (const sourceParagraph of new Set(resolvedSourceParagraphs)) {
    if (sourceParagraph.typingStyleCaret === undefined) continue
    const candidates = paragraphNodes.filter(
      (_, index) => resolvedSourceParagraphs[index] === sourceParagraph
    )
    typingStyleOwners.set(
      sourceParagraph,
      (activeParagraphNode && candidates.includes(activeParagraphNode)
        ? activeParagraphNode
        : candidates.at(-1))!
    )
  }
  return paragraphNodes.map((paragraphNode, paragraphIndex) => {
    const sourceParagraph = resolvedSourceParagraphs[paragraphIndex]
    const runs: EditableTextRun[] = []
    const nodes: Array<HTMLElement | Text> = []
    const collectNodes = (parent: Node): void => {
      parent.childNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.matches('[data-text-run]')) nodes.push(node)
        else if (
          node instanceof HTMLBRElement &&
          !(parent === paragraphNode && parent.childNodes.length === 1)
        ) {
          nodes.push(node)
        } else if (node instanceof Text) nodes.push(node)
        else collectNodes(node)
      })
    }
    collectNodes(paragraphNode)
    let typingStyleCaret =
      typingStyleOwners.get(sourceParagraph) === paragraphNode
        ? sourceParagraph.typingStyleCaret
        : undefined
    let offset = 0
    let nextSourceRunIndex = 0
    const removeMissingSourceRuns = (endIndex: number): void => {
      while (nextSourceRunIndex < Math.min(endIndex, sourceParagraph.runs.length)) {
        const edited = serializeEditedRun(
          sourceParagraph.runs[nextSourceRunIndex],
          '',
          offset,
          typingStyleCaret,
          sourceParagraph.typingStyle
        )
        typingStyleCaret = edited.typingStyleCaret
        nextSourceRunIndex++
      }
    }
    for (const [nodeIndex, node] of nodes.entries()) {
      if (node instanceof HTMLBRElement) {
        const previousNode = nodes[nodeIndex - 1]
        if (
          nodeIndex === nodes.length - 1 &&
          previousNode &&
          getEditableNodeText(previousNode).endsWith('\n')
        ) {
          continue
        }
        const style =
          typingStyleCaret === offset
            ? sourceParagraph.typingStyle
            : resolveTypingStyle([sourceParagraph], offset)
        if (style) runs.push({ text: '\n', ...style })
        if (typingStyleCaret !== undefined && typingStyleCaret >= offset) typingStyleCaret++
        offset++
        continue
      }
      if (node instanceof HTMLElement) {
        const text = getEditableNodeText(node)
        const runIndex = Number(node.dataset.textRun)
        const runSourceParagraphIndex = Number(node.dataset.sourceParagraph)
        const runSourceParagraph =
          (Number.isInteger(runSourceParagraphIndex) && runSourceParagraphIndex >= 0
            ? sourceParagraphs[runSourceParagraphIndex]
            : undefined) ?? sourceParagraph
        const usesCurrentSourceParagraph = runSourceParagraph === sourceParagraph
        if (
          usesCurrentSourceParagraph &&
          Number.isInteger(runIndex) &&
          runIndex >= nextSourceRunIndex
        ) {
          removeMissingSourceRuns(runIndex)
        }
        const sourceRun = runSourceParagraph.runs[runIndex] ?? runSourceParagraph.runs.at(-1)
        if (sourceRun) {
          const edited = serializeEditedRun(
            sourceRun,
            text,
            offset,
            usesCurrentSourceParagraph ? typingStyleCaret : undefined,
            usesCurrentSourceParagraph ? sourceParagraph.typingStyle : undefined
          )
          runs.push(...edited.runs)
          if (usesCurrentSourceParagraph) typingStyleCaret = edited.typingStyleCaret
        }
        if (usesCurrentSourceParagraph && Number.isInteger(runIndex) && runIndex >= 0) {
          nextSourceRunIndex = Math.max(nextSourceRunIndex, runIndex + 1)
        }
        offset += text.length
      } else {
        const text = node.textContent ?? ''
        const style =
          typingStyleCaret === offset
            ? sourceParagraph.typingStyle
            : resolveTypingStyle([sourceParagraph], offset)
        if (text && style) runs.push({ text, ...style })
        if (text && typingStyleCaret !== undefined && typingStyleCaret >= offset) {
          typingStyleCaret += text.length
        }
        offset += text.length
      }
    }
    removeMissingSourceRuns(sourceParagraph.runs.length)
    return {
      ...sourceParagraph,
      list: runs.length === 0 ? null : sourceParagraph.list,
      typingStyleCaret,
      runs
    }
  })
}

function getEditableNodeText(node: Node): string {
  if (node instanceof HTMLBRElement) return '\n'
  if (node instanceof Text) return node.textContent ?? ''
  const text = Array.from(node.childNodes, getEditableNodeText).join('')
  return node instanceof HTMLElement && text.endsWith('\n\n') ? text.slice(0, -1) : text
}

function serializeEditedRun(
  source: EditableTextRun,
  text: string,
  runStart: number,
  typingStyleCaret: number | undefined,
  typingStyle: EditableTextStyle | undefined
): { runs: EditableTextRun[]; typingStyleCaret: number | undefined } {
  if (text === source.text) return { runs: [{ ...source }], typingStyleCaret }

  let prefixLength = 0
  while (prefixLength < source.text.length && source.text[prefixLength] === text[prefixLength]) {
    prefixLength++
  }
  let suffixLength = 0
  while (
    suffixLength < source.text.length - prefixLength &&
    suffixLength < text.length - prefixLength &&
    source.text[source.text.length - 1 - suffixLength] === text[text.length - 1 - suffixLength]
  ) {
    suffixLength++
  }

  const insertedEnd = text.length - suffixLength
  const insertedLength = insertedEnd - prefixLength
  const editStart = runStart + prefixLength
  const editEnd = editStart + source.text.length - prefixLength - suffixLength
  let nextCaret = typingStyleCaret
  if (typingStyleCaret !== undefined) {
    if (typingStyleCaret > editEnd) {
      nextCaret = typingStyleCaret + insertedLength - (editEnd - editStart)
    } else if (typingStyleCaret >= editStart) nextCaret = editStart + insertedLength
  }
  if (!text) return { runs: [], typingStyleCaret: nextCaret }
  if (!typingStyle || typingStyleCaret !== editStart || insertedLength <= 0) {
    return { runs: [{ ...source, text }], typingStyleCaret: nextCaret }
  }

  const runs: EditableTextRun[] = []
  if (prefixLength > 0) runs.push({ ...source, text: text.slice(0, prefixLength) })
  if (insertedEnd > prefixLength) {
    runs.push({ text: text.slice(prefixLength, insertedEnd), ...typingStyle })
  }
  if (suffixLength > 0) runs.push({ ...source, text: text.slice(insertedEnd) })
  return { runs, typingStyleCaret: nextCaret }
}

function getListMarker(
  paragraph: EditableTextParagraph,
  paragraphIndex: number
): string | undefined {
  if (!paragraph.list) return undefined
  if (paragraph.list.kind === 'bullet') return paragraph.list.char || '•'
  return `${(paragraph.list.startAt ?? 1) + paragraphIndex}.`
}

function calculateImageResize(
  element: Extract<EditablePresentationElement, { type: 'image' }>,
  handle: ResizeHandle,
  dx: number,
  dy: number
): Partial<EditablePresentationElement> {
  const hasWest = handle.includes('w')
  const hasEast = handle.includes('e')
  const hasNorth = handle.includes('n')
  const hasSouth = handle.includes('s')
  const isCorner = (hasWest || hasEast) && (hasNorth || hasSouth)

  let width = element.width + (hasEast ? dx : hasWest ? -dx : 0)
  let height = element.height + (hasSouth ? dy : hasNorth ? -dy : 0)

  if (isCorner) {
    const aspectRatio = element.width / element.height
    const widthDelta = Math.abs(width - element.width)
    const heightDelta = Math.abs(height - element.height) * aspectRatio
    if (widthDelta >= heightDelta) {
      height = width / aspectRatio
    } else {
      width = height * aspectRatio
    }
  }

  width = Math.max(MIN_ELEMENT_SIZE, width)
  height = Math.max(MIN_ELEMENT_SIZE, height)

  return {
    x: hasWest ? element.x + (element.width - width) : element.x,
    y: hasNorth ? element.y + (element.height - height) : element.y,
    width,
    height
  } as Partial<EditablePresentationElement>
}

function calculateImageCrop(
  crop: Extract<EditablePresentationElement, { type: 'image' }>['crop'],
  handle: ResizeHandle,
  dx: number,
  dy: number,
  element: Extract<EditablePresentationElement, { type: 'image' }>
): NonNullable<Extract<EditablePresentationElement, { type: 'image' }>['crop']> {
  const next = normalizeImageCrop(crop)
  const dxPercent = (dx / Math.max(1, element.width)) * 100
  const dyPercent = (dy / Math.max(1, element.height)) * 100

  if (handle.includes('w')) next.left += dxPercent
  if (handle.includes('e')) next.right -= dxPercent
  if (handle.includes('n')) next.top += dyPercent
  if (handle.includes('s')) next.bottom -= dyPercent

  return clampCrop(next)
}

function normalizeImageCrop(
  crop: Extract<EditablePresentationElement, { type: 'image' }>['crop']
): NonNullable<Extract<EditablePresentationElement, { type: 'image' }>['crop']> {
  return {
    top: crop?.top ?? 0,
    right: crop?.right ?? 0,
    bottom: crop?.bottom ?? 0,
    left: crop?.left ?? 0
  }
}

function clampCrop(
  crop: NonNullable<Extract<EditablePresentationElement, { type: 'image' }>['crop']>
): NonNullable<Extract<EditablePresentationElement, { type: 'image' }>['crop']> {
  const next = {
    top: clamp(crop.top, 0, MAX_CROP_TOTAL),
    right: clamp(crop.right, 0, MAX_CROP_TOTAL),
    bottom: clamp(crop.bottom, 0, MAX_CROP_TOTAL),
    left: clamp(crop.left, 0, MAX_CROP_TOTAL)
  }
  if (next.left + next.right > MAX_CROP_TOTAL) {
    next.right = MAX_CROP_TOTAL - next.left
  }
  if (next.top + next.bottom > MAX_CROP_TOTAL) {
    next.bottom = MAX_CROP_TOTAL - next.top
  }
  return next
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getImageShadow(
  shadow: Extract<EditablePresentationElement, { type: 'image' }>['shadow']
): string | undefined {
  if (shadow === 'soft') return '0 8px 20px rgba(0, 0, 0, 0.22)'
  if (shadow === 'medium') return '0 14px 32px rgba(0, 0, 0, 0.32)'
  return undefined
}

function getTextHandlePositionStyle(handle: ResizeHandle, handleSize: number): React.CSSProperties {
  const offset = -handleSize
  const vertical = handle.includes('n')
    ? { top: offset }
    : handle.includes('s')
      ? { bottom: offset }
      : { top: '50%' }
  const horizontal = handle.includes('w')
    ? { left: offset }
    : handle.includes('e')
      ? { right: offset }
      : { left: '50%' }
  const transform = [
    !handle.includes('n') && !handle.includes('s') ? 'translateY(-50%)' : '',
    !handle.includes('w') && !handle.includes('e') ? 'translateX(-50%)' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return { ...vertical, ...horizontal, transform: transform || undefined }
}

function getHandleIndicatorPositionStyle(
  handle: ResizeHandle,
  indicatorSize: number
): React.CSSProperties {
  const offset = -indicatorSize / 2
  const vertical = handle.includes('n')
    ? { bottom: offset }
    : handle.includes('s')
      ? { top: offset }
      : { top: '50%' }
  const horizontal = handle.includes('w')
    ? { right: offset }
    : handle.includes('e')
      ? { left: offset }
      : { left: '50%' }
  const transform = [
    !handle.includes('n') && !handle.includes('s') ? 'translateY(-50%)' : '',
    !handle.includes('w') && !handle.includes('e') ? 'translateX(-50%)' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return { ...vertical, ...horizontal, transform: transform || undefined }
}

function getNearestResizeHandle(event: React.PointerEvent<HTMLDivElement>): ResizeHandle | null {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-resize-handle]')
  if (!target || !event.currentTarget.contains(target)) return null

  const candidates = IMAGE_HANDLES.map((handle) =>
    event.currentTarget.querySelector<HTMLElement>(`[data-resize-handle="${handle}"]`)
  ).filter((candidate): candidate is HTMLElement => candidate !== null)
  if (
    candidates.every((candidate) => {
      const rect = getResizeHandleIndicatorRect(candidate)
      return rect.width === 0 && rect.height === 0
    })
  ) {
    const handle = target.dataset.resizeHandle
    return IMAGE_HANDLES.includes(handle as ResizeHandle) ? (handle as ResizeHandle) : null
  }
  const first = candidates[0]
  if (!first) return null
  let nearest = first
  let nearestDistance = distanceToCenter(
    getResizeHandleIndicatorRect(first),
    event.clientX,
    event.clientY
  )
  candidates.slice(1).forEach((candidate) => {
    const distance = distanceToCenter(
      getResizeHandleIndicatorRect(candidate),
      event.clientX,
      event.clientY
    )
    if (distance < nearestDistance) {
      nearest = candidate
      nearestDistance = distance
    }
  })
  const handle = nearest.dataset.resizeHandle
  return IMAGE_HANDLES.includes(handle as ResizeHandle) ? (handle as ResizeHandle) : null
}

function getResizeHandleIndicatorRect(handle: HTMLElement): DOMRect {
  return (
    handle.querySelector<HTMLElement>('[data-resize-handle-indicator]') ?? handle
  ).getBoundingClientRect()
}

function distanceToCenter(rect: DOMRect, x: number, y: number): number {
  return (rect.left + rect.width / 2 - x) ** 2 + (rect.top + rect.height / 2 - y) ** 2
}

function normalizeSurfaceScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

function getKeyboardResizeDelta(
  event: React.KeyboardEvent<HTMLButtonElement>,
  handle: ResizeHandle,
  horizontalOnly: boolean
): { dx: number; dy: number } | null {
  const step = event.shiftKey ? 10 : 1
  if (event.key === 'ArrowLeft' && (handle.includes('w') || handle.includes('e'))) {
    return { dx: -step, dy: 0 }
  }
  if (event.key === 'ArrowRight' && (handle.includes('w') || handle.includes('e'))) {
    return { dx: step, dy: 0 }
  }
  if (
    !horizontalOnly &&
    event.key === 'ArrowUp' &&
    (handle.includes('n') || handle.includes('s'))
  ) {
    return { dx: 0, dy: -step }
  }
  if (
    !horizontalOnly &&
    event.key === 'ArrowDown' &&
    (handle.includes('n') || handle.includes('s'))
  ) {
    return { dx: 0, dy: step }
  }
  return null
}

function getHandleCursorClass(handle: ResizeHandle): string {
  if (handle === 'n' || handle === 's') return 'cursor-ns-resize'
  if (handle === 'e' || handle === 'w') return 'cursor-ew-resize'
  if (handle === 'ne' || handle === 'sw') return 'cursor-nesw-resize'
  return 'cursor-nwse-resize'
}
