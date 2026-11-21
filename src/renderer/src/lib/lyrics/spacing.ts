import { measureLyricsRow } from './mixed-spacing'

type TextBox = { left: number; right: number; top: number; bottom: number; text: string }

function inkColumns(
  box: Omit<TextBox, 'text'>,
  image: ImageData,
  coloredType = false
): Uint16Array[] {
  const left = Math.max(0, Math.floor(box.left))
  const right = Math.min(image.width, Math.ceil(box.right))
  const top = Math.max(0, Math.floor(box.top))
  const bottom = Math.min(image.height, Math.ceil(box.bottom))
  const height = bottom - top
  if (right <= left || height < 8) return []

  const light = new Uint16Array(right - left)
  const dark = new Uint16Array(right - left)
  for (let y = top; y < bottom; y++) {
    let pixel = (y * image.width + left) * 4
    for (let x = 0; x < light.length; x++, pixel += 4) {
      const luma = (image.data[pixel] + 2 * image.data[pixel + 1] + image.data[pixel + 2]) / 4
      if (
        luma >= 224 ||
        (coloredType &&
          luma >= 128 &&
          Math.max(image.data[pixel], image.data[pixel + 1], image.data[pixel + 2]) >= 224)
      )
        light[x]++
      if (luma <= 31) dark[x]++
    }
  }

  return [light, dark]
}

export function hasVisibleWordGap(
  previous: TextBox,
  next: TextBox,
  image: ImageData,
  minGap: number
): boolean {
  // Detector padding can put the actual gap just outside the shared box edges.
  const edge = Math.max(
    minGap * 2,
    Math.min(previous.right - previous.left, next.right - next.left) * 0.15
  )
  const overlap = {
    left: Math.max(previous.left, Math.min(next.left, previous.right) - edge),
    right: Math.min(next.right, Math.max(next.left, previous.right) + edge),
    top: Math.min(previous.top, next.top),
    bottom: Math.max(previous.bottom, next.bottom)
  }
  return inkColumns(overlap, image, true).some((ink) => {
    let lastInk = -1
    for (let x = 0; x < ink.length; x++) {
      if (ink[x] < 2) continue
      if (lastInk >= 0 && x - lastInk - 1 >= minGap) return true
      lastInk = x
    }
    return false
  })
}

export function restoreLyricsSpaces(box: TextBox, image: ImageData): string {
  const { text } = box
  const glyphs = [...text.matchAll(/(\S)( ?)/gu)]
  const compact = text.replaceAll(' ', '')
  const han = /^[\p{Script=Han}、。！？；：，]{2,}$/u.test(compact)
  if (!han && !/^[\p{Script=Latin}\p{N}]{2,}$/u.test(compact)) return text

  // shortcut: use clear ink gaps until the OCR runtime exposes character positions.
  const height = box.bottom - box.top
  if (han && height < 28) return text
  const spaceGap = height * (han ? 0.25 : 0.19)
  const candidates = inkColumns(box, image, !han).flatMap((ink) => {
    const starts: number[] = []
    const widths: number[] = []
    let start = -1
    let lastInk = -1
    for (let x = 0; x < ink.length; x++) {
      if (ink[x] < 2) continue
      if (start < 0 || x - lastInk - 1 >= (han ? spaceGap : 1)) {
        if (start >= 0) widths.push(lastInk - start + 1)
        starts.push(x)
        start = x
      }
      lastInk = x
    }
    if (start < 0) return []
    widths.push(lastInk - start + 1)
    const gaps = starts.slice(1).map((x, i) => x - starts[i] - widths[i])
    const spaceAfter = new Set<number>()
    if (han) {
      if (widths.length < 2) return []
      if (widths.length === glyphs.length && Math.max(...gaps) - Math.min(...gaps) < height * 0.1)
        return []
      // Han characters have roughly equal advances, even when strokes split a glyph.
      const advance = widths.reduce((sum, width) => sum + width, 0) / glyphs.length
      if (advance < height * 0.4 || advance > height * 1.35) return []
      const counts = widths.map((width) => Math.round(width / advance))
      if (
        widths.some((width, i) => !counts[i] || Math.abs(width / advance - counts[i]) > 0.24) ||
        counts.reduce((sum, count) => sum + count, 0) !== glyphs.length
      )
        return []
      let end = 0
      for (const count of counts.slice(0, -1)) {
        end += count
        if (/\p{Script=Han}/u.test(glyphs[end - 1][1]) && /\p{Script=Han}/u.test(glyphs[end][1]))
          spaceAfter.add(end - 1)
      }
    } else {
      if (widths.length !== glyphs.length) return []
      // Existing word boundaries are alignment anchors: if one lands inside a glyph,
      // a touching pair or a split stroke has offset the entire column sequence.
      if (glyphs.some((match, i) => match[2] && gaps[i] < spaceGap)) return []
      gaps.forEach((gap, i) => {
        if (gap >= spaceGap) spaceAfter.add(i)
      })
    }
    return [
      glyphs
        .map(([, glyph, space], i) => glyph + (space || (spaceAfter.has(i) ? ' ' : '')))
        .join('')
    ]
  })
  return candidates.length && candidates.every((candidate) => candidate === candidates[0])
    ? candidates[0]
    : text
}

