import { describe, expect, it } from 'vitest'
import { snapSlideFrame } from '../presentation-snapping'

const base = { x: 100, y: 100, width: 200, height: 100, rotation: 0 }
const options = {
  original: base,
  canvas: { width: 1280, height: 720 },
  unitsPerPixel: { x: 1, y: 1 }
}
describe('slide snapping', () => {
  it('snaps both center axes without changing size', () => {
    expect(
      snapSlideFrame({ ...options, frame: { ...base, x: 544, y: 314 }, mode: 'move' }).frame
    ).toMatchObject({ x: 540, y: 310, width: 200, height: 100 })
  })
  it.each([
    [4, 200, 0, 200],
    [1076, 616, 1080, 620]
  ])('snaps translated edges (%s, %s)', (x, y, expectedX, expectedY) => {
    expect(
      snapSlideFrame({ ...options, frame: { ...base, x, y }, mode: 'move' }).frame
    ).toMatchObject({ x: expectedX, y: expectedY })
  })
  it('holds at 8 screen pixels and releases beyond 10', () => {
    const first = snapSlideFrame({ ...options, frame: { ...base, x: 4 }, mode: 'move' })
    expect(
      snapSlideFrame({ ...options, frame: { ...base, x: 8 }, mode: 'move', previous: first.guides })
        .frame.x
    ).toBe(0)
    expect(
      snapSlideFrame({
        ...options,
        frame: { ...base, x: 11 },
        mode: 'move',
        previous: first.guides
      }).frame.x
    ).toBe(11)
  })
  it('uses screen pixels at different zoom levels and permits bypass', () => {
    const args = {
      ...options,
      frame: { ...base, x: 11 },
      mode: 'move' as const,
      unitsPerPixel: { x: 2, y: 2 }
    }
    expect(snapSlideFrame(args).frame.x).toBe(0)
    expect(snapSlideFrame({ ...args, disabled: true }).frame.x).toBe(11)
  })
  it.each(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const)(
    'snaps only active resize edges: %s',
    (handle) => {
      const original = { ...base, x: 100, y: 100, width: 1080, height: 520 }
      const frame = {
        ...original,
        x: handle.includes('w') ? 4 : 100,
        y: handle.includes('n') ? 4 : 100,
        width: handle.includes('w') || handle.includes('e') ? 1176 : 1080,
        height: handle.includes('n') || handle.includes('s') ? 616 : 520
      }
      const result = snapSlideFrame({ ...options, original, frame, mode: 'resize', handle }).frame
      expect(result.x).toBe(handle.includes('w') ? 0 : 100)
      expect(result.y).toBe(handle.includes('n') ? 0 : 100)
      expect(result.width).toBe(handle.includes('w') || handle.includes('e') ? 1180 : 1080)
      expect(result.height).toBe(handle.includes('n') || handle.includes('s') ? 620 : 520)
    }
  )
  it('keeps image aspect ratio and the opposite corner fixed', () => {
    const frame = { ...base, width: 1176, height: 588 }
    const result = snapSlideFrame({
      ...options,
      frame,
      mode: 'resize',
      handle: 'se',
      keepAspectRatio: true
    }).frame
    expect(result).toMatchObject({ x: 100, y: 100, width: 1180, height: 590 })
  })
  it('does not alter content-driven height or rotated resize geometry', () => {
    const frame = { ...base, y: 4 }
    expect(
      snapSlideFrame({ ...options, frame, mode: 'resize', handle: 'n', resizeHeight: false }).frame
    ).toEqual(frame)
    expect(
      snapSlideFrame({
        ...options,
        original: { ...base, rotation: 45 },
        frame,
        mode: 'resize',
        handle: 'nw'
      }).frame
    ).toEqual(frame)
  })
})

it('snaps the visible rotated bounds rather than the unrotated frame', () => {
  const visibleWidth = 300 / Math.sqrt(2)
  const original = { ...base, rotation: 45 }
  const frame = { ...base, x: (visibleWidth - base.width) / 2 + 4 }
  const result = snapSlideFrame({ ...options, original, frame, mode: 'move' })
  expect(result.frame.x + (base.width - visibleWidth) / 2).toBeCloseTo(0, 8)
  expect(result.frame).toMatchObject({ width: base.width, height: base.height })
  expect(result.guides.x?.target).toBe(0)
})
