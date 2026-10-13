import type { EditableShapeElement, EditableShapeKind } from './editable-presentation'

interface PresetShapeDescriptor {
  preset: string
  guides: readonly string[]
  defaults: readonly number[]
  lineJoin: 'round' | 'miter'
}

// Line joins follow MS-OI29500 20.1.8.52; right/up/down arrows are Office miter exceptions.
// Preset defaults adapted from DeckCraft v0.5.0 crates/geom/src/preset.rs (MIT).
const PRESET_SHAPES: Record<EditableShapeKind, PresetShapeDescriptor> = {
  rectangle: { preset: 'rect', guides: [], defaults: [], lineJoin: 'round' },
  ellipse: { preset: 'ellipse', guides: [], defaults: [], lineJoin: 'round' },
  roundRect: { preset: 'roundRect', guides: ['adj'], defaults: [16667], lineJoin: 'round' },
  triangle: { preset: 'triangle', guides: ['adj'], defaults: [50000], lineJoin: 'round' },
  rtTriangle: { preset: 'rtTriangle', guides: [], defaults: [], lineJoin: 'round' },
  diamond: { preset: 'diamond', guides: [], defaults: [], lineJoin: 'round' },
  rightArrow: {
    preset: 'rightArrow',
    guides: ['adj1', 'adj2'],
    defaults: [50000, 50000],
    lineJoin: 'miter'
  },
  leftArrow: {
    preset: 'leftArrow',
    guides: ['adj1', 'adj2'],
    defaults: [50000, 50000],
    lineJoin: 'round'
  },
  upArrow: {
    preset: 'upArrow',
    guides: ['adj1', 'adj2'],
    defaults: [50000, 50000],
    lineJoin: 'miter'
  },
  downArrow: {
    preset: 'downArrow',
    guides: ['adj1', 'adj2'],
    defaults: [50000, 50000],
    lineJoin: 'miter'
  }
}

export function getPresetShapeDescriptor(shape: unknown): PresetShapeDescriptor | undefined {
  return typeof shape === 'string' && Object.hasOwn(PRESET_SHAPES, shape)
    ? PRESET_SHAPES[shape as EditableShapeKind]
    : undefined
}

