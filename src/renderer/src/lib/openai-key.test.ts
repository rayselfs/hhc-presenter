import { afterEach, expect, it, vi } from 'vitest'
import { saveSpeechKey, speechToken, forgetSpeechKey, hasSpeechKey } from './openai-key'
vi.mock('./env', () => ({ isElectron: () => false }))
afterEach(async () => {
  await forgetSpeechKey()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('keeps browser credentials in memory and exchanges them only with OpenAI', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const request = vi.fn().mockResolvedValue(Response.json({ value: 'ephemeral' }))
  vi.stubGlobal('fetch', request)
  await saveSpeechKey('sk-test-fixture')
  expect(await speechToken('zh')).toBe('ephemeral')
  expect(request).toHaveBeenCalledWith(
    'https://api.openai.com/v1/realtime/client_secrets',
    expect.objectContaining({ redirect: 'error' })
  )
  expect(write).not.toHaveBeenCalled()
  await forgetSpeechKey()
  expect(await hasSpeechKey()).toBe(false)
  await expect(speechToken('zh')).rejects.toThrow()
})
