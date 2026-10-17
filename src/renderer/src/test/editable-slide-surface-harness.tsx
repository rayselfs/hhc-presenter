import { vi } from 'vitest'
import { useState } from 'react'
import type { ComponentProps, JSX } from 'react'
import EditableSlideSurface from '@renderer/components/Common/EditableSlideSurface'
import {
  updateElementInSlide,
  type EditablePresentationDocument
} from '@renderer/lib/editable-presentation'

export function EditableSurfaceHarness({
  document,
  slideId,
  selectedElementId,
  cropElementId,
  onUpdateElement
}: {
  document: EditablePresentationDocument
  slideId: string
  selectedElementId?: string | null
  cropElementId?: string | null
  onUpdateElement?: ComponentProps<typeof EditableSlideSurface>['onUpdateElement']
}): JSX.Element {
  const [editingElementId, setEditingElementId] = useState<string | null>(null)

  return (
    <EditableSlideSurface
      document={document}
      slideId={slideId}
      editable
      selectedElementId={selectedElementId}
      editingElementId={editingElementId}
      cropElementId={cropElementId}
      onEditingElementChange={setEditingElementId}
      onUpdateElement={onUpdateElement}
    />
  )
}

export function StatefulEditableSurfaceHarness({
  document,
  slideId
}: {
  document: EditablePresentationDocument
  slideId: string
}): JSX.Element {
  const [currentDocument, setCurrentDocument] = useState(document)
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [editingElementId, setEditingElementId] = useState<string | null>(null)

  return (
    <EditableSlideSurface
      document={currentDocument}
      slideId={slideId}
      editable
      selectedElementId={selectedElementId}
      editingElementId={editingElementId}
      onSelectElement={setSelectedElementId}
      onEditingElementChange={setEditingElementId}
      onUpdateElement={(nextSlideId, elementId, updates) => {
        setCurrentDocument((previous) =>
          updateElementInSlide(previous, nextSlideId, elementId, updates)
        )
      }}
    />
  )
}

export function mockTextMeasurement(): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return Math.max(20, (this.textContent?.length ?? 0) * 12) + getHorizontalPadding(this)
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const width = Number.parseFloat(this.style.width) - getHorizontalPadding(this)
    const textWidth = Math.max(20, (this.textContent?.length ?? 0) * 12)
    const lines =
      Number.isFinite(width) && width > 0 ? Math.max(1, Math.ceil(textWidth / width)) : 1
    return lines * 74 + getVerticalPadding(this)
  })
}

function getHorizontalPadding(element: HTMLElement): number {
  return (
    Number.parseFloat(element.style.paddingLeft) + Number.parseFloat(element.style.paddingRight)
  )
}

function getVerticalPadding(element: HTMLElement): number {
  return (
    Number.parseFloat(element.style.paddingTop) + Number.parseFloat(element.style.paddingBottom)
  )
}

export function getSlideSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector('[data-slide-surface]')
  if (!(surface instanceof HTMLElement)) throw new Error('slide surface not found')
  return surface
}

export function withinResizeHandle(handle: HTMLElement): HTMLElement {
  const indicator = handle.querySelector('[data-resize-handle-indicator]')
  if (!(indicator instanceof HTMLElement)) throw new Error('resize handle indicator not found')
  return indicator
}

export function withinResizeHandleVisual(handle: HTMLElement): HTMLElement {
  const visual = handle.querySelector('[data-resize-handle-visual]')
  if (!(visual instanceof HTMLElement)) throw new Error('resize handle visual not found')
  return visual
}

export function expectScreenHitTarget(handle: HTMLElement, scale: number): void {
  expect(Number.parseFloat(handle.style.width) * scale).toBeGreaterThanOrEqual(24)
  expect(Number.parseFloat(handle.style.height) * scale).toBeGreaterThanOrEqual(24)
}

export function mockSurfaceRect(surface: HTMLElement): void {
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 960,
    bottom: 540,
    width: 960,
    height: 540,
    toJSON: () => ({})
  })
}

export function mockHandleCenterTie(
  surface: HTMLElement,
  preferred: HTMLElement,
  painted: HTMLElement
): void {
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 480, 270))
  vi.spyOn(preferred, 'getBoundingClientRect').mockReturnValue(rect(92.5, 92.5, 25, 25))
  vi.spyOn(painted, 'getBoundingClientRect').mockReturnValue(rect(87.5, 87.5, 25, 25))
  vi.spyOn(withinResizeHandle(preferred), 'getBoundingClientRect').mockReturnValue(
    rect(89, 89, 12, 12)
  )
  vi.spyOn(withinResizeHandle(painted), 'getBoundingClientRect').mockReturnValue(
    rect(99, 99, 12, 12)
  )
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({})
  }
}

export function mockSurfaceScale(scale: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.hasAttribute('data-slide-surface')) {
      const width = 1920 * scale
      const height = 1080 * scale
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({})
      }
    }
    return new DOMRect()
  })
}

export function mockElementRect(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({})
  })
}
