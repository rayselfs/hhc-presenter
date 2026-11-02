import type { OneDriveService } from '../onedrive-service'
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'path'
import fs from 'fs'
import type { WindowManager } from '../windowManager'
import type { HhcAuthService } from './hhc-auth'
import { isMainWindow } from './validate'

async function clearMainProcessUserData(
  hhcAuthService: HhcAuthService,
  oneDriveService: Pick<OneDriveService, 'clearCredentials'>
): Promise<void> {
  await Promise.all([hhcAuthService.clearLocalData(), oneDriveService.clearCredentials()])
  const userData = app.getPath('userData')
  for (const entry of [
    'native-files',
    'local-sync-connections.json',
    'speech-api-key-azure.enc',
    'speech-api-key-gcp.enc'
  ]) {
    fs.rmSync(path.join(userData, entry), { recursive: true, force: true })
  }
  await session.defaultSession.clearData()
}

export function registerAppIpc(
  wm: WindowManager,
  hhcAuthService: HhcAuthService,
  oneDriveService: Pick<OneDriveService, 'clearCredentials'>
): void {
  ipcMain.handle('app:confirm-close', (event) => {
    if (!isMainWindow(wm, event)) return { closing: false }
    return { closing: wm.confirmMainWindowClose() }
  })

  ipcMain.handle('app:relaunch', (event) => {
    if (!isMainWindow(wm, event)) return
    if (is.dev) {
      const win = BrowserWindow.fromWebContents(event.sender)
      win?.webContents.reload()
    } else {
      app.relaunch()
      app.exit(0)
    }
  })

  ipcMain.handle('app:clear-user-data', async (event) => {
    if (!isMainWindow(wm, event)) return
    await clearMainProcessUserData(hhcAuthService, oneDriveService)
  })

  ipcMain.handle('app:select-directory', async (event) => {
    if (!isMainWindow(wm, event)) return null
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
}
