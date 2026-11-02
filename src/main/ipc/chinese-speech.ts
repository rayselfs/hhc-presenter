import { app, ipcMain } from 'electron'
import { resolve } from 'node:path'
import { ChineseSpeechRuntime } from '../chineseSpeechRuntime'
import { isChineseSpeechPcm } from '../../shared/chinese-speech'
import { isMainWindow } from './validate'
import type { WindowManager } from '../windowManager'

export function registerChineseSpeechPilot(wm: WindowManager): void {
  const { HHC_SPEECH_PYTHON: python, HHC_SPEECH_DATA: data, HHC_SPEECH_NODE: node } = process.env
  const runtime =
    !app.isPackaged && python && data && node
      ? new ChineseSpeechRuntime({
          python,
          data,
          node,
          script: resolve(app.getAppPath(), 'scripts/speech-benchmark/live_runtime.py')
        })
      : null
  ipcMain.handle('speech:chinese-available', (event) => isMainWindow(wm, event) && runtime !== null)
  ipcMain.handle('speech:chinese-prepare', async (event, session: unknown) => {
    if (
      !isMainWindow(wm, event) ||
      !runtime ||
      typeof session !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(session)
    )
      throw new Error('Chinese pilot unavailable')
    return runtime.prepare(session)
  })
  ipcMain.handle('speech:chinese-transcribe', async (event, session: unknown, pcm: unknown) => {
    if (
      !isMainWindow(wm, event) ||
      !runtime ||
      typeof session !== 'string' ||
      !isChineseSpeechPcm(pcm)
    )
      throw new Error('Invalid speech request')
    return runtime.transcribe(session, pcm)
  })
  ipcMain.handle('speech:chinese-stop', (event, session: unknown) => {
    if (!isMainWindow(wm, event) || typeof session !== 'string') return
    runtime?.stop(session)
  })
  wm.getMainWindow()?.webContents.on('destroyed', () => runtime?.stop())
  wm.getMainWindow()?.webContents.on('render-process-gone', () => runtime?.stop())
  wm.getMainWindow()?.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) runtime?.stop()
  })
  app.on('before-quit', () => runtime?.stop())
}
