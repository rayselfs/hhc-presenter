import type { EditablePresentationElement } from './editable-presentation'
import { hasContentHeight } from './editable-presentation'

export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const TEXT_MIN_WIDTH = 60
const TEXT_MIN_HEIGHT = 24
export const MIN_ELEMENT_SIZE = 20
const MAX_CROP_TOTAL = 95

export function calculateTextResize(
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

export function hasElementPatchChanges(
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

export function calculateImageResize(
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

export function calculateImageCrop(
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

export function normalizeImageCrop(
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
