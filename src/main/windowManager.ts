import { BrowserWindow, screen, app, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { IpcMainToRendererChannel, IpcMainToRendererMap } from '@shared/ipc-channels'
import type {
  ProjectionLifecycleEvent,
  ProjectionLifecycleReason,
  ProjectionWindowState
} from '@shared/projection-messages'

let _cachedDisplay: Electron.Display | null | undefined = undefined

function isInternalNavigation(currentValue: string, nextValue: string): boolean {
  try {
    const current = new URL(currentValue)
    const next = new URL(nextValue)
    if (next.username || next.password) return false
    if (current.protocol === 'file:') {
      return (
        next.protocol === 'file:' &&
        next.hostname === current.hostname &&
        next.pathname === current.pathname
      )
    }
    return (
      (current.protocol === 'http:' || current.protocol === 'https:') &&
      next.origin === current.origin
    )
  } catch {
    return false
  }
}

export class WindowManager {
  private static instance: WindowManager
  private mainWindow: BrowserWindow | null = null
  private projectionWindow: BrowserWindow | null = null
  private mainClosePermit = false
  private mainRendererGone = false
  private projectionGeneration = 0
  private projectionLifecycle: ProjectionLifecycleEvent = {
    generation: 0,
    status: 'closed',
    reason: 'user-close'
  }
  private projectionDisplayId = ''
  private lastAutomaticRecoveryAt: number | null = null
  private closingProjectionWindows = new WeakSet<BrowserWindow>()

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- singleton pattern requires private constructor
  private constructor() {}

  static getInstance(): WindowManager {
    if (!WindowManager.instance) {
      WindowManager.instance = new WindowManager()
    }
    return WindowManager.instance
  }

  private getExternalDisplay(): Electron.Display | undefined {
    if (_cachedDisplay !== undefined) {
      return _cachedDisplay === null ? undefined : _cachedDisplay
    }

    const primaryId = screen.getPrimaryDisplay().id
    const externalDisplay = screen.getAllDisplays().find((d) => d.id !== primaryId)
    _cachedDisplay = externalDisplay ?? null

    return externalDisplay
  }

  private getProjectionDisplay(displayId = ''): Electron.Display {
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()

    if (displayId) {
      const selected = displays.find(
        (display) => String(display.id) === displayId && display.id !== primaryDisplay.id
      )
      if (selected) return selected
    }

    return this.getExternalDisplay() || primaryDisplay
  }

  createMainWindow(): void {
    this.mainRendererGone = false
    screen.on('display-added', () => {
      _cachedDisplay = undefined
    })
    screen.on('display-removed', () => {
      _cachedDisplay = undefined
    })

    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      },
      title: 'HHC Presenter'
    })

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https:') || url.startsWith('http:')) {
        shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    this.guardTopLevelNavigation(this.mainWindow)

    const loadPromise =
      is.dev && process.env['ELECTRON_RENDERER_URL']
        ? this.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
        : this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

    loadPromise.catch((err) => {
      console.error('Failed to load main window:', err)
    })

    this.mainWindow.webContents.on('render-process-gone', (_event, details) => {
      this.mainRendererGone = true
      console.error('Main window renderer crashed:', details.reason)
    })

    this.mainWindow.on('close', (event) => {
      if (this.mainRendererGone) return
      if (this.mainClosePermit) {
        this.mainClosePermit = false
        return
      }
      event.preventDefault()
      this.sendToMain('app:close-requested')
    })

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show()
    })

    this.mainWindow.on('closed', () => {
      this.mainWindow = null
      app.quit()
    })
  }

  private publishProjectionLifecycle(
    event: ProjectionLifecycleEvent,
    notifyProjection = true
  ): void {
    this.projectionLifecycle = event
    this.sendToMain('projection:lifecycle', event)
    if (notifyProjection) this.sendToProjection('projection:lifecycle', event)
  }

  private guardTopLevelNavigation(window: BrowserWindow): void {
    window.webContents.on('will-navigate', (event, url) => {
      if (!isInternalNavigation(window.webContents.getURL(), url)) event.preventDefault()
    })
  }

  private nextProjectionGeneration(
    status: 'opening' | 'recovering',
    reason: ProjectionLifecycleReason
  ): number {
    this.projectionGeneration += 1
    this.publishProjectionLifecycle({
      generation: this.projectionGeneration,
      status,
      reason
    })
    return this.projectionGeneration
  }

  createProjectionWindow(
    displayId = '',
    reason: 'created' | 'display-move' | 'renderer-crash' = 'created'
  ): number {
    if (this.isProjectionOpen()) return this.projectionGeneration

    const reusableProjectionWindow = this.projectionWindow
    if (
      this.projectionLifecycle.status === 'closed' &&
      reusableProjectionWindow &&
      !reusableProjectionWindow.isDestroyed()
    ) {
      const generation = this.nextProjectionGeneration('opening', reason)
      reusableProjectionWindow.showInactive()
      return generation
    }

    const primaryDisplay = screen.getPrimaryDisplay()
    const targetDisplay = this.getProjectionDisplay(displayId)
    const hasSecondScreen = targetDisplay.id !== primaryDisplay.id
    const useMacSimpleFullscreen = process.platform === 'darwin' && hasSecondScreen
    const useWindowsNativeFullscreen = process.platform === 'win32' && hasSecondScreen
    this.projectionDisplayId = String(targetDisplay.id)
    const windowGeneration = this.nextProjectionGeneration(
      reason === 'renderer-crash' ? 'recovering' : 'opening',
      reason
    )
    let hasFinishedInitialLoad = false

    const projectionWindow = new BrowserWindow({
      width: hasSecondScreen ? targetDisplay.bounds.width : 800,
      height: hasSecondScreen ? targetDisplay.bounds.height : 600,
      x: targetDisplay.bounds.x,
      y: targetDisplay.bounds.y,
      fullscreen: useWindowsNativeFullscreen,
      enableLargerThanScreen: hasSecondScreen,
      frame: false,
      focusable: useMacSimpleFullscreen,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      movable: false,
      resizable: false,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      },
      title: 'Projection'
    })
    projectionWindow.setIgnoreMouseEvents(true)
    this.projectionWindow = projectionWindow
    this.guardTopLevelNavigation(projectionWindow)

    const loadPromise =
      is.dev && process.env['ELECTRON_RENDERER_URL']
        ? projectionWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/projection')
        : projectionWindow.loadFile(join(__dirname, '../renderer/index.html'), {
            hash: '/projection'
          })

    loadPromise.catch((err) => {
      console.error('Failed to load projection window:', err)
    })

    projectionWindow.webContents.on('render-process-gone', (_event, details) => {
      if (
        this.projectionWindow !== projectionWindow ||
        this.projectionGeneration !== windowGeneration
      ) {
        return
      }
      console.error('Projection window renderer crashed:', details.reason)
      const wasClosing = this.closingProjectionWindows.has(projectionWindow)
      this.projectionWindow = null
      if (!projectionWindow.isDestroyed()) projectionWindow.destroy()
      if (wasClosing) return

      const now = Date.now()
      if (this.lastAutomaticRecoveryAt !== null && now - this.lastAutomaticRecoveryAt < 30_000) {
        this.publishProjectionLifecycle({
          generation: windowGeneration,
          status: 'failed',
          reason: 'renderer-crash'
        })
        return
      }

      this.lastAutomaticRecoveryAt = now
      this.createProjectionWindow(this.projectionDisplayId, 'renderer-crash')
    })

    projectionWindow.once('ready-to-show', () => {
      if (this.projectionWindow !== projectionWindow) return
      projectionWindow.showInactive()
      if (useMacSimpleFullscreen) {
        projectionWindow.setSimpleFullScreen(true)
        projectionWindow.setFocusable(false)
        this.mainWindow?.focus()
      }
    })

    projectionWindow.webContents.on('did-start-loading', () => {
      if (
        !hasFinishedInitialLoad ||
        this.projectionWindow !== projectionWindow ||
        this.projectionGeneration !== windowGeneration
      ) {
        return
      }
      this.publishProjectionLifecycle(
        {
          generation: windowGeneration,
          status: 'opening',
          reason: 'reload'
        },
        false
      )
      hasFinishedInitialLoad = false
    })

    projectionWindow.webContents.on('did-finish-load', () => {
      if (
        this.projectionWindow !== projectionWindow ||
        this.projectionGeneration !== windowGeneration
      ) {
        return
      }
      hasFinishedInitialLoad = true
    })

    projectionWindow.on('closed', () => {
      if (this.projectionWindow !== projectionWindow) return
      this.projectionWindow = null
      this.projectionGeneration = 0
      this.lastAutomaticRecoveryAt = null
      this.publishProjectionLifecycle({
        generation: 0,
        status: 'closed',
        reason: 'user-close'
      })
    })

    return windowGeneration
  }

  moveProjectionWindow(displayId: string): { moved: boolean; generation: number } {
    const projectionWindow = this.projectionWindow
    if (!projectionWindow || projectionWindow.isDestroyed()) {
      return { moved: false, generation: this.projectionGeneration }
    }

    const wasProjecting = this.isProjectionOpen()
    this.closingProjectionWindows.add(projectionWindow)
    this.projectionWindow = null
    projectionWindow.close()
    if (!wasProjecting) {
      this.projectionGeneration = 0
      return { moved: true, generation: 0 }
    }
    const generation = this.createProjectionWindow(displayId, 'display-move')
    return { moved: true, generation }
  }

  retryProjectionWindow(): { retried: boolean; generation: number } {
    if (
      this.projectionLifecycle.status === 'closed' ||
      this.projectionLifecycle.status === 'ready'
    ) {
      return { retried: false, generation: this.projectionGeneration }
    }
    const projectionWindow = this.projectionWindow
    if (projectionWindow) {
      this.projectionWindow = null
      if (!projectionWindow.isDestroyed()) {
        this.closingProjectionWindows.add(projectionWindow)
        projectionWindow.close()
      }
    }
    this.lastAutomaticRecoveryAt = null
    const generation = this.createProjectionWindow(this.projectionDisplayId, 'created')
    return { retried: true, generation }
  }

  getProjectionState(): ProjectionWindowState {
    return {
      exists: this.isProjectionOpen(),
      lifecycle: this.projectionLifecycle
    }
  }

  markProjectionReady(generation: number): boolean {
    if (
      generation !== this.projectionGeneration ||
      !this.isProjectionOpen() ||
      this.projectionLifecycle.status === 'failed'
    ) {
      return false
    }
    this.publishProjectionLifecycle({
      generation,
      status: 'ready',
      reason: this.projectionLifecycle.reason
    })
    return true
  }

  isCurrentProjectionSender(sender: Electron.WebContents, generation: number): boolean {
    return (
      generation === this.projectionGeneration &&
      this.projectionWindow !== null &&
      !this.projectionWindow.isDestroyed() &&
      this.projectionWindow.webContents === sender
    )
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  getProjectionWindow(): BrowserWindow | null {
    return this.projectionWindow
  }

  confirmMainWindowClose(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false
    this.mainClosePermit = true
    this.mainWindow.close()
    return true
  }

  sendToProjection<C extends IpcMainToRendererChannel>(
    channel: C,
    ...args: IpcMainToRendererMap[C]
  ): void {
    if (this.projectionWindow && !this.projectionWindow.isDestroyed()) {
      this.projectionWindow.webContents.send(channel, ...args)
    }
  }

  sendToMain<C extends IpcMainToRendererChannel>(
    channel: C,
    ...args: IpcMainToRendererMap[C]
  ): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args)
    }
  }

  closeProjection(): void {
    const projectionWindow = this.projectionWindow
    const reusable = projectionWindow && !projectionWindow.isDestroyed()
    if (reusable) {
      if (this.projectionGeneration > 0) {
        this.sendToProjection('projection:message', this.projectionGeneration, '__system:blank', {
          showDefault: true
        })
      }
      projectionWindow.hide()
    }
    if (!reusable) this.projectionGeneration = 0
    this.lastAutomaticRecoveryAt = null
    this.publishProjectionLifecycle({
      generation: 0,
      status: 'closed',
      reason: 'user-close'
    })
  }

  isProjectionOpen(): boolean {
    return (
      this.projectionWindow !== null &&
      !this.projectionWindow.isDestroyed() &&
      (this.projectionLifecycle.status === 'opening' ||
        this.projectionLifecycle.status === 'ready' ||
        this.projectionLifecycle.status === 'recovering')
    )
  }

  getDisplays(): Electron.Display[] {
    return screen.getAllDisplays()
  }

  getPrimaryDisplayId(): number {
    return screen.getPrimaryDisplay().id
  }

  cleanup(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.destroy()
    }
    this.mainWindow = null
    this.mainClosePermit = false
    this.mainRendererGone = false

    if (this.projectionWindow && !this.projectionWindow.isDestroyed()) {
      this.projectionWindow.destroy()
    }
    this.projectionWindow = null
    this.projectionGeneration = 0
    this.projectionLifecycle = {
      generation: 0,
      status: 'closed',
      reason: 'user-close'
    }
    this.projectionDisplayId = ''
    this.lastAutomaticRecoveryAt = null
    this.closingProjectionWindows = new WeakSet<BrowserWindow>()
  }
}

export default WindowManager
