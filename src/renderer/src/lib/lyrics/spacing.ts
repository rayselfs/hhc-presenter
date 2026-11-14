type TextBox = { left: number; right: number; top: number; bottom: number; text: string }

function inkColumns(box: Omit<TextBox, 'text'>, image: ImageData): Uint16Array[] {
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
      if (luma >= 224) light[x]++
      if (luma <= 31) dark[x]++
    }
  }

  return [light, dark]
}

export function hasOverlappingWordGap(
  previous: TextBox,
  next: TextBox,
  image: ImageData,
  minGap: number
): boolean {
  if (next.left >= previous.right) return false
  // Detector padding can put the actual gap just outside the shared box edges.
  const edge = Math.min(previous.right - previous.left, next.right - next.left) * 0.15
  const overlap = {
    left: Math.max(previous.left, next.left - edge),
    right: Math.min(next.right, previous.right + edge),
    top: Math.min(previous.top, next.top),
    bottom: Math.max(previous.bottom, next.bottom)
  }
  return inkColumns(overlap, image).some((ink) => {
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
  const spaceGap = height * (han ? 0.22 : 0.19)
  const candidates = inkColumns(box, image).flatMap((ink) => {
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
        spaceAfter.add(end - 1)
      }
    } else {
      if (widths.length !== glyphs.length) return []
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
