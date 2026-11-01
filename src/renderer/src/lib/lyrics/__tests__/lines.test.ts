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
