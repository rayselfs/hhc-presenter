import { it, expect } from 'vitest'
import { isChineseSpeechPcm, isChineseSpeechResult } from './chinese-speech'

it('bounds PCM and rejects non-finite values before crossing the native boundary', () => {
  expect(isChineseSpeechPcm(new Float32Array([0, 1 / 32768, -1]))).toBe(true)
  for (const value of [
    [],
    new Float32Array(),
    new Float32Array(480001),
    new Float32Array([NaN]),
    new Float32Array([Infinity]),
    new Float32Array([1.01])
  ]) {
    expect(isChineseSpeechPcm(value)).toBe(false)
  }
})

it('rejects malformed native references and timings', () => {
  const result = { text: '創世記', reference: [1, 1, 1], asrMs: 10, locateMs: 1 }
  expect(isChineseSpeechResult(result)).toBe(true)
  expect(isChineseSpeechResult({ ...result, reference: null })).toBe(true)
  for (const value of [
    [67, 1, 1],
    [1, 0, 1],
    [1, 1],
    [1, 1, 1.5]
  ]) {
    expect(isChineseSpeechResult({ ...result, reference: value })).toBe(false)
  }
  expect(isChineseSpeechResult({ ...result, asrMs: NaN })).toBe(false)
})
