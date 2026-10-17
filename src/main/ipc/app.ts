import type { OneDriveService } from '../onedrive-service'
import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'path'
import fs from 'fs'
import https from 'https'
import type { WindowManager } from '../windowManager'
import type { HhcAuthService } from './hhc-auth'
import { isMainWindow } from './validate'
import type {
  WhisperModel,
  WhisperDownloadProgress,
  WhisperDirInfo
} from '../../shared/ipc-channels'

const HF_BASE = 'https://huggingface.co/onnx-community'

const WHISPER_FILES: Record<string, string[]> = {
  'whisper-base': [
    'config.json',
    'generation_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'normalizer.json',
    'preprocessor_config.json',
    'vocab.json',
    'merges.txt',
    'added_tokens.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx'
  ],
  'whisper-small': [
    'config.json',
    'generation_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'normalizer.json',
    'preprocessor_config.json',
    'vocab.json',
    'merges.txt',
    'added_tokens.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx'
  ],
  'whisper-medium': [
    'config.json',
    'generation_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'normalizer.json',
    'preprocessor_config.json',
    'vocab.json',
    'merges.txt',
    'added_tokens.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx'
  ]
}

function httpsHead(url: string): Promise<{ contentLength: number }> {
  return new Promise((resolve, reject) => {
    const request = (targetUrl: string): void => {
      const parsed = new URL(targetUrl)
      https
        .request(
          { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'HEAD' },
          (res) => {
            if (
              res.statusCode === 301 ||
              res.statusCode === 302 ||
              res.statusCode === 307 ||
              res.statusCode === 308
            ) {
              const location = res.headers.location
              if (location) {
                request(new URL(location, targetUrl).href)
                return
              }
            }
            const cl = res.headers['content-length']
            resolve({ contentLength: cl ? parseInt(cl, 10) : 0 })
          }
        )
        .on('error', reject)
        .end()
    }
    request(url)
  })
}

function downloadFile(
  url: string,
  destPath: string,
  expectedSize: number,
  onProgress: (bytes: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const temporaryPath = `${destPath}.tmp`
    const fail = (error: unknown): void => {
      fs.rmSync(temporaryPath, { force: true })
      reject(error)
    }
    const request = (targetUrl: string): void => {
      https
        .get(targetUrl, (res) => {
          if (
            res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307 ||
            res.statusCode === 308
          ) {
            const location = res.headers.location
            if (location) {
              request(new URL(location, targetUrl).href)
              return
            }
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`))
            return
          }
          const dir = path.dirname(destPath)
          fs.mkdirSync(dir, { recursive: true })
          const out = fs.createWriteStream(temporaryPath)
          res.on('data', (chunk: Buffer) => {
            onProgress(chunk.length)
          })
          res.pipe(out)
          out.on('finish', () => {
            out.close(() => {
              try {
                const size = fs.statSync(temporaryPath).size
                if (expectedSize > 0 && size !== expectedSize) {
                  fail(new Error(`Downloaded file size mismatch for ${targetUrl}`))
                  return
                }
                fs.renameSync(temporaryPath, destPath)
                resolve()
              } catch (error) {
                fail(error)
              }
            })
          })
          out.on('error', fail)
          res.on('error', fail)
        })
        .on('error', fail)
    }
    request(url)
  })
}

let whisperModelDir: string | null = null

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

function resolveContainedPath(baseDir: string, relativePath: string): string | null {
  const base = path.resolve(baseDir)
  const resolved = path.resolve(base, relativePath)
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : null
}

function isValidModelDirectory(dir: unknown): dir is string {
  return typeof dir === 'string' && path.isAbsolute(dir)
}

function detectInstalledModel(destDir: string): WhisperDirInfo {
  const whisperSubDir = path.join(destDir, 'whisper')
  if (!fs.existsSync(whisperSubDir)) return { hasFiles: false }
  const entries = fs.readdirSync(whisperSubDir)
  return { hasFiles: entries.length > 0 }
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

  ipcMain.handle('app:set-model-dir', (event, dir: unknown) => {
    if (!isMainWindow(wm, event)) return
    if (!isValidModelDirectory(dir)) throw new Error('Invalid model directory')
    whisperModelDir = dir
  })

  ipcMain.handle('app:check-whisper-dir', (event, dir: unknown): WhisperDirInfo => {
    if (!isMainWindow(wm, event)) return { hasFiles: false }
    if (!isValidModelDirectory(dir)) return { hasFiles: false }
    return detectInstalledModel(dir)
  })

  ipcMain.handle(
    'app:download-whisper-model',
    async (event, model: WhisperModel, destDir: unknown) => {
      if (!isMainWindow(wm, event)) return
      if (!isValidModelDirectory(destDir)) throw new Error('Invalid model directory')
      const sender = event.sender

      const files = WHISPER_FILES[model]
      if (!files) throw new Error(`Unknown model: ${model}`)

      const modelSubDir = path.join(destDir, 'whisper')

      const sendProgress = (progress: WhisperDownloadProgress): void => {
        if (!sender.isDestroyed()) sender.send('app:download-progress', progress)
      }

      const fileSizes: number[] = []
      for (const file of files) {
        const destPath = path.join(modelSubDir, file)
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
          fileSizes.push(0)
        } else {
          try {
            const url = `${HF_BASE}/${model}/resolve/main/${file}`
            const { contentLength } = await httpsHead(url)
            fileSizes.push(contentLength)
          } catch {
            fileSizes.push(0)
          }
        }
      }

      const totalBytes = fileSizes.reduce((a, b) => a + b, 0)
      let downloadedBytes = 0

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const destPath = path.join(modelSubDir, file)

        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
          sendProgress({
            model,
            percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 100,
            currentFile: file,
            done: false
          })
          continue
        }

        const url = `${HF_BASE}/${model}/resolve/main/${file}`
        sendProgress({
          model,
          percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
          currentFile: file,
          done: false
        })

        try {
          await downloadFile(url, destPath, fileSizes[i], (bytes) => {
            downloadedBytes += bytes
            const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0
            sendProgress({ model, percent, currentFile: file, done: false })
          })
        } catch (err) {
          sendProgress({ model, percent: 0, currentFile: file, done: false, error: String(err) })
          throw err
        }
      }

      whisperModelDir = destDir
      sendProgress({ model, percent: 100, currentFile: '', done: true })
    }
  )
}

export function registerLocalModelProtocol(): void {
  protocol.handle('local-model', (request) => {
    if (!whisperModelDir) return new Response('Model dir not set', { status: 503 })
    try {
      const url = new URL(request.url)
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const filePath = resolveContainedPath(whisperModelDir, relativePath)
      if (!filePath) return new Response('Invalid model path', { status: 400 })
      const data = fs.readFileSync(filePath)
      return new Response(data)
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
