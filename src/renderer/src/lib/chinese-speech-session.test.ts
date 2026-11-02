import { ChineseSpeechSession } from './chinese-speech-session'
import type { ChineseSpeechResult } from '@shared/chinese-speech'

const result: ChineseSpeechResult = {
  text: '創世記第一章第一節',
  reference: [1, 1, 1],
  asrMs: 1,
  locateMs: 1
}
const silence = (ms: number): Float32Array => new Float32Array(ms * 16)
const voice = (): Float32Array => new Float32Array(320).fill(1 / 32768)

it('keeps a quiet prefix and internal pauses; a stale partial cannot navigate', async () => {
  const resolve: Array<(result: ChineseSpeechResult) => void> = []
  const decode = vi.fn(
    (_pcm: Float32Array) => new Promise<ChineseSpeechResult>((done) => resolve.push(done))
  )
  const complete = vi.fn()
  const session = new ChineseSpeechSession(decode, complete, vi.fn(), () => 3000)
  session.push(voice(), 0)
  session.push(silence(800), 20)
  expect(decode).toHaveBeenCalledTimes(1)
  session.push(voice(), 820)
  resolve[0](result)
  await new Promise((done) => setTimeout(done, 0))
  expect(complete).not.toHaveBeenCalled()
  session.push(silence(1500), 840)
  expect(decode).toHaveBeenCalledTimes(2)
  expect(decode.mock.calls[1][0].length).toBe((20 + 800 + 20 + 1500) * 16)
  resolve[1]({ ...result, reference: null })
  await new Promise((done) => setTimeout(done, 0))
  expect(complete).toHaveBeenCalledOnce()
  expect(complete.mock.calls[0][0].result.reference).toBeNull()
})

it('does not publish after stop or decode pure silence', async () => {
  let finish!: (value: ChineseSpeechResult) => void
  const decode = vi.fn(
    () =>
      new Promise<ChineseSpeechResult>((resolve) => {
        finish = resolve
      })
  )
  const complete = vi.fn()
  const session = new ChineseSpeechSession(decode, complete, vi.fn())
  session.push(silence(2000), 0)
  expect(decode).not.toHaveBeenCalled()
  session.push(voice(), 2000)
  session.push(silence(1500), 2020)
  session.stop()
  finish(result)
  await new Promise((done) => setTimeout(done, 0))
  expect(complete).not.toHaveBeenCalled()
})

it('rejects overlong speech without cutting it into navigable fragments', () => {
  const error = vi.fn()
  const decode = vi.fn()
  const session = new ChineseSpeechSession(decode, vi.fn(), error)
  session.push(new Float32Array(480001).fill(0.01), 0)
  expect(error).toHaveBeenCalledOnce()
  expect(decode).not.toHaveBeenCalled()
})
