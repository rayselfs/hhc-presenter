import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { FakeBrowserWindow } = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []

    options: Record<string, unknown>

    webContents = {
      getURL: vi.fn(() => 'file:///app/index.html'),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = this.webContentsHandlers.get(event) ?? []
        handlers.push(handler)
        this.webContentsHandlers.set(event, handlers)
      }),
      send: vi.fn(),
      isDestroyed: vi.fn(() => false)
    }

    loadURL = vi.fn(() => Promise.resolve())
    loadFile = vi.fn(() => Promise.resolve())
    once = vi.fn((event: string, handler: () => void) => {
      this.onceHandlers.set(event, handler)
    })
    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = this.onHandlers.get(event) ?? []
      handlers.push(handler)
      this.onHandlers.set(event, handlers)
    })
    isDestroyed = vi.fn(() => false)
    isMinimized = vi.fn(() => false)
    isVisible = vi.fn(() => true)
    restore = vi.fn()
    showInactive = vi.fn()
    moveTop = vi.fn()
    focus = vi.fn()
    show = vi.fn()
    hide = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setFullScreen = vi.fn()
    setSimpleFullScreen = vi.fn()
    setFocusable = vi.fn()
    maximize = vi.fn()
    setAlwaysOnTop = vi.fn()
    close = vi.fn()
    destroy = vi.fn()

    private onceHandlers = new Map<string, () => void>()
    private onHandlers = new Map<string, Array<(...args: unknown[]) => void>>()
    private webContentsHandlers = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeBrowserWindow.instances.push(this)
    }

    emitOnce(event: string): void {
      this.onceHandlers.get(event)?.()
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.onHandlers.get(event) ?? []) handler(...args)
    }

    emitWebContents(event: string, ...args: unknown[]): void {
      for (const handler of this.webContentsHandlers.get(event) ?? []) handler(...args)
    }
  }

  return { FakeBrowserWindow }
})

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }
    })),
    getAllDisplays: vi.fn(() => [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
    ]),
    on: vi.fn()
  },
  app: {
    quit: vi.fn()
  },
  shell: {
    openExternal: vi.fn()
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: false }
}))

import { WindowManager } from '../windowManager'
import { optimizer } from '@electron-toolkit/utils'

