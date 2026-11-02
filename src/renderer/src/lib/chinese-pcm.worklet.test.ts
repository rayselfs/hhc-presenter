import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

it('flushes the final partial audio packet before acknowledging manual finish', () => {
  const messages: unknown[] = []
  let Capture!: new () => {
    process: (inputs: Float32Array[][]) => boolean
    port: { onmessage: (event: { data: string }) => void }
  }
  runInNewContext(readFileSync('src/renderer/src/lib/chinese-pcm.worklet.js', 'utf8'), {
    AudioWorkletProcessor: class {
      port = {
        postMessage: (value: unknown): void => {
          messages.push(value)
        }
      }
    },
    currentFrame: 0,
    registerProcessor: (_name: string, value: typeof Capture): void => {
      Capture = value
    }
  })
  const capture = new Capture()
  const pcm = new Float32Array(128).fill(0.1)
  capture.process([[pcm]])
  expect(messages).toHaveLength(0)
  capture.port.onmessage({ data: 'finish' })
  expect(messages).toHaveLength(2)
  expect(Array.from(new Float32Array((messages[0] as { pcm: ArrayBuffer }).pcm))).toEqual(
    Array.from(pcm)
  )
  expect(messages[1]).toEqual({ finished: true })
  expect(capture.process([[pcm]])).toBe(false)
})
