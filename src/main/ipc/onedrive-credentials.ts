import { ipcMain } from 'electron'
import { ONEDRIVE_AUTH_REDIRECT_URI, type OneDriveService } from '../onedrive-service'
import type { WindowManager } from '../windowManager'
import { isMainWindow } from './validate'

export function registerOneDriveCredentialHandlers(
  wm: WindowManager,
  service: OneDriveService
): void {
  ipcMain.handle('onedrive:get-credential-status', async (event, connectionId: unknown) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized OneDrive credential access')
    return service.getCredentialStatus(connectionId)
  })

  ipcMain.handle('onedrive:get-access-token', async (event, input: unknown) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized OneDrive credential access')
    return service.getAccessToken(input)
  })

  ipcMain.handle('onedrive:complete-auth', async (event, input: unknown) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized OneDrive credential access')
    return service.completeAuth(input)
  })

  ipcMain.handle('onedrive:delete-credentials', async (event, connectionId: unknown) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized OneDrive credential access')
    return service.deleteCredentials(connectionId)
  })

  ipcMain.handle('onedrive:get-auth-redirect-uri', async (event) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized OneDrive credential access')
    return ONEDRIVE_AUTH_REDIRECT_URI
  })

  ipcMain.handle('onedrive:wait-auth-callback', async (event, expectedState: unknown) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized OneDrive credential access')
    return service.waitForAuthCallback(expectedState)
  })
}