// In a monospaced Han row, the centres of adjacent characters share an advance.
// Measuring the empty columns alone mistakes the side bearings of 自 and 日 for spaces.
export function readHanRowSpacing(text: string, boxes: TextBox[], image: ImageData): string {
  const chars = [...text.replaceAll(' ', '')]
  if (chars.length < 2 || !/^\p{Script=Han}+$/u.test(chars.join(''))) return text
  const measured = measureLyricsRow(boxes, image)
  if (!measured) return text
  const fitted = fitHanAdvances(chars, measured)
  if (fitted !== null) return fitted
  // A descender from the preceding row can join two glyphs at the upper border.
  if (measured.runs.length >= chars.length) return text
  const inner = boxes.map((box) => ({ ...box, top: box.top + (box.bottom - box.top) * 0.18 }))
  const inset = measureLyricsRow(inner, image)
  return (inset && fitHanAdvances(chars, { runs: inset.runs, height: measured.height })) ?? text
}

function fitHanAdvances(
  chars: string[],
  measured: { runs: { left: number; right: number }[]; height: number }
): string | null {
  const { runs, height } = measured
  if (runs.length < chars.length || runs.length > 3 * chars.length || height < 20) return null
  // A radical can be disconnected from the rest of a character. Fit the entire
  // row before deciding which ink runs belong together.
  let best = Infinity
  let alternative = Infinity
  let result = ''
  let explored = 0
  const centres: number[] = []
  const evaluate = (): void => {
    const advances = centres.slice(1).map((x, i) => x - centres[i])
    for (let pitch = height * 0.92; pitch <= height * 1.24; pitch += 0.5) {
      let loss = 0.02 * (pitch / height - 1.08) ** 2
      let value = chars[0]
      for (const [i, step] of advances.entries()) {
        const ratio = step / pitch
        const spaced = ratio > 1.145
        const deviation = spaced
          ? Math.min(...[1.25, 1.33, 1.5, 2].map((multiple) => Math.abs(ratio - multiple)))
          : Math.abs(1 - ratio)
        if (deviation > 0.075) {
          loss = Infinity
          break
        }
        loss += (deviation ** 2 + (spaced ? 0.00045 : 0)) / advances.length
        value += (spaced ? ' ' : '') + chars[i + 1]
      }
      if (loss < best) {
        if (result !== value) alternative = best
        best = loss
        result = value
      } else if (value !== result && loss < alternative) alternative = loss
    }
  }
  const visit = (start: number): void => {
    if (++explored > 2048) return
    if (centres.length === chars.length) {
      if (start === runs.length) evaluate()
      return
    }
    const more = chars.length - centres.length - 1
    for (let end = start; end < runs.length - more; end++) {
      const width = runs[end].right - runs[start].left
      if (width > height * 1.25) break
      if (width < height * 0.33) continue
      const centre = (runs[start].left + runs[end].right) / 2
      if (centres.length && centre - centres[centres.length - 1] < height * 0.85) continue
      centres.push(centre)
      visit(end + 1)
      centres.pop()
    }
  }
  visit(0)
  return explored <= 2048 && best < 0.003 && alternative - best > 0.00015 ? result : null
}
