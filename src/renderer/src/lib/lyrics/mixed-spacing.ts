type Box = { left: number; right: number; top: number; bottom: number }
type InkRun = { left: number; right: number }
type MeasuredRow = { runs: InkRun[]; height: number; inkTop: number; background: number }

export function measureLyricsRow(boxes: Box[], image: ImageData): MeasuredRow | null {
  if (!boxes.length) return null
  const left = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.left))))
  const right = Math.min(image.width, Math.ceil(Math.max(...boxes.map((b) => b.right))))
  const top = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.top))))
  const bottom = Math.min(image.height, Math.ceil(Math.max(...boxes.map((b) => b.bottom))))
  const measured = measureRowWithin(left, right, top, bottom, image)
  if (measured || bottom - top < 28) return measured
  // Tight detector boxes can end inside the glyphs. Retry using the surrounding
  // pixels and require the same uniform top and bottom perimeter on this attempt.
  const padding = Math.ceil((bottom - top) * 0.12)
  return measureRowWithin(
    left,
    right,
    Math.max(0, top - padding),
    Math.min(image.height, bottom + padding),
    image
  )
}

function measureRowWithin(
  left: number,
  right: number,
  top: number,
  bottom: number,
  image: ImageData
): MeasuredRow | null {
  if (bottom - top < 28 || right <= left) return null
  const rgb = (x: number, y: number): number => {
    const i = 4 * (y * image.width + x)
    return (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2]
  }
  // Only interpret glyph widths on a uniform background.
  const corners = [
    rgb(left, top),
    rgb(right - 1, top),
    rgb(left, bottom - 1),
    rgb(right - 1, bottom - 1)
  ]
  const background = corners.find((color) => corners.filter((c) => c === color).length >= 2)
  if (background === undefined) return null
  const contrast = (color: number): number =>
    Math.max(
      Math.abs((color >> 16) - (background >> 16)),
      Math.abs(((color >> 8) & 255) - ((background >> 8) & 255)),
      Math.abs((color & 255) - (background & 255))
    )
  // A detector box can contain several pixels from an adjacent line at either edge.
  // Trim only a broad fragment touching that edge across a clean blank separator.
  const trimEdge = (y: number, step: number): number => {
    const edge = y
    const extent = Math.floor((bottom - top) * 0.18)
    for (let n = 0; n <= extent; n++, y += step) {
      let first = right,
        last = left - 1
      for (let x = left; x < right; x++) {
        if (contrast(rgb(x, y)) < 96) continue
        first = Math.min(first, x)
        last = x
      }
      if (last < first) return y
      if (!n && last - first < (right - left) * 0.35) break
    }
    return edge
  }
  top = trimEdge(top, 1)
  bottom = trimEdge(bottom - 1, -1) + 1
  let matching = 0
  for (let x = left; x < right; x++) {
    if (rgb(x, top) === background) matching++
    if (rgb(x, bottom - 1) === background) matching++
  }
  if (matching < 1.8 * (right - left)) return null
  const runs: { left: number; right: number }[] = []
  let inkTop = bottom,
    inkBottom = top
  for (let x = left; x < right; x++) {
    let ink = false
    for (let y = top; y < bottom; y++) {
      const color = rgb(x, y)
      if (contrast(color) < 96) continue
      ink = true
      inkTop = Math.min(inkTop, y)
      inkBottom = Math.max(inkBottom, y)
    }
    if (!ink) continue
    const last = runs.at(-1)
    if (last && last.right === x) last.right++
    else runs.push({ left: x, right: x + 1 })
  }
  const height = inkBottom - inkTop + 1
  return height >= 20 && runs.length ? { runs, height, inkTop, background } : null
}

const han = /\p{Script=Han}/u
const latin = /\p{Script=Latin}/u

// An exact visual repeat can still contain touching glyphs inside either copy.
// Its midpoint gives an independent location for the word break.
function hasSeparatedCopies({ runs, height }: MeasuredRow): boolean {
  const midpoint = (runs[0].left + runs[runs.length - 1].right) / 2
  let centerGap = 0
  let otherGap = 0
  for (let i = 1; i < runs.length; i++) {
    const left = runs[i - 1].right
    const right = runs[i].left
    if (left <= midpoint && right >= midpoint) centerGap = right - left
    else otherGap = Math.max(otherGap, right - left)
  }
  return centerGap > Math.max(height * 0.2, otherGap * 1.5)
}

// A lost curly apostrophe appears as an extra, raised run inside a word. Its heavier
// end distinguishes the two orientations. A uniform vertical stroke is ambiguous.
function readRaisedQuote(run: InkRun, row: MeasuredRow, image: ImageData): string {
  if (run.right - run.left > row.height * 0.23) return ''
  const weights: number[] = []
  let top = -1
  let bottom = -1
  for (let y = 0; y < row.height; y++) {
    let weight = 0
    for (let x = run.left; x < run.right; x++) {
      const i = ((row.inkTop + y) * image.width + x) * 4
      if (
        Math.max(
          Math.abs(image.data[i] - (row.background >> 16)),
          Math.abs(image.data[i + 1] - ((row.background >> 8) & 255)),
          Math.abs(image.data[i + 2] - (row.background & 255))
        ) >= 96
      )
        weight++
    }
    weights.push(weight)
    if (weight) {
      if (top < 0) top = y
      bottom = y
    }
  }
  if (
    top < 0 ||
    top > row.height * 0.2 ||
    bottom > row.height * 0.4 ||
    bottom - top < row.height * 0.15
  )
    return ''
  const mid = Math.ceil((top + bottom) / 2)
  const upper = weights.slice(top, mid).reduce((n, w) => n + w, 0)
  const lower = weights.slice(mid + 1, bottom + 1).reduce((n, w) => n + w, 0)
  if (lower > upper * 1.6) return '‘'
  if (upper > lower * 1.6) return '’'
  return ''
}

