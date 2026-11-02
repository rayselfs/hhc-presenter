import { expect, it, vi } from 'vitest'
import { clearRetiredSpeechKeys } from '../speech-key-storage'
it('deletes only retired provider keys without reading secrets', () => {
  const removeItem = vi.fn()
  const getItem = vi.fn()
  vi.stubGlobal('localStorage', { removeItem, getItem })
  clearRetiredSpeechKeys()
  expect(removeItem.mock.calls).toEqual([['hhc-speech-key-azure'], ['hhc-speech-key-gcp']])
  expect(getItem).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
it('retries after temporarily blocked storage', () => {
  const removeItem = vi.fn().mockImplementationOnce(() => {
    throw new Error('blocked')
  })
  vi.stubGlobal('localStorage', { removeItem })
  clearRetiredSpeechKeys()
  clearRetiredSpeechKeys()
  expect(removeItem).toHaveBeenCalledTimes(4)
  vi.unstubAllGlobals()
})
