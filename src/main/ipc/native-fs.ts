import { app, ipcMain, protocol } from 'electron'
import { randomUUID } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { Readable } from 'stream'
import { isValidNativeFileId } from '../../shared/native-media'
import type { WindowManager } from '../windowManager'
import { isMainWindow } from './validate'
import { clearVideoCache, getVideoCacheUsage, mutateVideoSource } from './video-remux'

const NATIVE_MEDIA_SCHEME = 'hhc-media:'
const NATIVE_MEDIA_HOST = 'file'
const NATIVE_MEDIA_LEASE_HOST = 'lease'
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/
const nativeMediaLeases = new Map<string, { filePath: string; mimeType: string }>()

function getNativeMediaLeaseDir(): string {
  return resolve(app.getPath('userData'), 'hhc-asset-leases')
}

function getNativeFsDir(): string {
  return resolve(app.getPath('userData'), 'native-files')
}

export function getNativeFilePath(id: unknown): string {
  if (!isValidNativeFileId(id)) throw new Error('Invalid native file id')

  const baseDir = getNativeFsDir()
  const filePath = resolve(baseDir, id)
  if (dirname(filePath) !== baseDir) throw new Error('Native file path escapes storage directory')
  return filePath
}

export function parseNativeMediaUrl(requestUrl: string): { id: string; mimeType: string } | null {
  try {
    const url = new URL(requestUrl)
    if (url.protocol !== NATIVE_MEDIA_SCHEME || url.hostname !== NATIVE_MEDIA_HOST) return null

    const encodedId = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname
    const id = decodeURIComponent(encodedId)
    if (!isValidNativeFileId(id)) return null

    const requestedMimeType = url.searchParams.get('type') ?? ''
    const mimeType = MIME_TYPE_PATTERN.test(requestedMimeType)
      ? requestedMimeType
      : 'application/octet-stream'
    return { id, mimeType }
  } catch {
    return null
  }
}

export function registerNativeMediaLease(
  filePath: string,
  mimeType: string,
  etag: string
): { kind: 'native-lease'; url: string; leaseId: string; etag: string } {
  if (!isAbsolute(filePath)) throw new Error('Invalid native media lease path')
  const leaseId = randomUUID()
  const validatedMimeType = MIME_TYPE_PATTERN.test(mimeType) ? mimeType : 'application/octet-stream'
  nativeMediaLeases.set(leaseId, { filePath, mimeType: validatedMimeType })
  return {
    kind: 'native-lease',
    url: `hhc-media://${NATIVE_MEDIA_LEASE_HOST}/${leaseId}?type=${encodeURIComponent(validatedMimeType)}`,
    leaseId,
    etag
  }
}

export async function releaseNativeMediaLease(leaseId: unknown): Promise<void> {
  if (!isValidNativeFileId(leaseId)) throw new Error('Invalid native media lease id')
  const lease = nativeMediaLeases.get(leaseId)
  if (!lease) return
  await fs.unlink(lease.filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  nativeMediaLeases.delete(leaseId)
}

export async function clearNativeMediaLeases(): Promise<void> {
  const results = await Promise.allSettled(
    [...nativeMediaLeases.keys()].map((leaseId) => releaseNativeMediaLease(leaseId))
  )
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (failure) throw failure.reason
}

export async function clearStaleNativeMediaLeases(): Promise<void> {
  nativeMediaLeases.clear()
  await fs.rm(getNativeMediaLeaseDir(), { recursive: true, force: true })
}

export async function clearStaleNativeMediaLeasesOnStartup(): Promise<void> {
  await clearStaleNativeMediaLeases().catch((error) => {
    console.warn('[MAIN] Failed to clear stale native media leases', error)
  })
}

type ByteRange = {
  start: number
  end: number
}

function parseRangeHeader(rangeHeader: string | null, size: number): ByteRange | null {
  if (!rangeHeader) return { start: 0, end: size - 1 }

  const match = RANGE_PATTERN.exec(rangeHeader.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1
    }
  }

  const start = Number(rawStart)
  const end = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || end < start || start >= size) return null

  return { start, end: Math.min(end, size - 1) }
}

