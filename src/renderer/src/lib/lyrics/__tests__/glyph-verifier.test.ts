import { createGlyphVerifier } from '../glyph-verifier'

class TestWorker {
  static current: TestWorker
  onmessage?: (e: { data: string[] }) => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    TestWorker.current = this
  }
}
const image = {} as ImageData
const raw = ['甲乙丙丁']
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', TestWorker)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('invalidates a cached fallback when a slow optical correction finally arrives', async () => {
  const refresh = vi.fn(),
    verifier = createGlyphVerifier(refresh)
  const pending = verifier.verify(image, raw)
  vi.advanceTimersByTime(10000)
  expect(await pending).toEqual(raw)
  TestWorker.current.onmessage?.({ data: ['甲乙戊丁'] })
  expect(refresh).toHaveBeenCalledOnce()
  const retry = verifier.verify(image, raw)
  TestWorker.current.onmessage?.({ data: ['甲乙戊丁'] })
  expect(await retry).toEqual(['甲乙戊丁'])
  expect(refresh).toHaveBeenCalledOnce()
  verifier.dispose()
})
it('rechecks a skipped frame and ignores late replies after stopping', async () => {
  const refresh = vi.fn(),
    verifier = createGlyphVerifier(refresh)
  const pending = verifier.verify(image, raw)
  vi.advanceTimersByTime(10000)
  await pending
  expect(await verifier.verify(image, ['甲乙戊丁'])).toEqual(['甲乙戊丁'])
  TestWorker.current.onmessage?.({ data: raw })
  expect(refresh).toHaveBeenCalledOnce()
  const retry = verifier.verify(image, raw)
  verifier.dispose()
  expect(await retry).toEqual(raw)
  TestWorker.current.onmessage?.({ data: ['甲乙戊丁'] })
  expect(refresh).toHaveBeenCalledOnce()
  expect(TestWorker.current.terminate).toHaveBeenCalledOnce()
})
it('replaces a hung worker and ignores its stale callback', async () => {
  const verifier = createGlyphVerifier(),
    first = verifier.verify(image, raw)
  const original = TestWorker.current
  vi.advanceTimersByTime(60000)
  expect(await first).toEqual(raw)
  const retry = verifier.verify(image, raw)
  expect(TestWorker.current).not.toBe(original)
  original.onmessage?.({ data: ['舊'] })
  TestWorker.current.onmessage?.({ data: ['甲乙戊丁'] })
  expect(await retry).toEqual(['甲乙戊丁'])
  verifier.dispose()
})
it('keeps subtitle output Traditional after optical substitutions and insertions', async () => {
  const verifier = createGlyphVerifier()
  const source = [
    '我們同心',
    '我同心',
    '我問同心',
    '人皆甲願',
    '前僕後繼',
    '山後是海',
    '稱是我主',
    '甲乙祢丁',
    '甲乙祂丁',
    '甲乙醉丁',
    '甲乙嘿丁'
  ]
  const optical = [
    '我们同心',
    '我们同心',
    '我们同心',
    '人皆发願',
    '前仆後繼',
    '山后是海',
    '祢是我主',
    '甲乙袮丁',
    '甲乙衪丁',
    '甲乙醡丁',
    '甲乙嘸丁'
  ]
  const pending = verifier.verify(image, source)
  TestWorker.current.onmessage?.({ data: optical })
  expect(await pending).toEqual([
    '我們同心',
    '我們同心',
    '我們同心',
    source[3],
    optical[4],
    source[5],
    ...optical.slice(6)
  ])
  verifier.dispose()
})
