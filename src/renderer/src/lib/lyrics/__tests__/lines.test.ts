import { createLyricsGate, readLyricsLines, samePixels, type LyricsBlock } from '../lines'
const box = (text: string, x: number, y: number, score = 0.99): LyricsBlock => ({
  text,
  score,
  poly: [
    [x, y],
    [x + 100, y],
    [x + 100, y + 40],
    [x, y + 40]
  ]
})
it('preserves three visual rows and reads fragments left to right without reflow', () => {
  expect(
    readLyricsLines([
      box('第三行！', 100, 200),
      box('字', 210, 2),
      box('第二行', 100, 100),
      box('第一行', 100, 0)
    ])
  ).toEqual(['第一行字', '第二行', '第三行！'])
})
it('rejects a low-confidence fragment rather than silently dropping a line', () => {
  expect(() => readLyricsLines([box('第一行', 0, 0), box('第三行', 0, 100, 0.4)])).toThrow()
  expect(() => readLyricsLines([{ ...box('x', 0, 0), poly: [[NaN, 0]] }])).toThrow()
  expect(readLyricsLines([])).toEqual([])
})
it('stabilizes the full line structure and resets on uncertain recognition', () => {
  const gate = createLyricsGate()
  expect(gate.observe(['甲乙', '丙'])).toBeNull()
  expect(gate.observe(['甲乙', '丙'])).toEqual(['甲乙', '丙'])
  expect(gate.observe(['甲', '乙丙'])).toBeNull()
  gate.reset()
  expect(gate.observe(['甲', '乙丙'])).toBeNull()
  expect(gate.observe(['甲', '乙丙'])).toEqual(['甲', '乙丙'])
})

it('never skips a one-pixel subtitle change', () => {
  const a = new Uint8ClampedArray([0, 0, 0, 255]),
    b = new Uint8ClampedArray(a)
  expect(samePixels(a, b)).toBe(true)
  b[3] = 254
  expect(samePixels(a, b)).toBe(false)
  expect(samePixels(a, null)).toBe(false)
})

