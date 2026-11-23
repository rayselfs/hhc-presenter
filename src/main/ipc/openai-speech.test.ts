import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WindowManager } from '../windowManager'
const mock = vi.hoisted(() => ({
  directory: '',
  safe: true,
  trusted: true,
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => mock.directory },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mock.handlers.set(name, handler)
  },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => mock.safe,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: vi.fn(async () => Buffer.from('ciphertext')),
    decryptStringAsync: vi.fn(async () => ({ result: 'sk-fixture-only' }))
  }
}))
vi.mock('./validate', () => ({ isMainWindow: () => mock.trusted }))
import { registerOpenAISpeech } from './openai-speech'
const frame = {}
const event = { senderFrame: frame, sender: { mainFrame: frame } }
const call = (name: string, ...args: unknown[]): Promise<unknown> =>
  mock.handlers.get('speech:' + name)!(event, ...args)
beforeEach(async () => {
  mock.directory = await mkdtemp(join(tmpdir(), 'byok-test-'))
  mock.safe = true
  mock.trusted = true
  registerOpenAISpeech({} as WindowManager)
})
afterEach(async () => {
  await rm(mock.directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})
it('stores ciphertext only, returns a short-lived credential and supports unlinking', async () => {
  await call('save', 'sk-fixture-only')
  expect(await readFile(join(mock.directory, 'openai-speech-key.enc'), 'utf8')).toBe('ciphertext')
  expect(await call('configured')).toBe(true)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ value: 'ek_fixture' })))
  expect(await call('token', 'zh')).toBe('ek_fixture')
  await call('forget')
  expect(await call('configured')).toBe(false)
})
it('rejects untrusted windows and refuses plaintext fallback', async () => {
  mock.trusted = false
  await expect(call('token', 'en')).rejects.toThrow('Unauthorized')
  mock.trusted = true
  mock.safe = false
  await expect(call('save', 'sk-fixture-only')).rejects.toThrow('Secure storage')
  expect(await call('configured')).toBe(false)
})
