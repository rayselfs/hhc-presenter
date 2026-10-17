import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { isValidNativeFileId } from '../../shared/native-media'
import type {
  VideoPosterInfo,
  VideoPosterRequest,
  VideoPosterResult
} from '../../shared/ipc-channels'
import { resolveFfmpegRuntime } from '../video-engine-runtime'
import type { WindowManager } from '../windowManager'
import { getNativeFilePath } from '../lib/native-storage'
import { isMainWindow } from './validate'
import { runFfmpegProcess } from './ffmpeg-process'

const PROCESS_TIMEOUT_MS = 15000

function parseVersion(output: string): string | undefined {
  return output.match(/ffmpeg version\s+([^\s]+)/i)?.[1]
}

async function getInfo(): Promise<VideoPosterInfo> {
  const runtime = resolveFfmpegRuntime()
  if (runtime.status !== 'ready' || !runtime.path) {
    return { status: 'missing', message: runtime.message ?? 'FFmpeg poster runtime not found' }
  }

  try {
    const output = await runFfmpegProcess({
      executable: runtime.path,
      args: ['-version'],
      timeoutMs: PROCESS_TIMEOUT_MS
    })
    return {
      status: 'ready',
      source: runtime.source,
      executableName: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      version: parseVersion(`${output.stdout}\n${output.stderr}`)
    }
  } catch (error) {
    return {
      status: 'missing',
      source: runtime.source,
      message: error instanceof Error ? error.message : 'FFmpeg poster runtime not found'
    }
  }
}

function validatePosterRequest(input: unknown): VideoPosterRequest {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid poster request')
  const request = input as Partial<VideoPosterRequest>
  if (!isValidNativeFileId(request.sourceFileId)) throw new Error('Invalid poster source id')
  return { sourceFileId: request.sourceFileId }
}

async function generatePoster(input: unknown): Promise<VideoPosterResult> {
  const request = validatePosterRequest(input)
  const info = await getInfo()
  if (info.status !== 'ready') throw new Error(info.message ?? 'FFmpeg poster runtime not ready')

  const runtime = resolveFfmpegRuntime()
  if (!runtime.path) throw new Error('FFmpeg poster runtime not found')

  const sourcePath = getNativeFilePath(request.sourceFileId)
  const temporaryPath = join(
    dirname(sourcePath),
    `.${request.sourceFileId}.${randomUUID()}.poster.jpg`
  )

  try {
    await runFfmpegProcess({
      executable: runtime.path,
      args: [
        '-hide_banner',
        '-y',
        '-ss',
        '00:00:01',
        '-i',
        sourcePath,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-2',
        '-pix_fmt',
        'yuvj420p',
        temporaryPath
      ],
      timeoutMs: PROCESS_TIMEOUT_MS
    })
    const data = await fs.readFile(temporaryPath)
    return { dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export function registerVideoPosterHandlers(wm: WindowManager): void {
  ipcMain.handle('video-poster:get-info', async (event): Promise<VideoPosterInfo> => {
    if (!isMainWindow(wm, event)) return { status: 'error', message: 'Unauthorized poster access' }
    return getInfo()
  })

  ipcMain.handle(
    'video-poster:generate',
    async (event, request: unknown): Promise<VideoPosterResult> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized poster access')
      return generatePoster(request)
    }
  )
}
