// Compare the ink distribution, independent of the glyph's location or rendered size.
const bins = 20
const fineBins = 40
export type GlyphShape = { coarse: Uint8Array; fine: Uint8Array; aspect: number }
type Ink = { pixels: Uint8Array; stride: number }
type Box = { x: number; y: number; w: number; h: number }

function profile({ pixels, stride }: Ink, box: Box): GlyphShape | null {
  let left = box.x + box.w,
    top = box.y + box.h,
    right = -1,
    bottom = -1
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (!pixels[y * stride + x]) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left) return null
  const sums = new Uint32Array(bins * bins)
  const counts = new Uint16Array(bins * bins)
  for (let y = top; y <= bottom; y++) {
    const row = Math.floor(((y - top + 0.5) * bins) / (bottom - top + 1)) * bins
    for (let x = left; x <= right; x++) {
      const i = row + Math.floor(((x - left + 0.5) * bins) / (right - left + 1))
      sums[i] += pixels[y * stride + x]
      counts[i]++
    }
  }
  const fine = new Uint8Array(fineBins * fineBins)
  for (let y = 0; y < fineBins; y++)
    for (let x = 0; x < fineBins; x++) {
      let total = 0
      for (let dy = 0; dy < 3; dy++)
        for (let dx = 0; dx < 3; dx++) {
          const sx = left + Math.floor(((x + (dx + 0.5) / 3) * (right - left + 1)) / fineBins)
          const sy = top + Math.floor(((y + (dy + 0.5) / 3) * (bottom - top + 1)) / fineBins)
          total += pixels[sy * stride + sx]
        }
      fine[y * fineBins + x] = total / 9
    }
  const coarse = Uint8Array.from(sums, (n, i) => {
    if (counts[i]) return Math.round(n / counts[i])
    // Narrow strokes (e.g. 一) leave empty bins. Sample the center of each bin.
    const x = left + Math.floor((((i % bins) + 0.5) * (right - left + 1)) / bins)
    const y = top + Math.floor(((Math.floor(i / bins) + 0.5) * (bottom - top + 1)) / bins)
    return pixels[y * stride + x]
  })
  return { fine, coarse, aspect: (right - left + 1) / (bottom - top + 1) }
}

function groups(active: Uint8Array, minGap: number): [number, number][] {
  const result: [number, number][] = []
  let last = -Infinity
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue
    if (i - last > minGap) result.push([i, i])
    result[result.length - 1][1] = i
    last = i
  }
  return result
}

export function slideRows(image: ImageData, expected: number): (GlyphShape[] | null)[] {
  const { width, height, data } = image
  const rows = new Uint16Array(height)
  const pixels = new Uint8Array(width * height)
  const bg = data.subarray(0, 3)
  let colored = 0
  for (let i = 0; i < pixels.length; i++) {
    const j = i * 4
    const diff = Math.max(
      Math.abs(data[j] - bg[0]),
      Math.abs(data[j + 1] - bg[1]),
      Math.abs(data[j + 2] - bg[2])
    )
    if (diff > 24) colored++
    if (diff < 100) continue
    rows[Math.floor(i / width)]++
    pixels[i] = 255
  }
  if (colored > pixels.length * 0.4) return []
  let bands = groups(
    Uint8Array.from(rows, (n) => (n > 0 ? 1 : 0)),
    2
  )
  if (bands.length < expected && bands.length > 0) {
    const dense = groups(
      Uint8Array.from(rows, (n) => (n > width * 0.015 ? 1 : 0)),
      1
    )
    if (dense.length === expected) {
      const first = bands[0][0],
        last = bands[bands.length - 1][1]
      bands = dense.map(([a, b], i) => [
        i === 0 ? first : Math.floor((dense[i - 1][1] + a) / 2) + 1,
        i === dense.length - 1 ? last : Math.floor((b + dense[i + 1][0]) / 2)
      ])
    }
  }
  if (bands.length !== expected) return []
  return bands.map(([start, end]) => {
    const h = end - start + 1
    if (h < 30) return null
    const columns = new Uint8Array(width)
    for (let y = start; y <= end; y++) {
      for (let x = 0; x < width; x++) columns[x] |= pixels[y * width + x]
    }
    const boxes: [number, number][] = []
    for (const [x, right] of groups(columns, Math.max(2, Math.round(h * 0.075)))) {
      const last = boxes[boxes.length - 1]
      // Isolated radicals can be separated by as much whitespace as letters.
      // A merged square must fit one ideograph cell; reject irregular pitch below.
      if (last && right - last[0] < h * 1.02 && x - last[1] < h * 0.24) last[1] = right
      else boxes.push([x, right])
    }
    if (boxes.length < 4 || boxes.length > 40) return null
    const centers = boxes.map(([x, r]) => (x + r) / 2)
    const distances = centers.slice(1).map((c, i) => c - centers[i])
    const sorted = [...distances].sort((a, b) => a - b)
    const pitch = sorted[Math.floor(sorted.length / 2)]
    // Full-width Han may contain proportional spaces between phrases.
    if (
      pitch < 0.88 * h ||
      pitch > 1.35 * h ||
      distances.some((delta) => delta < 0.84 * pitch || delta > 1.65 * pitch)
    )
      return null
    return boxes.map(
      ([x, r]) => profile({ pixels, stride: width }, { x, y: start, w: r - x + 1, h })!
    )
  })
}

