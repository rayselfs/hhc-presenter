interface Frame {
  x: number
  y: number
  width: number
  height: number
}
interface Guide {
  target: number
  anchor: number
}
export interface SlideSnapGuides {
  x?: Guide
  y?: Guide
}
interface SnapOptions {
  original: Frame & { rotation: number }
  frame: Frame
  canvas: { width: number; height: number }
  unitsPerPixel: { x: number; y: number }
  mode: 'move' | 'resize'
  handle?: string
  previous?: SlideSnapGuides
  disabled?: boolean
  keepAspectRatio?: boolean
  resizeHeight?: boolean
  minWidth?: number
  minHeight?: number
}

function chooseGuide(
  position: number,
  size: number,
  extent: number,
  unitsPerPixel: number,
  anchors: number[],
  previous?: Guide,
  moving = false
): Guide | undefined {
  const distance = (guide: Guide): number =>
    Math.abs(position + size * guide.anchor - guide.target) / unitsPerPixel
  if (previous && anchors.includes(previous.anchor) && distance(previous) <= 10) return previous
  const candidates = anchors.flatMap((anchor) =>
    (moving ? [anchor === 0.5 ? extent / 2 : anchor * extent] : [0, extent]).map((target) => ({
      anchor,
      target
    }))
  )
  return candidates
    .filter((guide) => distance(guide) <= 6)
    .sort((a, b) => distance(a) - distance(b))[0]
}

export function snapSlideFrame(options: SnapOptions): { frame: Frame; guides: SlideSnapGuides } {
  const { original, canvas, unitsPerPixel, previous = {}, mode, handle = '' } = options
  const frame = { ...options.frame }
  const guides: SlideSnapGuides = {}
  if (options.disabled) return { frame, guides }
  if (mode === 'move') {
    const radians = (original.rotation * Math.PI) / 180
    const width =
      Math.abs(frame.width * Math.cos(radians)) + Math.abs(frame.height * Math.sin(radians))
    const height =
      Math.abs(frame.width * Math.sin(radians)) + Math.abs(frame.height * Math.cos(radians))
    const left = frame.x + (frame.width - width) / 2
    const top = frame.y + (frame.height - height) / 2
    guides.x = chooseGuide(
      left,
      width,
      canvas.width,
      unitsPerPixel.x,
      [0, 0.5, 1],
      previous.x,
      true
    )
    guides.y = chooseGuide(
      top,
      height,
      canvas.height,
      unitsPerPixel.y,
      [0, 0.5, 1],
      previous.y,
      true
    )
    if (guides.x) frame.x += guides.x.target - (left + width * guides.x.anchor)
    if (guides.y) frame.y += guides.y.target - (top + height * guides.y.anchor)
    return { frame, guides }
  }
  // Angled resize stays free until snapping can preserve its rotated opposite anchor.
  if (original.rotation % 360 !== 0) return { frame, guides }
  const west = handle.includes('w'),
    east = handle.includes('e')
  const north = handle.includes('n'),
    south = handle.includes('s')
  const minWidth = options.minWidth ?? 20,
    minHeight = options.minHeight ?? 20
  let x = chooseGuide(
    frame.x,
    frame.width,
    canvas.width,
    unitsPerPixel.x,
    west ? [0] : east ? [1] : [],
    previous.x
  )
  let y = chooseGuide(
    frame.y,
    frame.height,
    canvas.height,
    unitsPerPixel.y,
    options.resizeHeight === false ? [] : north ? [0] : south ? [1] : [],
    previous.y
  )
  const widthFor = (guide: Guide): number =>
    west ? original.x + original.width - guide.target : guide.target - original.x
  const heightFor = (guide: Guide): number =>
    north ? original.y + original.height - guide.target : guide.target - original.y
  if (x && widthFor(x) < minWidth) x = undefined
  if (y && heightFor(y) < minHeight) y = undefined
  if (options.keepAspectRatio && (west || east) && (north || south)) {
    const ratio = original.width / original.height
    if (x && widthFor(x) / ratio < minHeight) x = undefined
    if (y && heightFor(y) * ratio < minWidth) y = undefined
    const xDistance = x ? Math.abs(widthFor(x) - frame.width) / unitsPerPixel.x : Infinity
    const yDistance = y ? Math.abs(heightFor(y) - frame.height) / unitsPerPixel.y : Infinity
    if (x && xDistance <= yDistance) {
      frame.width = widthFor(x)
      frame.height = frame.width / ratio
    } else if (y) {
      frame.height = heightFor(y)
      frame.width = frame.height * ratio
    }
  } else {
    if (x) frame.width = widthFor(x)
    if (y) frame.height = heightFor(y)
  }
  if (west) frame.x = original.x + original.width - frame.width
  if (north && options.resizeHeight !== false) frame.y = original.y + original.height - frame.height
  if (x && Math.abs(frame.x + frame.width * x.anchor - x.target) < 0.000001) guides.x = x
  if (y && Math.abs(frame.y + frame.height * y.anchor - y.target) < 0.000001) guides.y = y
  return { frame, guides }
}
