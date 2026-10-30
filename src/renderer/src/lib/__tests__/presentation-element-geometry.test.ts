import { calculateImageResize, MIN_ELEMENT_SIZE } from '../presentation-element-geometry'
import type { EditableImageElement } from '../editable-presentation'

it.each(['nw', 'ne', 'sw', 'se'] as const)(
  'preserves image ratio and opposite corner when %s resize reaches its minimum',
  (handle) => {
    const image: EditableImageElement = {
      id: 'image',
      type: 'image',
      assetId: 'asset',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      rotation: 0,
      opacity: 1
    }
    const result = calculateImageResize(
      image,
      handle,
      handle.includes('w') ? 190 : -190,
      handle.includes('n') ? 95 : -95
    )
    expect(result.width! / result.height!).toBe(2)
    expect(result.width).toBeGreaterThanOrEqual(MIN_ELEMENT_SIZE)
    expect(result.height).toBeGreaterThanOrEqual(MIN_ELEMENT_SIZE)
    expect(result.x! + (handle.includes('w') ? result.width! : 0)).toBe(
      handle.includes('w') ? 300 : 100
    )
    expect(result.y! + (handle.includes('n') ? result.height! : 0)).toBe(
      handle.includes('n') ? 200 : 100
    )
  }
)