export interface PresetShapePoint {
  x: number
  y: number
}
export interface PresetAdjustmentHandle {
  index: number
  point: PresetShapePoint
  origin: PresetShapePoint
  direction: PresetShapePoint
  min: number
  max: number
}
export interface PresetShapeGeometry {
  path: string
  textBounds: { x: number; y: number; width: number; height: number }
  handles: readonly PresetAdjustmentHandle[]
  sites: readonly PresetShapePoint[]
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))
const point = (x: number, y: number): PresetShapePoint => ({ x, y })
function bounds(
  left: number,
  top: number,
  right: number,
  bottom: number
): PresetShapeGeometry['textBounds'] {
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.abs(right - left),
    height: Math.abs(bottom - top)
  }
}
function polygon(points: readonly PresetShapePoint[]): string {
  return points.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`).join(' ') + ' Z'
}
function handle(
  index: number,
  origin: PresetShapePoint,
  direction: PresetShapePoint,
  value: number,
  max: number
): PresetAdjustmentHandle {
  const limitedMax = Math.min(max, 2147483647)
  const adjusted = clamp(value, 0, limitedMax)
  return {
    index,
    origin,
    direction,
    min: 0,
    max: limitedMax,
    point: point(origin.x + direction.x * adjusted, origin.y + direction.y * adjusted)
  }
}

// Geometry, bounds and axes adapted from DeckCraft v0.5.0 crates/geom/src/preset.rs (MIT).
export function resolvePresetShapeGeometry(shape: EditableShapeElement): PresetShapeGeometry {
  const descriptor = getPresetShapeDescriptor(shape.shape)
  const { width: w, height: h } = shape
  if (
    !descriptor ||
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0 ||
    w > 100000 ||
    h > 100000
  )
    throw new Error('Invalid preset shape geometry')
  if (
    shape.adjustments !== undefined &&
    (!Array.isArray(shape.adjustments) ||
      shape.adjustments.length > descriptor.guides.length ||
      shape.adjustments.some(
        (value) => !Number.isInteger(value) || value < -2147483648 || value > 2147483647
      ))
  )
    throw new Error('Invalid preset shape adjustments')
  const adjustment = (index: number): number =>
    shape.adjustments?.[index] ?? descriptor.defaults[index]
  const ss = Math.min(w, h)
  const geometry: PresetShapeGeometry = {
    path: '',
    textBounds: bounds(0, 0, w, h),
    handles: [],
    sites: [point(w / 2, 0), point(0, h / 2), point(w / 2, h), point(w, h / 2)]
  }
  switch (shape.shape) {
    case 'rectangle':
      geometry.path = polygon([point(0, 0), point(w, 0), point(w, h), point(0, h)])
      break
    case 'ellipse':
      geometry.path = `M0 ${h / 2} A${w / 2} ${h / 2} 0 1 1 ${w} ${h / 2} A${w / 2} ${h / 2} 0 1 1 0 ${h / 2} Z`
      geometry.textBounds = bounds(w * 0.14645, h * 0.14645, w * 0.85355, h * 0.85355)
      geometry.sites = Array.from({ length: 8 }, (_, index) => {
        const angle = ((-90 - 45 * index) * Math.PI) / 180
        return point(w / 2 + (w / 2) * Math.cos(angle), h / 2 + (h / 2) * Math.sin(angle))
      })
      break
    case 'roundRect': {
      const value = clamp(adjustment(0), 0, 50000)
      const radius = (ss * value) / 100000
      geometry.path =
        radius === 0
          ? polygon([point(0, 0), point(w, 0), point(w, h), point(0, h)])
          : `M${radius} 0 L${w - radius} 0 A${radius} ${radius} 0 0 1 ${w} ${radius} L${w} ${h - radius} A${radius} ${radius} 0 0 1 ${w - radius} ${h} L${radius} ${h} A${radius} ${radius} 0 0 1 0 ${h - radius} L0 ${radius} A${radius} ${radius} 0 0 1 ${radius} 0 Z`
      const inset = radius * 0.29289
      geometry.textBounds = bounds(inset, inset, w - inset, h - inset)
      geometry.handles = [handle(0, point(0, 0), point(ss / 100000, 0), value, 50000)]
      break
    }
    case 'triangle': {
      const value = clamp(adjustment(0), 0, 100000)
      const apex = (w * value) / 100000
      geometry.path = polygon([point(0, h), point(apex, 0), point(w, h)])
      geometry.textBounds = bounds(apex / 2, h / 2, (apex + w) / 2, h)
      geometry.sites = [
        point(apex, 0),
        point(apex / 2, h / 2),
        point(0, h),
        point(w / 2, h),
        point(w, h),
        point((apex + w) / 2, h / 2)
      ]
      geometry.handles = [handle(0, point(0, 0), point(w / 100000, 0), value, 100000)]
      break
    }
    case 'rtTriangle':
      geometry.path = polygon([point(0, 0), point(0, h), point(w, h)])
      geometry.textBounds = bounds(w / 12, (h * 7) / 12, (w * 7) / 12, (h * 11) / 12)
      break
    case 'diamond':
      geometry.path = polygon([point(w / 2, 0), point(w, h / 2), point(w / 2, h), point(0, h / 2)])
      geometry.textBounds = bounds(w / 4, h / 4, w * 0.75, h * 0.75)
      break
    case 'rightArrow':
    case 'leftArrow':
    case 'upArrow':
    case 'downArrow': {
      const vertical = shape.shape === 'upArrow' || shape.shape === 'downArrow'
      const length = vertical ? h : w
      const thickness = vertical ? w : h
      const orient = (u: number, v: number): PresetShapePoint => {
        switch (shape.shape) {
          case 'leftArrow':
            return point(w - u, v)
          case 'upArrow':
            return point(v, h - u)
          case 'downArrow':
            return point(v, u)
          default:
            return point(u, v)
        }
      }
      const shaft = clamp(adjustment(0), 0, 100000)
      const headMax = Math.min(2147483647, (100000 * length) / ss)
      const head = clamp(adjustment(1), 0, headMax)
      const dx = Math.min(length, (ss * head) / 100000)
      const y1 = thickness / 2 - (thickness * shaft) / 200000
      const y2 = thickness / 2 + (thickness * shaft) / 200000
      geometry.path = polygon([
        orient(0, y1),
        orient(length - dx, y1),
        orient(length - dx, 0),
        orient(length, thickness / 2),
        orient(length - dx, thickness),
        orient(length - dx, y2),
        orient(0, y2)
      ])
      const start = orient(0, y1)
      const end = orient(length - dx + (dx * y1) / (thickness / 2), y2)
      geometry.textBounds = bounds(start.x, start.y, end.x, end.y)
      const origin = orient(length - dx, thickness / 2)
      const tip = orient(length, thickness / 2)
      const across = vertical ? point(-thickness / 200000, 0) : point(0, -thickness / 200000)
      // Keep a stable head-length axis when dx=0 so users can restore the arrowhead.
      const along =
        shape.shape === 'leftArrow'
          ? point(ss / 100000, 0)
          : shape.shape === 'upArrow'
            ? point(0, ss / 100000)
            : shape.shape === 'downArrow'
              ? point(0, -ss / 100000)
              : point(-ss / 100000, 0)
      geometry.handles = [
        handle(0, origin, across, shaft, 100000),
        handle(1, tip, along, head, headMax)
      ]
    }
  }
  return geometry
}

export function projectPresetAdjustment(
  shape: EditableShapeElement,
  index: number,
  target: PresetShapePoint
): readonly number[] {
  const selected = resolvePresetShapeGeometry(shape).handles.find((entry) => entry.index === index)
  if (!selected || !Number.isFinite(target.x) || !Number.isFinite(target.y))
    throw new Error('Invalid preset adjustment target')
  const { direction, origin } = selected
  const value =
    Math.abs(direction.x) > Math.abs(direction.y)
      ? (target.x - origin.x) / direction.x
      : (target.y - origin.y) / direction.y
  if (Number.isNaN(value)) throw new Error('Invalid preset adjustment axis')
  const values = [...getPresetShapeDescriptor(shape.shape)!.defaults]
  for (const [index, value] of (shape.adjustments ?? []).entries()) values[index] = value
  values[index] = Math.round(clamp(value, selected.min, selected.max))
  return values
}
