import { beforeEach, expect, it, vi } from 'vitest'
import { registerCaptureHandlers } from '../capture'
import type { WindowManager } from '../../windowManager'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sources: vi.fn(),
  display: vi.fn(),
  projectionOpen: vi.fn(),
  handler: null as Parameters<Electron.Session['setDisplayMediaRequestHandler']>[0]
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  },
  desktopCapturer: { getSources: mocks.sources },
  screen: { getDisplayMatching: mocks.display }
}))
const main = { webContents: { mainFrame: { url: 'file:///app/index.html' } } }
const projection = { getBounds: () => ({}), getMediaSourceId: () => 'window:9:0' }
const wm = {
  getMainWindow: () => main,
  getProjectionWindow: () => projection,
  isProjectionOpen: mocks.projectionOpen
} as unknown as WindowManager
const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
const session = {
  setDisplayMediaRequestHandler: (handler: typeof mocks.handler) => {
    mocks.handler = handler
  }
} as Electron.Session
beforeEach(() => {
  mocks.handlers.clear()
  mocks.projectionOpen.mockReturnValue(true)
  mocks.display.mockReturnValue({ id: 2 })
  mocks.sources.mockResolvedValue([
    { id: 'screen:1:0', display_id: '1', name: 'Display one' },
    { id: 'screen:2:0', display_id: '2', name: 'Projection display' },
    { id: 'screen:3:0', display_id: '', name: 'Unknown display' },
    { id: 'window:4:0', display_id: '', name: 'Slides' },
    { id: 'window:9:0', display_id: '', name: 'Projection' }
  ])
  registerCaptureHandlers(wm, session)
})
it('excludes projection display and window and denies foreign or child frames', async () => {
  const list = mocks.handlers.get('capture:get-sources')!
  expect(await list(event)).toEqual([
    { id: 'screen:1:0', label: 'Display one', kind: 'screen' },
    { id: 'window:4:0', label: 'Slides', kind: 'window' }
  ])
  await expect(list({ ...event, senderFrame: {} })).rejects.toThrow()
  await expect(list({ ...event, sender: {} })).rejects.toThrow()
})
it('consumes selection once and checks exclusions again at capture time', async () => {
  await mocks.handlers.get('capture:select-source')!(event, 'screen:1:0')
  mocks.display.mockReturnValue({ id: 1 })
  const callback = vi.fn()
  await mocks.handler!(
    { frame: main.webContents.mainFrame } as Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback
  )
  expect(callback).toHaveBeenCalledWith({})
  mocks.display.mockReturnValue({ id: 2 })
  await mocks.handler!(
    { frame: main.webContents.mainFrame } as Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback
  )
  expect(callback).toHaveBeenLastCalledWith({})
})
it('grants only the chosen source without audio and rejects invalid IDs', async () => {
  const select = mocks.handlers.get('capture:select-source')!
  await expect(select(event, 'screen:2:0')).rejects.toThrow()
  await expect(select(event, { id: 'window:4:0' })).rejects.toThrow()
  await select(event, 'window:4:0')
  const callback = vi.fn()
  await mocks.handler!(
    { frame: main.webContents.mainFrame } as Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback
  )
  expect(callback).toHaveBeenCalledWith({ video: expect.objectContaining({ id: 'window:4:0' }) })
})

it('allows displays again after the reusable projection window is hidden', async () => {
  mocks.projectionOpen.mockReturnValue(false)
  const list = (await mocks.handlers.get('capture:get-sources')!(event)) as Array<{ id: string }>
  expect(list.map((source) => source.id)).toEqual([
    'screen:1:0',
    'screen:2:0',
    'screen:3:0',
    'window:4:0'
  ])
})