describe('WindowManager', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    vi.clearAllMocks()
    const instance = WindowManager.getInstance()
    instance.cleanup()
    FakeBrowserWindow.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  })

  it('getInstance returns a singleton', () => {
    const a = WindowManager.getInstance()
    const b = WindowManager.getInstance()
    expect(a).toBe(b)
  })

  it('getMainWindow returns null before creation', () => {
    const wm = WindowManager.getInstance()
    expect(wm.getMainWindow()).toBeNull()
  })

  it('getProjectionWindow returns null before creation', () => {
    const wm = WindowManager.getInstance()
    expect(wm.getProjectionWindow()).toBeNull()
  })

  it('isProjectionOpen returns false before creation', () => {
    const wm = WindowManager.getInstance()
    expect(wm.isProjectionOpen()).toBe(false)
  })

  it('sendToProjection does nothing when no projection window', () => {
    const wm = WindowManager.getInstance()
    expect(() => wm.sendToProjection('projection:message' as never, ...([] as never))).not.toThrow()
  })

  it('sendToMain does nothing when no main window', () => {
    const wm = WindowManager.getInstance()
    expect(() =>
      wm.sendToMain('projection:lifecycle', {
        generation: 0,
        status: 'closed',
        reason: 'user-close'
      })
    ).not.toThrow()
  })

  it('closeProjection does nothing when no projection window', () => {
    const wm = WindowManager.getInstance()
    expect(() => wm.closeProjection()).not.toThrow()
  })

  it('cleanup sets both windows to null', () => {
    const wm = WindowManager.getInstance()
    wm.cleanup()
    expect(wm.getMainWindow()).toBeNull()
    expect(wm.getProjectionWindow()).toBeNull()
  })

  it('leaves shortcut watcher registration to the app-level window hook', () => {
    const wm = WindowManager.getInstance()

    wm.createMainWindow()
    wm.createProjectionWindow()

    expect(optimizer.watchWindowShortcuts).not.toHaveBeenCalled()
  })

  it('does not change the control window state when an external display exists', () => {
    const wm = WindowManager.getInstance()

    wm.createMainWindow()
    const control = FakeBrowserWindow.instances[0]
    control.emitOnce('ready-to-show')

    expect(control.maximize).not.toHaveBeenCalled()
    expect(control.setFullScreen).not.toHaveBeenCalled()
    expect(control.show).toHaveBeenCalledOnce()
  })

  it('rejects external top-level navigation and allows the loaded app document', () => {
    const wm = WindowManager.getInstance()
    wm.createMainWindow()
    const mainWindow = FakeBrowserWindow.instances[0]
    const externalEvent = { preventDefault: vi.fn() }
    const externalFileEvent = { preventDefault: vi.fn() }
    const internalEvent = { preventDefault: vi.fn() }

    mainWindow.emitWebContents('will-navigate', externalEvent, 'https://account.alive.org.tw/login')
    mainWindow.emitWebContents('will-navigate', externalFileEvent, 'file://evil/app/index.html')
    mainWindow.emitWebContents('will-navigate', internalEvent, 'file:///app/index.html#/files')

    expect(externalEvent.preventDefault).toHaveBeenCalledOnce()
    expect(externalFileEvent.preventDefault).toHaveBeenCalledOnce()
    expect(internalEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('getDisplays returns all displays', () => {
    const wm = WindowManager.getInstance()
    const displays = wm.getDisplays()
    expect(displays).toHaveLength(2)
    expect(displays[0].id).toBe(1)
    expect(displays[1].id).toBe(2)
  })

  it('creates an output-only projection at the selected display bounds', () => {
    const wm = WindowManager.getInstance()

    wm.createProjectionWindow('2')

    const projection = FakeBrowserWindow.instances[0]
    expect(projection.options).toMatchObject({
      width: 1920,
      height: 1080,
      x: 1920,
      y: 0,
      show: false,
      frame: false,
      fullscreen: process.platform === 'win32',
      enableLargerThanScreen: true,
      focusable: process.platform === 'darwin',
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      movable: false,
      resizable: false
    })
    expect(projection.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
  })

  it('uses native fullscreen for a Windows external projection display', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const wm = WindowManager.getInstance()

    wm.createProjectionWindow('2')

    expect(FakeBrowserWindow.instances[0].options.fullscreen).toBe(true)
  })

  it('uses macOS simple fullscreen without keeping projection always on top', () => {
    const wm = WindowManager.getInstance()
    wm.createMainWindow()
    wm.createProjectionWindow('2')
    const control = FakeBrowserWindow.instances[0]
    const projection = FakeBrowserWindow.instances[1]

    projection.emitOnce('ready-to-show')

    expect(projection.showInactive).toHaveBeenCalledOnce()
    expect(projection.focus).not.toHaveBeenCalled()
    expect(projection.moveTop).not.toHaveBeenCalled()
    expect(projection.setFullScreen).not.toHaveBeenCalled()
    expect(projection.show).not.toHaveBeenCalled()
    expect(projection.setAlwaysOnTop).not.toHaveBeenCalled()
    if (process.platform === 'darwin') {
      expect(projection.setSimpleFullScreen).toHaveBeenCalledWith(true)
      expect(projection.setFocusable).toHaveBeenCalledWith(false)
      expect(control.focus).toHaveBeenCalledOnce()
    }
  })

  it('consumes exactly one main-window close permit', () => {
    const wm = WindowManager.getInstance()
    wm.createMainWindow()
    const mainWindow = FakeBrowserWindow.instances[0]
    const firstClose = { preventDefault: vi.fn() }

    mainWindow.emit('close', firstClose)

    expect(firstClose.preventDefault).toHaveBeenCalledOnce()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('app:close-requested')

    expect(wm.confirmMainWindowClose()).toBe(true)
    expect(mainWindow.close).toHaveBeenCalledOnce()

    const permittedClose = { preventDefault: vi.fn() }
    mainWindow.emit('close', permittedClose)
    expect(permittedClose.preventDefault).not.toHaveBeenCalled()

    const thirdClose = { preventDefault: vi.fn() }
    mainWindow.emit('close', thirdClose)
    expect(thirdClose.preventDefault).toHaveBeenCalledOnce()
  })

  it('allows the main window to close after its renderer exits', () => {
    const wm = WindowManager.getInstance()
    wm.createMainWindow()
    const mainWindow = FakeBrowserWindow.instances[0]
    mainWindow.emitWebContents('render-process-gone', {}, { reason: 'crashed' })
    const closeEvent = { preventDefault: vi.fn() }

    mainWindow.emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('app:close-requested')
  })

  it('does not guard projection-window close events', () => {
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow()
    const projectionWindow = FakeBrowserWindow.instances[0]
    const closeEvent = { preventDefault: vi.fn() }

    projectionWindow.emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(projectionWindow.webContents.send).not.toHaveBeenCalledWith('app:close-requested')
  })

  it('allocates once for initial load and once for a later reload', () => {
    const wm = WindowManager.getInstance()
    const first = wm.createProjectionWindow()
    const projection = FakeBrowserWindow.instances[0]
    projection.emitWebContents('did-finish-load')
    projection.emitWebContents('did-start-loading')

    expect(first).toBe(1)
    expect(wm.getProjectionState().lifecycle).toMatchObject({
      generation: 2,
      status: 'opening',
      reason: 'reload'
    })
  })

  it('marks only the current projection generation ready', () => {
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow()

    expect(wm.markProjectionReady(2)).toBe(false)
    expect(wm.markProjectionReady(1)).toBe(true)
    expect(wm.getProjectionState().lifecycle).toMatchObject({
      generation: 1,
      status: 'ready'
    })
  })

  it('authorizes only the current projection sender and generation', () => {
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow()
    const projection = FakeBrowserWindow.instances[0]

    expect(wm.isCurrentProjectionSender(projection.webContents as never, 1)).toBe(true)
    expect(wm.isCurrentProjectionSender(projection.webContents as never, 2)).toBe(false)
    expect(wm.isCurrentProjectionSender({} as never, 1)).toBe(false)
  })

  it('moves to another display with a new generation without reporting user close', () => {
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow()

    const result = wm.moveProjectionWindow('2')

    expect(result).toEqual({ moved: true, generation: 2 })
    expect(wm.getProjectionState()).toMatchObject({
      exists: true,
      lifecycle: {
        generation: 2,
        status: 'opening',
        reason: 'display-move'
      }
    })
    expect(FakeBrowserWindow.instances[1].options.x).toBe(1920)
  })

  it('discards a hidden projection surface on display change without opening a new output window', () => {
    const wm = WindowManager.getInstance()
    const generation = wm.createProjectionWindow()
    const projection = FakeBrowserWindow.instances[0]
    wm.markProjectionReady(generation)
    wm.closeProjection()

    expect(wm.moveProjectionWindow('2')).toEqual({ moved: true, generation: 0 })
    expect(projection.close).toHaveBeenCalledOnce()
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(wm.getProjectionState().exists).toBe(false)
  })

  it('recovers one renderer crash and fails the second inside 30 seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow('2')
    FakeBrowserWindow.instances[0].emitWebContents('render-process-gone', {}, { reason: 'crashed' })

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(wm.getProjectionState().lifecycle).toMatchObject({
      generation: 2,
      status: 'recovering',
      reason: 'renderer-crash'
    })
    expect(FakeBrowserWindow.instances[1].options.x).toBe(1920)

    vi.setSystemTime(20_000)
    FakeBrowserWindow.instances[1].emitWebContents('render-process-gone', {}, { reason: 'crashed' })

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(wm.getProjectionState()).toMatchObject({
      exists: false,
      lifecycle: {
        generation: 2,
        status: 'failed',
        reason: 'renderer-crash'
      }
    })
  })

  it('allows another automatic recovery after 30 seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow('2')
    FakeBrowserWindow.instances[0].emitWebContents('render-process-gone', {}, { reason: 'crashed' })

    vi.setSystemTime(31_001)
    FakeBrowserWindow.instances[1].emitWebContents('render-process-gone', {}, { reason: 'crashed' })

    expect(FakeBrowserWindow.instances).toHaveLength(3)
    expect(wm.getProjectionState().lifecycle).toMatchObject({
      generation: 3,
      status: 'recovering',
      reason: 'renderer-crash'
    })
  })

  it('recovers a clean renderer exit when no window close was requested', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow()

    FakeBrowserWindow.instances[0].emitWebContents(
      'render-process-gone',
      {},
      { reason: 'clean-exit' }
    )

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(wm.getProjectionState().lifecycle).toMatchObject({
      generation: 2,
      status: 'recovering',
      reason: 'renderer-crash'
    })
  })

  it('replaces an opening projection when Retry is requested', () => {
    const wm = WindowManager.getInstance()
    const firstGeneration = wm.createProjectionWindow()
    const firstWindow = FakeBrowserWindow.instances[0]

    expect(wm.retryProjectionWindow()).toEqual({
      retried: true,
      generation: firstGeneration + 1
    })
    expect(firstWindow.close).toHaveBeenCalledOnce()
    expect(FakeBrowserWindow.instances).toHaveLength(2)

    const replacement = FakeBrowserWindow.instances[1]
    firstWindow.emit('closed')
    firstWindow.emitWebContents('render-process-gone', {}, { reason: 'clean-exit' })
    expect(wm.getProjectionWindow()).toBe(replacement)
    expect(wm.getProjectionState().lifecycle).toMatchObject({
      generation: firstGeneration + 1,
      status: 'opening'
    })
  })

  it('does not Retry a closed or ready projection', () => {
    const wm = WindowManager.getInstance()
    expect(wm.retryProjectionWindow()).toEqual({ retried: false, generation: 0 })

    const generation = wm.createProjectionWindow()
    expect(wm.markProjectionReady(generation)).toBe(true)
    expect(wm.retryProjectionWindow()).toEqual({ retried: false, generation })
    expect(FakeBrowserWindow.instances).toHaveLength(1)
  })

  it('manual Retry resets the automatic crash budget', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow()
    FakeBrowserWindow.instances[0].emitWebContents('render-process-gone', {}, { reason: 'crashed' })
    vi.setSystemTime(2_000)
    FakeBrowserWindow.instances[1].emitWebContents('render-process-gone', {}, { reason: 'crashed' })

    expect(wm.retryProjectionWindow()).toEqual({ retried: true, generation: 3 })
    vi.setSystemTime(3_000)
    FakeBrowserWindow.instances[2].emitWebContents('render-process-gone', {}, { reason: 'crashed' })

    expect(FakeBrowserWindow.instances).toHaveLength(4)
    expect(wm.getProjectionState().lifecycle.generation).toBe(4)
  })

  it('hides a stopped projection and reuses its ready renderer for the next session', () => {
    const wm = WindowManager.getInstance()
    wm.markProjectionReady(wm.createProjectionWindow())
    const projection = FakeBrowserWindow.instances[0]

    wm.closeProjection()

    expect(projection.hide).toHaveBeenCalledOnce()
    expect(projection.close).not.toHaveBeenCalled()
    expect(wm.getProjectionState()).toEqual({
      exists: false,
      lifecycle: {
        generation: 0,
        status: 'closed',
        reason: 'user-close'
      }
    })

    expect(wm.createProjectionWindow()).toBe(2)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(projection.showInactive).toHaveBeenCalledOnce()
    expect(wm.getProjectionState()).toMatchObject({
      exists: true,
      lifecycle: { generation: 2, status: 'opening', reason: 'created' }
    })
  })

  it('does not focus a crash recovery or display replacement', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const wm = WindowManager.getInstance()
    wm.createProjectionWindow()
    wm.moveProjectionWindow('2')
    const moved = FakeBrowserWindow.instances[1]
    moved.emitOnce('ready-to-show')
    moved.emitWebContents('render-process-gone', {}, { reason: 'crashed' })
    const recovered = FakeBrowserWindow.instances[2]
    recovered.emitOnce('ready-to-show')

    expect(moved.moveTop).not.toHaveBeenCalled()
    expect(recovered.moveTop).not.toHaveBeenCalled()
    expect(moved.focus).not.toHaveBeenCalled()
    expect(recovered.focus).not.toHaveBeenCalled()
    expect(moved.setAlwaysOnTop).not.toHaveBeenCalled()
    expect(recovered.setAlwaysOnTop).not.toHaveBeenCalled()
    if (process.platform === 'darwin') {
      expect(moved.setSimpleFullScreen).toHaveBeenCalledWith(true)
      expect(recovered.setSimpleFullScreen).toHaveBeenCalledWith(true)
    }
  })
})
