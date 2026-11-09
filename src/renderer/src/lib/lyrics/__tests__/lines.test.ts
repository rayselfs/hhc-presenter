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
