import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  allowed: true,
  install: vi.fn(),
  remove: vi.fn(),
  transcribe: vi.fn(),
  dispose: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/profile', on: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  },
  powerMonitor: { on: vi.fn() }
}))
vi.mock('node:fs', () => {
  const api = { existsSync: () => true }
  return { ...api, default: api }
})
vi.mock('node:fs/promises', () => {
  const api = { rm: vi.fn(async () => {}), readFile: vi.fn(), stat: vi.fn() }
  return { ...api, default: api }
})
vi.mock('./validate', () => ({ isMainWindow: () => mocks.allowed }))
vi.mock('../speechModels', () => ({
  SpeechModels: class {
    install = mocks.install
    remove = mocks.remove
    cancel = mocks.cancel
  },
  verifySpeechFile: vi.fn()
}))
vi.mock('../localSpeechRuntime', () => ({
  LocalSpeechRuntime: class {
    dispose = mocks.dispose
    stop = mocks.stop
    transcribe = mocks.transcribe
  }
}))
import { registerLocalSpeech } from './local-speech'
import type { WindowManager } from '../windowManager'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.allowed = true
  registerLocalSpeech({
    getMainWindow: () => ({ webContents: { on: vi.fn() } })
  } as unknown as WindowManager)
})
it('rejects unknown windows before downloading or deleting models', () => {
  mocks.allowed = false
  for (const channel of ['speech:model-install', 'speech:model-remove'])
    expect(() => mocks.handlers.get(channel)!({}, 'zh')).toThrow('Unauthorized')
  expect(mocks.install).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled()
})
it('accepts only supported languages and never renderer-supplied paths', () => {
  expect(() => mocks.handlers.get('speech:model-install')!({}, '../../secrets')).toThrow(
    'Invalid recognition'
  )
  expect(mocks.install).not.toHaveBeenCalled()
  mocks.handlers.get('speech:model-install')!({}, 'zh')
  expect(mocks.install).toHaveBeenCalledWith('zh')
})
it('rejects audio without an active prepared session', () => {
  expect(() =>
    mocks.handlers.get('speech:local-transcribe')!({}, 'stale', new Float32Array(320))
  ).toThrow('invalid-audio')
  expect(mocks.transcribe).not.toHaveBeenCalled()
})