it('preserves visible phrase gaps and normalizes OCR text to Traditional Chinese', () => {
  expect(
    readLyricsLines([box('耶稣', 0, 0), box('耶稣', 160, 0), box('无人能像祢', 320, 0)])
  ).toEqual(['耶穌 耶穌 無人能像祢'])
  expect(readLyricsLines([box('  耶穌　 耶穌  ', 0, 0)])).toEqual(['耶穌 耶穌'])
})
it('ignores unstable Chinese whitespace without ignoring English word boundaries or row structure', () => {
  const gate = createLyricsGate()
  expect(gate.observe(['耶穌 耶穌'])).toBeNull()
  expect(gate.observe(['耶穌耶穌'])).toEqual(['耶穌 耶穌'])
  expect(gate.observe(['耶穌　耶穌'])).toEqual(['耶穌 耶穌'])
  expect(gate.observe(['a name'])).toBeNull()
  expect(gate.observe(['aname'])).toBeNull()
  expect(gate.observe(['耶穌', '耶穌'])).toBeNull()
})
it('requires five seconds of uninterrupted empty observations before clearing', () => {
  vi.useFakeTimers()
  try {
    const gate = createLyricsGate()
    expect(gate.observe([])).toBeNull()
    vi.advanceTimersByTime(100)
    expect(gate.observe([])).toBeNull()
    vi.advanceTimersByTime(4899)
    expect(gate.observe([])).toBeNull()
    vi.advanceTimersByTime(1)
    expect(gate.observe([])).toEqual([])
    gate.reset()
    expect(gate.observe([])).toBeNull()
    vi.advanceTimersByTime(5000)
    gate.observe(['新歌詞'])
    expect(gate.observe([])).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('preserves explicit English word boundaries between adjacent OCR blocks', () => {
  expect(readLyricsLines([box('Amazing ', 0, 0), box('grace', 110, 0)])).toEqual(['Amazing grace'])
  expect(readLyricsLines([box('Amazing', 0, 0), box(' grace', 110, 0)])).toEqual(['Amazing grace'])
})

it('repairs spacing that appears after the first two matching observations', () => {
  const gate = createLyricsGate()
  expect(gate.observe(['耶穌耶穌'])).toBeNull()
  expect(gate.observe(['耶穌耶穌'])).toEqual(['耶穌耶穌'])
  expect(gate.observe(['耶穌 耶穌'])).toEqual(['耶穌 耶穌'])
  expect(gate.observe(['耶穌耶穌'])).toEqual(['耶穌 耶穌'])
})

it('restarts the five-second empty interval after recognition uncertainty', () => {
  vi.useFakeTimers()
  try {
    const gate = createLyricsGate()
    gate.observe([])
    vi.advanceTimersByTime(4000)
    expect(gate.observe([])).toBeNull()
    gate.reset()
    vi.advanceTimersByTime(1000)
    expect(gate.observe([])).toBeNull()
    vi.advanceTimersByTime(4999)
    expect(gate.observe([])).toBeNull()
    vi.advanceTimersByTime(1)
    expect(gate.observe([])).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

it('joins English word boxes across gaps narrower than a Chinese phrase gap', () => {
  expect(readLyricsLines([box('Amazing', 0, 0), box('grace', 110, 0)])).toEqual(['Amazing grace'])
  expect(readLyricsLines([box('grace', 0, 0), box(',', 101, 0)])).toEqual(['grace,'])
  expect(readLyricsLines([box('grace,', 0, 0), box('how', 110, 0)])).toEqual(['grace, how'])
  expect(readLyricsLines([box('Psalm', 0, 0), box('23', 110, 0)])).toEqual(['Psalm 23'])
  expect(readLyricsLines([box('Wor', 0, 0), box('thy', 101, 0)])).toEqual(['Worthy'])
})

function glyphImage(widths: number[], gaps: number[], lightInk: boolean): ImageData {
  const width = 100
  const height = 40
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(lightInk ? 16 : 227)
  let left = 2
  for (const [index, glyph] of widths.entries()) {
    for (let y = 3; y < 37; y++) {
      for (let x = left; x < left + glyph; x++) {
        data.fill(lightInk ? 240 : 27, (y * width + x) * 4, (y * width + x) * 4 + 3)
      }
    }
    left += glyph + (gaps[index] ?? 0)
  }
  return { data, width, height, colorSpace: 'srgb' }
}

it.each([true, false])(
  'recovers Chinese phrase spacing inside one OCR box (light ink: %s)',
  (lightInk) => {
    const image = glyphImage([18, 18, 18, 18], [3, 13, 3], lightInk)
    expect(readLyricsLines([box('恩典无限', 0, 0)], image)).toEqual(['恩典 無限'])
    const condensed = glyphImage([18, 18, 18, 18], [3, 3, 3], lightInk)
    expect(readLyricsLines([box('恩典无限', 0, 0)], condensed)).toEqual(['恩典無限'])
    const tracked = glyphImage([16, 16, 16, 16], [9, 9, 9], lightInk)
    expect(readLyricsLines([box('恩典无限', 0, 0)], tracked)).toEqual(['恩典無限'])
    const partlySpaced = glyphImage([16, 16, 16, 16], [12, 3, 13], lightInk)
    expect(readLyricsLines([box('主 恩满盈', 0, 0)], partlySpaced)).toEqual(['主 恩滿 盈'])
    const splitStroke = glyphImage([8, 8, 18, 18, 18], [12, 3, 3, 3], lightInk)
    expect(readLyricsLines([box('恩典无限', 0, 0)], splitStroke)).toEqual(['恩典無限'])
  }
)

it('recovers missing Latin word spaces only when image columns align to the letters', () => {
  const image = glyphImage([11, 10, 6, 15, 9], [3, 3, 13, 3], true)
  expect(readLyricsLines([box('Ourlord', 0, 0)], image)).toEqual(['Ourlord'])
  expect(readLyricsLines([box('Ourgo', 0, 0)], image)).toEqual(['Our go'])
  expect(
    readLyricsLines([box('Ourgo', 0, 0)], glyphImage([11, 10, 6, 15, 9], [3, 3, 4, 3], true))
  ).toEqual(['Ourgo'])
})

it('finds the visible word gap when padded OCR boxes overlap', () => {
  const poly = (left: number, right: number): number[][] => [
    [left, 0],
    [right, 0],
    [right, 40],
    [left, 40]
  ]
  const blocks = [
    { ...box('Our', 0, 0), poly: poly(0, 54) },
    { ...box('God', 0, 0), poly: poly(39, 100) }
  ]
  expect(readLyricsLines(blocks, glyphImage([34, 36], [12], true))).toEqual(['Our God'])
  expect(readLyricsLines(blocks, glyphImage([34, 36], [1], true))).toEqual(['OurGod'])
})
