import { app, ipcMain, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { WindowManager } from '../windowManager'
import { isMainWindow } from './validate'
import { createSpeechToken } from '../../shared/openai-speech'

export function registerOpenAISpeech(wm: WindowManager): void {
  const file = join(app.getPath('userData'), 'openai-speech-key.enc')
  const authorize = (event: Electron.IpcMainInvokeEvent): void => {
    if (
      !isMainWindow(wm, event) ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Unauthorized speech request')
  }
  const requireEncryption = async (): Promise<void> => {
    if (
      !(await safeStorage.isAsyncEncryptionAvailable()) ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error('Secure storage unavailable')
  }
  for (const provider of ['azure', 'gcp']) {
    void rm(join(app.getPath('userData'), `speech-api-key-${provider}.enc`), { force: true }).catch(
      () => {}
    )
  }
  ipcMain.handle('speech:configured', async (event) => {
    authorize(event)
    return access(file).then(
      () => true,
      () => false
    )
  })
  ipcMain.handle('speech:save', async (event, key: unknown) => {
    authorize(event)
    await requireEncryption()
    if (typeof key !== 'string' || !/^sk-[^\s]{8,1000}$/.test(key)) throw new Error('Invalid key')
    const tmp = file + '.' + randomUUID()
    try {
      await writeFile(tmp, await safeStorage.encryptStringAsync(key), { mode: 0o600, flag: 'wx' })
      await rename(tmp, file)
    } finally {
      await rm(tmp, { force: true })
    }
  })
  ipcMain.handle('speech:forget', async (event) => {
    authorize(event)
    await rm(file, { force: true })
  })
  ipcMain.handle('speech:token', async (event, language: unknown) => {
    authorize(event)
    await requireEncryption()
    if (language !== 'zh' && language !== 'en') throw new Error('Invalid language')
    return createSpeechToken(
      (await safeStorage.decryptStringAsync(await readFile(file))).result,
      language
    )
  })
}
