import { describe, expect, it } from 'vitest'
import type { EditableShapeElement, EditableShapeKind } from '../editable-presentation'
import { projectPresetAdjustment, resolvePresetShapeGeometry } from '../presentation-shape-geometry'

function shape(kind: EditableShapeKind, adjustments?: readonly number[]): EditableShapeElement {
  return {
    id: 's',
    type: 'shape',
    shape: kind,
    adjustments,
    x: 20,
    y: 30,
    width: 200,
    height: 100,
    rotation: 37,
    opacity: 1,
    fillColor: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 2
  }
}
const kinds: EditableShapeKind[] = [
  'rectangle',
  'ellipse',
  'roundRect',
  'triangle',
  'rtTriangle',
  'diamond',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow'
]

describe('preset geometry', () => {
  it.each(kinds)('produces finite inert local geometry for %s at extreme aspect ratios', (kind) => {
    for (const [width, height] of [
      [200, 100],
      [100000, 0.001],
      [0.001, 100000]
    ]) {
      const element = { ...shape(kind), width, height }
      const before = JSON.stringify(element)
      const geometry = resolvePresetShapeGeometry(element)
      expect(geometry.path).toMatch(/^M[\d\s.,eE+\-MLAZ]+$/)
      expect(geometry.path).not.toMatch(/NaN|Infinity|<|>/)
      const { textBounds, handles, sites } = geometry
      for (const value of Object.values(textBounds)) expect(Number.isFinite(value)).toBe(true)
      expect(textBounds.x).toBeGreaterThanOrEqual(0)
      expect(textBounds.y).toBeGreaterThanOrEqual(0)
      expect(textBounds.width).toBeGreaterThanOrEqual(0)
      expect(textBounds.height).toBeGreaterThanOrEqual(0)
      expect(textBounds.x + textBounds.width).toBeLessThanOrEqual(width + 1e-8)
      expect(textBounds.y + textBounds.height).toBeLessThanOrEqual(height + 1e-8)
      for (const point of [...sites, ...handles.map((handle) => handle.point)]) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
        expect(point.x).toBeGreaterThanOrEqual(-1e-8)
        expect(point.x).toBeLessThanOrEqual(width + 1e-8)
        expect(point.y).toBeGreaterThanOrEqual(-1e-8)
        expect(point.y).toBeLessThanOrEqual(height + 1e-8)
      }
      expect(JSON.stringify(element)).toBe(before)
    }
  })

  it('uses shorter-side rounded radius and preserves raw out-of-range values', () => {
    const element = shape('roundRect')
    const geometry = resolvePresetShapeGeometry(element)
    expect(geometry.handles[0].point).toEqual({ x: 16.667, y: 0 })
    expect(geometry.path).toContain('A16.667 16.667')
    expect(geometry.textBounds.x).toBeCloseTo(16.667 * 0.29289, 8)
    const raw = shape('roundRect', [2147483647])
    expect(resolvePresetShapeGeometry(raw).handles[0].point.x).toBe(50)
    expect(raw.adjustments).toEqual([2147483647])
  })

  it('uses the adjustable triangle apex, fixed right triangle and diamond bounds', () => {
    expect(resolvePresetShapeGeometry(shape('triangle', [25000])).path).toBe(
      'M0 100 L50 0 L200 100 Z'
    )
    expect(resolvePresetShapeGeometry(shape('triangle', [25000])).textBounds).toEqual({
      x: 25,
      y: 50,
      width: 100,
      height: 50
    })
    expect(resolvePresetShapeGeometry(shape('rtTriangle')).path).toBe('M0 0 L0 100 L200 100 Z')
    expect(resolvePresetShapeGeometry(shape('diamond')).textBounds).toEqual({
      x: 50,
      y: 25,
      width: 100,
      height: 50
    })
    expect(resolvePresetShapeGeometry(shape('triangle')).sites).toContainEqual({ x: 100, y: 0 })
  })

  it.each([
    ['rightArrow', 'M0 25 L150 25 L150 0 L200 50 L150 100 L150 75 L0 75 Z'],
    ['leftArrow', 'M200 25 L50 25 L50 0 L0 50 L50 100 L50 75 L200 75 Z'],
    ['upArrow', 'M50 100 L50 50 L0 50 L100 0 L200 50 L150 50 L150 100 Z'],
    ['downArrow', 'M50 0 L50 50 L0 50 L100 100 L200 50 L150 50 L150 0 Z']
  ] as const)('orients the shorter-side head and shaft of %s', (kind, path) => {
    expect(resolvePresetShapeGeometry(shape(kind)).path).toBe(path)
  })

  it.each(['rightArrow', 'leftArrow', 'upArrow', 'downArrow'] as const)(
    'projects both %s adjustments, including a zero-length head',
    (kind) => {
      const element = shape(kind, [25000, 0])
      const geometry = resolvePresetShapeGeometry(element)
      expect(geometry.handles).toHaveLength(2)
      for (const handle of geometry.handles) {
        const value = 75000
        const point = {
          x: handle.origin.x + handle.direction.x * value,
          y: handle.origin.y + handle.direction.y * value
        }
        const values = projectPresetAdjustment(element, handle.index, point)
        expect(values[handle.index]).toBe(value)
        expect(values[1 - handle.index]).toBe(element.adjustments![1 - handle.index])
      }
    }
  )

  it('projects/clamps integer adjustments without writing to the original shape', () => {
    const element = shape('roundRect', [16667])
    expect(projectPresetAdjustment(element, 0, { x: 22.1234, y: 999 })).toEqual([22123])
    expect(projectPresetAdjustment(element, 0, { x: -5, y: 0 })).toEqual([0])
    expect(projectPresetAdjustment(element, 0, { x: 90, y: 0 })).toEqual([50000])
    expect(element.adjustments).toEqual([16667])
    expect(() => projectPresetAdjustment(element, 1, { x: 0, y: 0 })).toThrow()
    expect(() => projectPresetAdjustment(element, 0, { x: NaN, y: 0 })).toThrow()
  })

  it.each([0, -1, NaN, Infinity, 100001])('rejects invalid dimensions %s', (width) => {
    expect(() => resolvePresetShapeGeometry({ ...shape('triangle'), width })).toThrow()
  })
  it('rejects unknown presets and malformed raw adjustment values instead of falling back', () => {
    expect(() => resolvePresetShapeGeometry(shape('hexagon' as EditableShapeKind))).toThrow()
    for (const values of [[NaN], [0.5], [2147483648], [1, 2]])
      expect(() => resolvePresetShapeGeometry(shape('roundRect', values))).toThrow()
  })
})
