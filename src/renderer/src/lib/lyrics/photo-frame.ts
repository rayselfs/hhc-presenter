function colorDistance(
  data: Uint8ClampedArray,
  offset: number,
  r: number,
  g: number,
  b: number
): number {
  return Math.max(
    Math.abs(data[offset] - r),
    Math.abs(data[offset + 1] - g),
    Math.abs(data[offset + 2] - b)
  )
}

// A flat text color repeats exactly even when the underlying photo has thousands of colors.
// Accept it only when it explains most sharp edges and is confined to a few bands of rows.
export function photoLyricsFrame(image: ImageData): ImageData | null {
  const { width, height, data } = image
  const counts = new Map<number, number>()
  let samples = 0
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4
      const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
      counts.set(rgb, (counts.get(rgb) ?? 0) + 1)
      samples++
    }
  }
  let ink = 0
  let mode = 0
  let runnerUp = 0
  for (const [color, count] of counts) {
    if (count > mode) {
      runnerUp = mode
      mode = count
      ink = color
    } else if (count > runnerUp) {
      runnerUp = count
    }
  }
  if (mode < samples * 0.01 || mode > samples * 0.2 || mode < runnerUp * 2) return null

  const r = ink >> 16
  const g = (ink >> 8) & 255
  const b = ink & 255
  const hasAdjacentInk = (x: number, y: number): boolean => {
    for (let sy = Math.max(0, y - 4); sy <= Math.min(height - 1, y + 4); sy += 4) {
      for (let sx = Math.max(0, x - 8); sx <= Math.min(width - 1, x + 4); sx += 4) {
        if (colorDistance(data, (sy * width + sx) * 4, r, g, b) <= 32) return true
      }
    }
    return false
  }

  let edges = 0
  let inkEdges = 0
  let rowsWithInk = 0
  for (let y = 0; y < height; y += 4) {
    let near = 0
    let unexplained = 0
    for (let x = 4; x < width; x += 4) {
      const i = (y * width + x) * 4
      const left = i - 16
      const matchesInk = colorDistance(data, i, r, g, b) <= 32
      if (matchesInk) near++
      if (colorDistance(data, left, data[i], data[i + 1], data[i + 2]) < 48) continue
      edges++
      if (matchesInk || colorDistance(data, left, r, g, b) <= 32) {
        inkEdges++
      } else if (!hasAdjacentInk(x, y)) {
        // A second stroke color can be a small word within a line or an entire
        // shorter line. Its two edges survive even if the dominant ink explains 99%.
        if (++unexplained >= 2) return null
      }
    }
    if (near >= 2) rowsWithInk++
  }
  if (!edges || inkEdges < edges * 0.85 || rowsWithInk * 4 > height * 0.6) return null

  const masked = new ImageData(width, height)
  for (let i = 0; i < data.length; i += 4) {
    const shade = Math.min(255, colorDistance(data, i, r, g, b) * 8)
    masked.data[i] = shade
    masked.data[i + 1] = shade
    masked.data[i + 2] = shade
    masked.data[i + 3] = 255
  }
  return masked
}