const tile = 96
export class GlyphFont {
  // Typeface changes reuse the scratch canvases; keep at most two 11 MB atlases.
  private static canvas: OffscreenCanvas | undefined
  private static readonly atlases = new Map<GlyphFont, Uint8Array>()
  private readonly ctx: OffscreenCanvasRenderingContext2D
  private readonly anchors = new Map<string, Uint8Array>()
  constructor(private readonly name: string) {
    GlyphFont.canvas ??= new OffscreenCanvas(tile * 16, tile * 8)
    const ctx = GlyphFont.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Optical glyph canvas unavailable')
    this.ctx = ctx
  }

  private static compact: OffscreenCanvas | undefined
  private render(chars: string[], resolution = bins): Uint8Array[] {
    const width = Math.min(16, chars.length) * resolution
    const height = Math.ceil(chars.length / 16) * resolution
    GlyphFont.compact ??= new OffscreenCanvas(fineBins * 16, fineBins * 8)
    const reduced = GlyphFont.compact.getContext('2d', { willReadFrequently: true })!
    this.ctx.font = this.name
    this.ctx.fillStyle = 'white'
    this.ctx.clearRect(0, 0, tile * 16, tile * 8)
    reduced.clearRect(0, 0, width, height)
    reduced.imageSmoothingQuality = 'high'
    const metrics = chars.map((ch, i) => {
      const x = (i % 16) * tile + 4,
        y = Math.floor(i / 16) * tile + 80
      this.ctx.fillText(ch, x, y)
      const m = this.ctx.measureText(ch)
      return [
        x - m.actualBoundingBoxLeft,
        y - m.actualBoundingBoxAscent,
        m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
        m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
      ]
    })
    metrics.forEach(([x, y, w, h], i) => {
      if (w > 0 && h > 0)
        reduced.drawImage(
          GlyphFont.canvas!,
          x,
          y,
          w,
          h,
          (i % 16) * resolution,
          Math.floor(i / 16) * resolution,
          resolution,
          resolution
        )
    })
    const { data } = reduced.getImageData(0, 0, width, height)
    return chars.map((_, i) => {
      const x = (i % 16) * resolution,
        y = Math.floor(i / 16) * resolution
      return Uint8Array.from(
        { length: resolution * resolution },
        (_, j) => data[((y + Math.floor(j / resolution)) * width + x + (j % resolution)) * 4 + 3]
      )
    })
  }

  anchor(ch: string): Uint8Array {
    let glyph = this.anchors.get(ch)
    if (!glyph) {
      if (this.anchors.size >= 512) this.anchors.clear()
      glyph = this.render([ch])[0]
      this.anchors.set(ch, glyph)
    }
    return glyph
  }

  private readonly details = new Map<string, Uint8Array>()
  detail(ch: string): Uint8Array {
    let value = this.details.get(ch)
    if (!value) {
      if (this.details.size >= 512) this.details.clear()
      value = this.render([ch], fineBins)[0]
      this.details.set(ch, value)
    }
    return value
  }
  nearest(shape: Uint8Array, fine?: Uint8Array, original?: string): string | null {
    const size = bins * bins
    const start = 0x3400,
      end = 0xa000
    let atlas = GlyphFont.atlases.get(this)
    if (!atlas) {
      atlas = new Uint8Array((end - start) * size)
      for (let cp = start; cp < end; cp += 128) {
        const batch = Array.from({ length: Math.min(128, end - cp) }, (_, i) =>
          String.fromCharCode(cp + i)
        )
        for (const [i, glyph] of this.render(batch).entries())
          atlas.set(glyph, (cp + i - start) * size)
      }
      if (GlyphFont.atlases.size >= 2) {
        const oldest = GlyphFont.atlases.keys().next().value
        if (oldest) GlyphFont.atlases.delete(oldest)
      }
      GlyphFont.atlases.set(this, atlas)
    }
    let best = Infinity,
      second = Infinity,
      third = Infinity,
      winner = '',
      runner = ''
    for (let cp = start; cp < end; cp++) {
      const dist = distance(shape, atlas, (cp - start) * size)
      if (dist < best) {
        third = second
        runner = winner
        second = best
        best = dist
        winner = String.fromCharCode(cp)
      } else if (dist < second) {
        third = second
        second = dist
        runner = String.fromCharCode(cp)
      } else third = Math.min(third, dist)
    }
    if (best >= 0.035) return null
    if (second - best > 0.028) return winner
    if (
      !fine ||
      !original ||
      winner === original ||
      !runner ||
      best > 0.028 ||
      third - best < 0.028 ||
      runner !== original
    )
      return null
    // Near-identical glyphs need a decisive match on the particular strokes
    // distinguishing the two finalists, with no third plausible interpretation.
    const proposed = this.detail(winner),
      prior = this.detail(original)
    let changed = 0,
      observed = 0,
      previous = 0
    for (let i = 0; i < fine.length; i++) {
      if (Math.abs(prior[i] - proposed[i]) < 110) continue
      changed++
      observed += (fine[i] - proposed[i]) ** 2
      previous += (fine[i] - prior[i]) ** 2
    }
    return changed >= 15 && observed < 0.18 * previous && observed < changed * 255 ** 2 * 0.07
      ? winner
      : null
  }
}

export function distance(a: Uint8Array, b: Uint8Array, offset = 0): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[offset + i]) ** 2
  return sum / (255 * 255 * a.length)
}

export function hasUnexplainedStroke(shape: Uint8Array, template: Uint8Array): boolean {
  for (let y = 1; y < fineBins - 1; y++)
    for (let x = 1; x < fineBins - 1; x++) {
      const i = y * fineBins + x
      const a = shape[i],
        b = template[i]
      if (Math.abs(a - b) < 110) continue
      const target = a > b ? template : shape
      let adjacent = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          adjacent = Math.max(adjacent, target[i + dy * fineBins + dx])
        }
      if (Math.max(a, b) - adjacent > 65) return true
    }
  return false
}