async function createNativeMediaResponse(
  filePath: string,
  mimeType: string,
  rangeHeader: string | null
): Promise<Response> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) return new Response('Media not found', { status: 404 })

  const size = stat.size
  const range = parseRangeHeader(rangeHeader, size)
  if (!range || size <= 0) {
    return new Response(null, {
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${size}`
      }
    })
  }

  const isPartial = rangeHeader !== null
  const contentLength = range.end - range.start + 1
  const stream = createReadStream(filePath, { start: range.start, end: range.end })
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': String(contentLength),
    'Content-Type': mimeType
  })
  if (isPartial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: isPartial ? 206 : 200,
    headers
  })
}

export function registerNativeFsHandlers(wm: WindowManager): void {
  ipcMain.handle(
    'native-fs:import-file',
    async (event, id: unknown, sourcePath: unknown): Promise<{ size: number }> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized native file import')
      const destinationPath = getNativeFilePath(id)
      const bytes = sourcePath instanceof Uint8Array ? sourcePath : null
      if (
        bytes
          ? bytes.byteLength > 200 * 1024 * 1024
          : typeof sourcePath !== 'string' || !isAbsolute(sourcePath)
      ) {
        throw new Error('Invalid native file source')
      }

      let size = bytes?.byteLength ?? 0
      if (typeof sourcePath === 'string') {
        const sourceStat = await fs.stat(sourcePath)
        if (!sourceStat.isFile()) throw new Error('Native file source is not a file')
        size = sourceStat.size
      }

      const dir = getNativeFsDir()
      await fs.mkdir(dir, { recursive: true })
      const temporaryPath = join(dir, `.${id}.${randomUUID()}.tmp`)

      return mutateVideoSource(id as string, async () => {
        try {
          if (bytes) await fs.writeFile(temporaryPath, bytes, { flag: 'wx' })
          else if (typeof sourcePath === 'string') await fs.copyFile(sourcePath, temporaryPath)
          const copiedStat = await fs.stat(temporaryPath)
          if (!copiedStat.isFile() || copiedStat.size !== size) {
            throw new Error('Native file copy verification failed')
          }
          await fs.rename(temporaryPath, destinationPath)
          return { size: copiedStat.size }
        } catch (error) {
          await fs.unlink(temporaryPath).catch(() => undefined)
          throw error
        }
      })
    }
  )

  ipcMain.handle('native-fs:file-exists', async (event, id: unknown): Promise<boolean> => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized native file stat')
    const filePath = getNativeFilePath(id)
    try {
      const stat = await fs.stat(filePath)
      return stat.isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  })

  ipcMain.handle('native-fs:video-cache-usage', async (event) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized native cache access')
    return getVideoCacheUsage()
  })

  ipcMain.handle('native-fs:clear-video-cache', async (event) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized native cache cleanup')
    await clearVideoCache()
  })

  ipcMain.handle('native-fs:delete-file', async (event, id: unknown): Promise<void> => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized native file deletion')
    const filePath = getNativeFilePath(id)
    await mutateVideoSource(id as string, async () => {
      try {
        await fs.unlink(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  })
}

export function registerNativeMediaProtocol(): void {
  protocol.handle('hhc-media', async (request) => {
    const parsed = parseNativeMediaUrl(request.url)
    if (!parsed) {
      try {
        const url = new URL(request.url)
        if (url.protocol !== NATIVE_MEDIA_SCHEME || url.hostname !== NATIVE_MEDIA_LEASE_HOST) {
          return new Response('Invalid media URL', { status: 400 })
        }
        const leaseId = decodeURIComponent(
          url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname
        )
        const lease = isValidNativeFileId(leaseId) ? nativeMediaLeases.get(leaseId) : undefined
        if (!lease) return new Response('Media not found', { status: 404 })
        return await createNativeMediaResponse(
          lease.filePath,
          lease.mimeType,
          request.headers.get('range')
        )
      } catch {
        return new Response('Media not found', { status: 404 })
      }
    }

    try {
      const filePath = getNativeFilePath(parsed.id)
      return await createNativeMediaResponse(
        filePath,
        parsed.mimeType,
        request.headers.get('range')
      )
    } catch {
      return new Response('Media not found', { status: 404 })
    }
  })
}
