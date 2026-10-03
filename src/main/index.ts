import { registerMediaPermissions } from './media-permissions'
import { app, BrowserWindow, ipcMain, nativeTheme, protocol, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { WindowManager } from './windowManager'
import { registerProjectionHandlers } from './ipc/projection'
import { registerTimerHandlers } from './ipc/timer'
import { registerBibleApiHandlers } from './ipc/bible-api'
import { registerAppIpc, registerLocalModelProtocol } from './ipc/app'
import { registerSpeechKeyStorageHandlers } from './ipc/speech-key-storage'
import {
  clearNativeMediaLeases,
  clearStaleNativeMediaLeasesOnStartup,
  registerNativeFsHandlers,
  registerNativeMediaProtocol
} from './ipc/native-fs'
import { registerProjectionVlcHandlers } from './ipc/projection-vlc'
import { registerVideoPosterHandlers } from './ipc/video-poster'
import { cleanupStaleVideoRemuxTemps } from './ipc/video-remux'
import { registerLocalSyncHandlers } from './ipc/local-sync'
import { registerLanRemoteIpc } from './ipc/lan-remote'
import {
  handleOneDriveAuthCallbackUrl,
  registerOneDriveCredentialHandlers
} from './ipc/onedrive-credentials'
import { registerOneDriveDownloadHandlers } from './ipc/onedrive-download'
import { isKnownWindow, validateTheme } from './ipc/validate'
import { registerUpdateService } from './updateService'
import { createHhcAuthService, registerHhcAuthIpc } from './ipc/hhc-auth'
import { registerHhcAssetHandlers } from './ipc/hhc-assets'
import { registerPersonalCloudHandlers } from './ipc/personal-cloud'
import { createHhcPresenterProtocolDispatcher } from './protocol-router'
import { registerAppProtocol } from './app-protocol'

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-model', privileges: { secure: true, supportFetchAPI: true, stream: true } },
  {
    scheme: 'hhc-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

process.on('uncaughtException', (error) => {
  console.error('[MAIN] Uncaught Exception:', error)
  app.quit()
})

process.on('unhandledRejection', (reason) => {
  console.error('[MAIN] Unhandled Rejection:', reason)
})

const wm = WindowManager.getInstance()
const hhcAuthService = createHhcAuthService()
let nativeMediaLeasesCleared = false
let nativeMediaLeaseCleanupPending = false
const protocolDispatcher = createHhcPresenterProtocolDispatcher({
  onAccountAuth: (action) => {
    const mainWindow = wm.getMainWindow()
    mainWindow?.show()
    mainWindow?.focus()
    void hhcAuthService.completeProtocolCallback(action).catch(() => undefined)
  },
  onOneDriveAuth: (url) => {
    handleOneDriveAuthCallbackUrl(url, wm)
  }
})

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (protocolDispatcher.dispatchArgv(argv)) return
    const mainWindow = wm.getMainWindow()
    mainWindow?.show()
    mainWindow?.focus()
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    protocolDispatcher.dispatch(url)
  })
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    await clearStaleNativeMediaLeasesOnStartup()
    void cleanupStaleVideoRemuxTemps().catch((error) => {
      console.warn('[MAIN] Failed to clear stale video remux files', error)
    })
    electronApp.setAppUserModelId('tw.org.alive.presenter')
    registerAppProtocol()

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    ipcMain.handle('theme:get', (event) => {
      if (!isKnownWindow(wm, event)) return { source: 'system', shouldUseDarkColors: false }
      return {
        source: nativeTheme.themeSource,
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors
      }
    })

    ipcMain.handle('theme:set', (event, theme: unknown) => {
      if (!isKnownWindow(wm, event)) return
      if (!validateTheme(theme)) return
      nativeTheme.themeSource = theme as 'light' | 'dark' | 'system'
    })

    nativeTheme.on('updated', () => {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('theme:changed', {
          shouldUseDarkColors: nativeTheme.shouldUseDarkColors
        })
      })
    })

    registerProjectionHandlers(wm)
    registerTimerHandlers(wm)
    registerBibleApiHandlers(wm)
    registerAppIpc(wm, hhcAuthService)
    registerLocalModelProtocol()
    registerSpeechKeyStorageHandlers(wm)
    registerNativeFsHandlers(wm)
    registerProjectionVlcHandlers(wm)
    registerVideoPosterHandlers(wm)
    registerLocalSyncHandlers(wm)
    registerLanRemoteIpc(wm)
    registerOneDriveCredentialHandlers(wm)
    registerHhcAuthIpc(wm, hhcAuthService)
    registerHhcAssetHandlers(wm, hhcAuthService)
    registerPersonalCloudHandlers(wm, hhcAuthService)
    registerOneDriveDownloadHandlers(wm)
    registerNativeMediaProtocol()
    registerMediaPermissions(session.defaultSession, () => wm.getMainWindow()?.webContents)
    wm.createMainWindow()
    registerUpdateService(wm)

    protocolDispatcher.dispatchArgv(process.argv)

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) wm.createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    if (nativeMediaLeasesCleared) {
      wm.cleanup()
      return
    }
    event.preventDefault()
    if (nativeMediaLeaseCleanupPending) return
    nativeMediaLeaseCleanupPending = true
    void clearNativeMediaLeases()
      .catch(() => undefined)
      .finally(() => {
        nativeMediaLeasesCleared = true
        app.quit()
      })
  })
}
