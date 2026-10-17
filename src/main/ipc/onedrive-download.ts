import { ipcMain, net } from 'electron'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import type {
  OneDriveNativeDownloadRequest,
  OneDriveNativeDownloadResult
} from '@shared/ipc-channels'
import type { WindowManager } from '../windowManager'
import { getNativeFilePath } from '../lib/native-storage'
import { isMainWindow } from './validate'
import { mutateVideoSource } from './video-remux'

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'
const STORAGE_USAGE_LIMIT_RATIO = 0.8
const STORAGE_LIMIT_ERROR = 'OneDrive sync storage has reached 80% usage'

function validateRemoteItemId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new Error('Invalid OneDrive remote item id')
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) throw new Error('Invalid OneDrive remote item id')
  }
  return value
}

function validateAccessToken(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid OneDrive access token')
  }
  return value
}

function validateDownloadRequest(input: unknown): OneDriveNativeDownloadRequest {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid OneDrive download request')
  }
  const value = input as Record<string, unknown>
  const expectedSize = value.expectedSize
  if (
    expectedSize !== undefined &&
    (typeof expectedSize !== 'number' || !Number.isFinite(expectedSize) || expectedSize < 0)
  ) {
    throw new Error('Invalid OneDrive expected size')
  }
  if (value.mimeType !== undefined && typeof value.mimeType !== 'string') {
    throw new Error('Invalid OneDrive MIME type')
  }
  return {
    remoteItemId: validateRemoteItemId(value.remoteItemId),
    targetFileId: value.targetFileId as string,
    accessToken: validateAccessToken(value.accessToken),
    expectedSize,
    mimeType: value.mimeType
  }
}

function createGraphContentUrl(remoteItemId: string): string {
  const encoded = encodeURIComponent(remoteItemId).replace(/%2F/gi, '')
  return `${GRAPH_BASE_URL}/me/drive/items/${encoded}/content`
}

async function writeResponseBodyToFile(
  response: Response,
  temporaryPath: string,
  onProgress?: (downloadedBytes: number) => void
): Promise<number> {
  if (!response.body) throw new Error('OneDrive response is not streamable')
  const handle = await fs.open(temporaryPath, 'w')
  let size = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      await handle.write(Buffer.from(value))
      onProgress?.(size)
    }
  } finally {
    await handle.close()
  }
  return size
}

async function assertNativeStorageCapacity(directory: string, incomingBytes = 0): Promise<void> {
  const stats = await fs.statfs(directory)
  const total = stats.blocks * stats.bsize
  if (total <= 0) return
  const available = stats.bavail * stats.bsize
  const projectedUsage = total - available + incomingBytes
  if (projectedUsage > total * STORAGE_USAGE_LIMIT_RATIO) {
    throw new Error(STORAGE_LIMIT_ERROR)
  }
}

export function registerOneDriveDownloadHandlers(wm: WindowManager): void {
  ipcMain.handle(
    'onedrive:download-file',
    async (event, input: unknown): Promise<OneDriveNativeDownloadResult> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized OneDrive download access')
      const request = validateDownloadRequest(input)
      const targetPath = getNativeFilePath(request.targetFileId)
      const targetDirectory = dirname(targetPath)
      const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
      await fs.mkdir(targetDirectory, { recursive: true })
      await assertNativeStorageCapacity(targetDirectory, request.expectedSize ?? 0)
      return mutateVideoSource(request.targetFileId, async () => {
        const response = await net.fetch(createGraphContentUrl(request.remoteItemId), {
          headers: { Authorization: `Bearer ${request.accessToken}` }
        })

        if (!response.ok) throw new Error(`OneDrive download failed: ${response.status}`)

        try {
          const size = await writeResponseBodyToFile(response, temporaryPath, (downloadedBytes) => {
            event.sender.send('onedrive:download-progress', {
              targetFileId: request.targetFileId,
              downloadedBytes,
              downloadTotalBytes: request.expectedSize
            })
          })
          await assertNativeStorageCapacity(targetDirectory)
          if (request.expectedSize !== undefined && size !== request.expectedSize) {
            throw new Error('OneDrive download size mismatch')
          }
          await fs.rename(temporaryPath, targetPath)
          return {
            fileId: request.targetFileId,
            size,
            mimeType: request.mimeType ?? response.headers.get('Content-Type') ?? undefined
          }
        } catch (error) {
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
          throw error
        }
      })
    }
  )
}