function restoreRaisedQuotes(text: string, row: MeasuredRow, image: ImageData): string {
  const words = text.split(' ')
  const gaps = row.runs.slice(1).map((run, i) => run.left - row.runs[i].right)
  const sorted = [...gaps].sort((a, b) => b - a)
  const threshold = sorted[words.length - 2]
  // Locate *all* the OCR word boundaries independently before associating ink with a word.
  if (
    !threshold ||
    threshold < row.height * 0.21 ||
    threshold <= (sorted[words.length - 1] ?? 0) * 1.25
  )
    return text
  const groups: InkRun[][] = [[]]
  row.runs.forEach((run, i) => {
    if (i && gaps[i - 1] >= threshold) groups.push([])
    groups[groups.length - 1].push(run)
  })
  if (groups.length !== words.length) return text
  return words
    .map((word, i) => {
      const runs = groups[i]
      if (runs.length !== word.length + 1 || !/^[A-Za-z]{2,}$/.test(word)) return word
      for (let j = 1; j < runs.length - 1; j++) {
        const quote = readRaisedQuote(runs[j], row, image)
        if (quote) return word.slice(0, j) + quote + word.slice(j)
      }
      return word
    })
    .join(' ')
}

// A full-width comma paints near the left of its cell. Its blank right bearing is
// part of the glyph. Measure the neighboring Han centres against the row's actual pitch.
function removeCommaBearingSpace(text: string, { runs, height }: MeasuredRow): string {
  const center = (run: InkRun): number => (run.left + run.right) / 2
  const wide = (run: InkRun): boolean => run.right - run.left >= height * 0.65
  const pitches = runs
    .slice(1)
    .flatMap((run, i) => {
      const delta = center(run) - center(runs[i])
      return wide(run) && wide(runs[i]) && delta >= height * 0.9 && delta <= height * 1.18
        ? [delta]
        : []
    })
    .sort((a, b) => a - b)
  if (pitches.length < 3) return text
  const pitch = pitches[Math.floor(pitches.length / 2)]
  const commas = runs.filter((run, i) => {
    const before = runs[i - 1],
      after = runs[i + 1]
    if (!before || !after || run.right - run.left > pitch * 0.2 || !wide(before) || !wide(after))
      return false
    const offset = (center(run) - center(before)) / pitch
    return (
      offset > 0.5 && offset < 0.85 && Math.abs((center(after) - center(before)) / pitch - 2) < 0.08
    )
  })
  return commas.length === 1 ? text.replace('， ', '，') : text
}

export function readMixedRowSpacing(text: string, boxes: Box[], image: ImageData): string {
  const chars = [...text.replaceAll(' ', '')]
  const hasHan = han.test(text)
  const half = chars.length / 2
  const repeated =
    !hasHan &&
    Number.isInteger(half) &&
    half >= 3 &&
    /^[\p{Script=Latin}-]+$/u.test(chars.join('')) &&
    chars.slice(0, half).join('') === chars.slice(half).join('')
  const latinWords = /^[A-Za-z][A-Za-z ,.!?'-]+$/.test(text) && text.includes(' ')
  const commaSpace = /^\p{Script=Han}+， \p{Script=Han}+$/u.test(text)
  if (
    !commaSpace &&
    !latinWords &&
    !repeated &&
    !(hasHan && /[\p{Script=Latin}～〜~!?！？()]/u.test(text))
  )
    return text

  const row = measureLyricsRow(boxes, image)
  if (!row) return text
  if (commaSpace) return removeCommaBearingSpace(text, row)
  if (latinWords && !repeated) return restoreRaisedQuotes(text, row, image)
  const spaces = new Set<number>()
  if (repeated) {
    if (hasSeparatedCopies(row)) spaces.add(half)
  } else {
    const { runs, height } = row
    let k = 0
    for (let i = 0; i < chars.length - 1 && k < runs.length - 1; i++) {
      const ch = chars[i]
      const next = chars[i + 1]
      const left = runs[k].left
      let right = runs[k].right
      // Han radicals may occupy separate runs within a single full-width cell.
      if (han.test(ch) || /[～〜]/u.test(ch)) {
        while (
          right - left < height * 0.65 &&
          k + 1 < runs.length &&
          runs[k + 1].left - right <= height * 0.11 &&
          runs[k + 1].right - left <= height * 1.13
        ) {
          right = runs[++k].right
        }
        if (right - left < height * 0.6 || right - left > height * 1.23) break
      } else if (right - left > height * 1.2) break
      k++
      if (k === runs.length) break
      const gap = (runs[k].left - right) / height
      const scriptChange = (latin.test(ch) && han.test(next)) || (han.test(ch) && latin.test(next))
      if (
        (scriptChange && gap >= 0.37) ||
        (/[～〜~]/u.test(ch) && han.test(next) && gap >= 0.32) ||
        (/[!?！？]/u.test(ch) && ((han.test(next) && gap >= 0.54) || (next === '(' && gap >= 0.35)))
      ) {
        spaces.add(i + 1)
      }
    }
  }
  if (!spaces.size) return text
  return [...text.matchAll(/( *)(\S)/gu)]
    .map(([, space, ch], i) => (space || (spaces.has(i) ? ' ' : '')) + ch)
    .join('')
}
