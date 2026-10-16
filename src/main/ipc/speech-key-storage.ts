import { safeStorage, app, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import type { WindowManager } from '../windowManager'
import { isMainWindow } from './validate'

function getKeyFilePath(provider: string): string {
  if (provider !== 'azure' && provider !== 'gcp') throw new Error('Invalid provider')
  return join(app.getPath('userData'), `speech-api-key-${provider}.enc`)
}

export function registerSpeechKeyStorageHandlers(wm: WindowManager): void {
  ipcMain.handle(
    'speech:saveKey',
    (event: Electron.IpcMainInvokeEvent, provider: unknown, apiKey: unknown) => {
      if (!isMainWindow(wm, event)) return
      if (typeof provider !== 'string' || !provider.trim()) throw new Error('Invalid provider')
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Invalid API key')
      try {
        const filePath = getKeyFilePath(provider)
        const encrypted = safeStorage.encryptString(apiKey)
        writeFileSync(filePath, encrypted)
      } catch (error) {
        console.error(`[SPEECH] Failed to save key for ${provider}:`, error)
        throw error
      }
    }
  )

  ipcMain.handle('speech:loadKey', (event: Electron.IpcMainInvokeEvent, provider: unknown) => {
    if (!isMainWindow(wm, event)) return ''
    if (typeof provider !== 'string') return ''
    try {
      const filePath = getKeyFilePath(provider)
      if (!existsSync(filePath)) return ''
      const encrypted = readFileSync(filePath)
      return safeStorage.decryptString(encrypted)
    } catch (error) {
      console.error(`[SPEECH] Failed to load key for ${provider}:`, error)
      return ''
    }
  })

  ipcMain.handle('speech:deleteKey', (event: Electron.IpcMainInvokeEvent, provider: unknown) => {
    if (!isMainWindow(wm, event)) return
    if (typeof provider !== 'string') return
    try {
      const filePath = getKeyFilePath(provider)
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch (error) {
      console.error(`[SPEECH] Failed to delete key for ${provider}:`, error)
      throw error
    }
  })
}
