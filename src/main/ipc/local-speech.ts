import { app, ipcMain, powerMonitor } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalSpeechRuntime } from '../localSpeechRuntime'
import { SpeechModels, verifySpeechFile } from '../speechModels'
import { isRecognitionLanguage, SPEECH_MODELS } from '../../shared/local-speech'
import { isChineseSpeechPcm } from '../../shared/chinese-speech'
import { isMainWindow } from './validate'
import type { WindowManager } from '../windowManager'

export function registerLocalSpeech(wm: WindowManager): void {
  const directory = join(
    app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
    'speech',
    `${process.platform}-${process.arch}`
  )
  const binary = join(directory, process.platform === 'win32' ? 'hhc-speech.exe' : 'hhc-speech')
  const supported = (): boolean =>
    ['darwin-arm64', 'win32-x64'].includes(`${process.platform}-${process.arch}`) &&
    existsSync(binary)
  const models = new SpeechModels(join(app.getPath('userData'), 'speech-models'), supported)
  const runtime = new LocalSpeechRuntime(binary)
  let generation = 0
  let active: string | null = null
  const stop = (): void => {
    generation++
    active = null
    runtime.dispose()
  }
  const allowed = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized speech request')
  }
  const languageOf = (value: unknown): 'zh' | 'en' => {
    if (!isRecognitionLanguage(value)) throw new Error('Invalid recognition language')
    return value
  }
  // Delete only the two retired provider secrets, never user-selected model directories.
  const clearRetiredKeys = async (): Promise<void> => {
    for (const provider of ['azure', 'gcp'])
      await rm(join(app.getPath('userData'), `speech-api-key-${provider}.enc`), { force: true })
  }
  void clearRetiredKeys().catch(() => {})
  ipcMain.handle('speech:model-status', async (event, language: unknown) => {
    allowed(event)
    await clearRetiredKeys().catch(() => {})
    return models.status(languageOf(language))
  })
  ipcMain.handle('speech:model-install', (event, language: unknown) => {
    allowed(event)
    const selected = languageOf(language)
    stop()
    return models.install(selected)
  })
  ipcMain.handle('speech:model-cancel', (event) => {
    allowed(event)
    models.cancel()
  })
  ipcMain.handle('speech:model-remove', (event, language: unknown) => {
    allowed(event)
    const selected = languageOf(language)
    stop()
    return models.remove(selected)
  })
  ipcMain.handle('speech:local-prepare', async (event, session: unknown, language: unknown) => {
    allowed(event)
    if (typeof session !== 'string' || !/^[a-f0-9-]{36}$/.test(session) || !supported())
      throw new Error('runtime-unavailable')
    const selected = languageOf(language)
    const revision = ++generation
    active = session
    if (models.busy || (await models.status(selected)).phase !== 'installed')
      throw new Error('model-not-ready')
    const model = SPEECH_MODELS[selected]
    const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('protocol' in manifest) ||
      manifest.protocol !== 1 ||
      !('sha256' in manifest) ||
      typeof manifest.sha256 !== 'string'
    )
      throw new Error('runtime-unavailable')
    const { size } = await stat(binary)
    if (
      !(await verifySpeechFile(binary, size, manifest.sha256)) ||
      !(await verifySpeechFile(models.path(selected), model.bytes, model.sha256))
    )
      throw new Error('repair-required')
    if (generation !== revision || active !== session) throw new Error('expired-session')
    await runtime.prepare(session, selected, models.path(selected))
    if (generation !== revision || active !== session) throw new Error('expired-session')
  })
  ipcMain.handle('speech:local-transcribe', (event, session: unknown, pcm: unknown) => {
    allowed(event)
    if (typeof session !== 'string' || session !== active || !isChineseSpeechPcm(pcm))
      throw new Error('invalid-audio')
    return runtime.transcribe(session, pcm)
  })
  ipcMain.handle('speech:local-stop', (event, session: unknown) => {
    allowed(event)
    if (typeof session === 'string' && session === active) {
      generation++
      active = null
      runtime.stop(session)
    }
  })
  wm.getMainWindow()?.webContents.on('destroyed', stop)
  wm.getMainWindow()?.webContents.on('render-process-gone', stop)
  wm.getMainWindow()?.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) stop()
  })
  powerMonitor.on('suspend', () => {
    stop()
    wm.getMainWindow()?.webContents.send('speech:interrupted')
  })
  app.on('before-quit', () => {
    models.cancel()
    stop()
  })
}
