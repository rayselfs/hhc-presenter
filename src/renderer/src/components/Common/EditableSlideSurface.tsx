import {
  calculateTextResize,
  hasElementPatchChanges,
  calculateImageResize,
  calculateImageCrop,
  normalizeImageCrop,
  MIN_ELEMENT_SIZE,
  type ResizeHandle
} from '@renderer/lib/presentation-element-geometry'
import TextElementContent from './TextElementContent'
import type { EditableTextSelection, TextEditFinalizer } from '@renderer/types/presentation-text'
import {
  getPresetShapeDescriptor,
  projectPresetAdjustment,
  resolvePresetShapeGeometry
} from '@renderer/lib/presentation-shape-geometry'
import { useTranslation } from 'react-i18next'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  EditablePresentationDocument,
  EditablePresentationElement,
  EditablePresentationSlide,
  EditableTextInsertFrame
} from '@renderer/lib/editable-presentation'
import {
  INSERTED_TEXT_CLICK_SIZE,
  INSERTED_TEXT_DRAG_MIN_SIZE,
  hasContentHeight,
  getSlideBackgroundCss,
  getSlideBackgroundPrimaryColor
} from '@renderer/lib/editable-presentation'

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

interface DragState {
  elementId: string
  mode: 'move' | 'resize' | 'crop' | 'rotate' | 'adjust'
  adjustmentIndex?: number
  cancel?: () => void
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

const TEXT_FRAME_HIT_AREA = 6
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

  useEffect(() => {
    const cancel = (): void => {
      const drag = dragRef.current
      dragRef.current = null
      drag?.cancel?.()
    }
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !dragRef.current) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onEscape, true)
    return () => {
      window.removeEventListener('keydown', onEscape, true)
      cancel()
    }
  }, [document.id, slideId, editable])

  if (!slide) {
    return <div className={`h-full w-full bg-black ${className ?? ''}`} />
  }

  const borderColor = getReadableBorderColor(getSlideBackgroundPrimaryColor(slide.background))

  const startDrag = (
    event: React.PointerEvent,
    element: EditablePresentationElement,
    mode: DragState['mode'],
    handle?: ResizeHandle,
    adjustmentIndex?: number
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
      adjustmentIndex,
      cancel: onTransformCancel,
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
    if (
      drag.mode === 'adjust' &&
      drag.original.type === 'shape' &&
      drag.adjustmentIndex !== undefined
    ) {
      const handle = resolvePresetShapeGeometry(drag.original).handles[drag.adjustmentIndex]
      if (!handle) return
      const angle = (drag.original.rotation * Math.PI) / 180
      const adjustments = projectPresetAdjustment(drag.original, drag.adjustmentIndex, {
        x: handle.point.x + dx * Math.cos(angle) + dy * Math.sin(angle),
        y: handle.point.y - dx * Math.sin(angle) + dy * Math.cos(angle)
      })
      updates =
        adjustments[drag.adjustmentIndex] ===
        projectPresetAdjustment(drag.original, drag.adjustmentIndex, handle.point)[
          drag.adjustmentIndex
        ]
          ? {}
          : { adjustments }
    } else if (drag.mode === 'rotate' && drag.rotationOrigin) {
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
    else drag.cancel?.()
  }

  const cancelDrag = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    drag.cancel?.()
  }

  const adjustWithKeyboard = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    element: EditablePresentationElement,
    index: number
  ): void => {
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) ||
      !finalizeTextEdit()
    )
      return
    const original = onTransformStart ? onTransformStart(element.id) : element
    if (!original || original.type !== 'shape') return
    const handle = resolvePresetShapeGeometry(original).handles[index]
    if (!handle) {
      onTransformCancel?.()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const delta =
      (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1) *
      (event.shiftKey ? 10000 : 1000)
    const adjustments = projectPresetAdjustment(original, index, {
      x: handle.point.x + handle.direction.x * delta,
      y: handle.point.y + handle.direction.y * delta
    })
    const updates =
      adjustments[index] === projectPresetAdjustment(original, index, handle.point)[index]
        ? {}
        : { adjustments }
    const changed = onTransformPreview
      ? (onTransformPreview(element.id, updates) ?? hasElementPatchChanges(original, updates))
      : hasElementPatchChanges(original, updates)
    if (!changed) {
      onTransformCancel?.()
      return
    }
    if (!onTransformPreview) onUpdateElement?.(slideId, element.id, updates)
    onTransformCommit?.()
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
              showAdjustments={document.schemaVersion === 3}
              onAdjustmentPointerDown={(event, index) =>
                startDrag(event, element, 'adjust', undefined, index)
              }
              onAdjustmentKeyDown={(event, index) => adjustWithKeyboard(event, element, index)}
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
  showAdjustments,
  onAdjustmentPointerDown,
  onAdjustmentKeyDown,
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
  showAdjustments: boolean
  onAdjustmentPointerDown: (event: React.PointerEvent, index: number) => void
  onAdjustmentKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => void
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
      {showHandles &&
        showAdjustments &&
        element.type === 'shape' &&
        resolvePresetShapeGeometry(element).handles.map((handle) => (
          <button
            key={handle.index}
            type="button"
            data-adjustment-handle={handle.index}
            aria-label={t(
              `presentationWorkspace.adjustShape.${element.shape}.${handle.index}`,
              element.shape === 'triangle'
                ? 'Adjust apex position'
                : element.shape === 'roundRect'
                  ? 'Adjust corner radius'
                  : handle.index === 0
                    ? 'Adjust shaft width'
                    : 'Adjust arrowhead length'
            )}
            className="pointer-events-auto absolute flex cursor-crosshair items-center justify-center"
            style={{
              left: handle.point.x,
              top: handle.point.y,
              width: 24 / surfaceScale,
              height: 24 / surfaceScale,
              transform: 'translate(-50%, -50%)',
              touchAction: 'none',
              zIndex: 30
            }}
            onPointerDown={(event) => onAdjustmentPointerDown(event, handle.index)}
            onKeyDown={(event) => onAdjustmentKeyDown(event, handle.index)}
          >
            <span
              aria-hidden="true"
              className="rotate-45 border border-amber-800 bg-amber-300"
              style={{ width: 9 / surfaceScale, height: 9 / surfaceScale }}
            />
          </button>
        ))}
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
    if (document.schemaVersion === 3) {
      const geometry = resolvePresetShapeGeometry(element)
      return (
        <svg
          data-shape-kind={element.shape}
          aria-hidden="true"
          width="100%"
          height="100%"
          viewBox={`0 0 ${element.width} ${element.height}`}
          className="overflow-visible"
        >
          <path
            d={geometry.path}
            fill={element.fillColor}
            stroke={element.strokeColor}
            strokeWidth={element.strokeWidth}
            strokeLinejoin={getPresetShapeDescriptor(element.shape)!.lineJoin}
            strokeMiterlimit={8}
          />
        </svg>
      )
    }
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
