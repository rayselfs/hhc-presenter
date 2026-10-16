import { beforeEach, expect, it, vi } from 'vitest'
import type { WindowManager } from '../../windowManager'
import { registerSpeechKeyStorageHandlers } from '../../ipc/speech-key-storage'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, provider: unknown, key?: unknown) => unknown>(),
  isMainWindow: vi.fn(() => true),
  getPath: vi.fn(() => '/synthetic-user-data'),
  read: vi.fn(() => Buffer.from('encrypted-fixture')),
  write: vi.fn(),
  unlink: vi.fn(),
  exists: vi.fn(() => true),
  encrypt: vi.fn(() => Buffer.from('encrypted-fixture')),
  decrypt: vi.fn(() => 'fixture-key')
}))
vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  safeStorage: { encryptString: mocks.encrypt, decryptString: mocks.decrypt },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, provider: unknown, key?: unknown) => unknown
    ) => mocks.handlers.set(channel, handler)
  }
}))
vi.mock('fs', () => {
  const fs = {
    readFileSync: mocks.read,
    writeFileSync: mocks.write,
    unlinkSync: mocks.unlink,
    existsSync: mocks.exists
  }
  return { ...fs, default: fs }
})
vi.mock('../../ipc/validate', () => ({ isMainWindow: mocks.isMainWindow }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.isMainWindow.mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  registerSpeechKeyStorageHandlers({} as WindowManager)
})

it.each(['/../../hhc-auth', '../azure', '..\\gcp', '', ' ', 'whisper', 'AZURE', null, 1])(
  'rejects provider %j before filesystem or crypto access',
  (provider) => {
    for (const channel of ['speech:saveKey', 'speech:loadKey', 'speech:deleteKey']) {
      try {
        mocks.handlers.get(channel)!({}, provider, 'fixture-key')
      } catch {
        /* Rejection may preserve the handler's existing return contract. */
      }
    }
    expect(mocks.getPath).not.toHaveBeenCalled()
    expect(mocks.exists).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.unlink).not.toHaveBeenCalled()
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(mocks.decrypt).not.toHaveBeenCalled()
  }
)

it.each(['azure', 'gcp'])('preserves valid %s key operations', (provider) => {
  const path = `/synthetic-user-data/speech-api-key-${provider}.enc`
  mocks.handlers.get('speech:saveKey')!({}, provider, 'fixture-key')
  expect(mocks.encrypt).toHaveBeenCalledWith('fixture-key')
  expect(mocks.write).toHaveBeenCalledWith(path, Buffer.from('encrypted-fixture'))
  expect(mocks.handlers.get('speech:loadKey')!({}, provider)).toBe('fixture-key')
  expect(mocks.read).toHaveBeenCalledWith(path)
  mocks.handlers.get('speech:deleteKey')!({}, provider)
  expect(mocks.unlink).toHaveBeenCalledWith(path)
})

it('rejects an untrusted renderer before looking up any key path', () => {
  mocks.isMainWindow.mockReturnValue(false)
  for (const channel of ['speech:saveKey', 'speech:loadKey', 'speech:deleteKey'])
    mocks.handlers.get(channel)!({}, 'azure', 'fixture-key')
  expect(mocks.getPath).not.toHaveBeenCalled()
  expect(mocks.encrypt).not.toHaveBeenCalled()
  expect(mocks.decrypt).not.toHaveBeenCalled()
})
