import { app, ipcMain, net } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { APP_CONFIG } from '@shared/app-config'
import {
  projectHhcAssetChangePage,
  projectHhcAssetCollectionPage,
  projectHhcAssetItem,
  type HhcAssetCollectionChangePage,
  type HhcAssetCollectionItem,
  type HhcAssetCollectionPage,
  type HhcAssetContentTicket,
  type HhcAssetSyncReceipt
} from '@shared/hhc-assets'
import type { WindowManager } from '../windowManager'
import type { HhcAuthService } from './hhc-auth'
import {
  clearNativeMediaLeases,
  getNativeFilePath,
  registerNativeMediaLease,
  releaseNativeMediaLease
} from './native-fs'
import { isMainWindow } from './validate'
import { mutateVideoSource } from './video-remux'

const HHC_ASSET_ORIGIN = APP_CONFIG.hhcAssetOrigin
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/
const MAX_CURSOR_BYTES = 2048
const MAX_CONTENT_BYTES = 200 * 1024 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024
const activeDownloads = new Map<string, AbortController>()
const INVALID_BODY = 'HHC_ASSET_FATAL:INVALID_BODY'
const INVALID_SCHEMA = 'HHC_ASSET_FATAL:INVALID_SCHEMA'

function requestError(code = 'HHC_ASSET_FATAL'): Error {
  return new Error(code)
}

function validateExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid HHC Asset request')
  }
  const record = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error('Invalid HHC Asset request')
  }
  return record
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestError()
  return value as Record<string, unknown>
}

function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error('Invalid HHC Asset request')
  }
  return value
}

function cursor(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  const hasControlCharacter =
    typeof value === 'string' &&
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > MAX_CURSOR_BYTES ||
    hasControlCharacter
  ) {
    throw new Error('Invalid HHC Asset request')
  }
  return value
}

function boundedText(value: unknown, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error('Invalid HHC Asset request')
  }
  return value
}

function codeForStatus(status: number): string {
  if (status === 401) return 'HHC_ASSET_AUTH_REQUIRED'
  if (status === 403) return 'HHC_ASSET_ACCESS_REVOKED'
  if (status === 404) return 'HHC_ASSET_ACCESS_REVOKED:404'
  if (status === 408 || status === 409 || status === 423 || status === 429 || status >= 500) {
    return 'HHC_ASSET_RETRYABLE'
  }
  return 'HHC_ASSET_FATAL'
}

async function fetchAsset(
  service: HhcAuthService,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const send = async (token: string): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('accept', headers.get('accept') ?? 'application/json')
    headers.set('authorization', `Bearer ${token}`)
    try {
      return await net.fetch(`${HHC_ASSET_ORIGIN}${path}`, { ...init, headers })
    } catch {
      if (init.signal?.aborted) throw requestError('HHC_ASSET_DOWNLOAD_CANCELLED')
      throw requestError('HHC_ASSET_RETRYABLE')
    }
  }

  const token = await service.getAccessToken()
  if (!token) throw requestError('HHC_ASSET_AUTH_REQUIRED')
  let response = await send(token)
  if (response.status === 401) {
    const refreshed = await service.refreshAfterUnauthorized(token)
    if (!refreshed) throw requestError('HHC_ASSET_AUTH_REQUIRED')
    response = await send(refreshed)
  }
  if (!response.ok) throw requestError(codeForStatus(response.status))
  return response
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const rawLength = response.headers.get('content-length')
  if (rawLength !== null) {
    const declaredLength = Number(rawLength)
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_JSON_BYTES
    ) {
      throw requestError(INVALID_BODY)
    }
  }
  if (!response.body) throw requestError(INVALID_BODY)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > MAX_JSON_BYTES) throw requestError(INVALID_BODY)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof Error && error.message.startsWith('HHC_ASSET_')) throw error
    throw requestError(INVALID_BODY)
  }
  if (size === 0) throw requestError(INVALID_BODY)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw requestError(INVALID_BODY)
  }
}

async function json<T>(
  service: HhcAuthService,
  path: string,
  project: (value: unknown) => T,
  init?: RequestInit
): Promise<T> {
  let value: unknown
  try {
    value = await readBoundedJson(await fetchAsset(service, path, init))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('HHC_ASSET_')) throw error
    throw requestError()
  }
  try {
    return project(value)
  } catch {
    throw requestError(INVALID_SCHEMA)
  }
}

async function downloadContent(
  auth: HhcAuthService,
  collectionId: string,
  itemId: string,
  destinationPath: string,
  signal?: AbortSignal
): Promise<{ size: number; mimeType: string; etag: string }> {
  if (signal?.aborted) throw requestError('HHC_ASSET_DOWNLOAD_CANCELLED')
  const response = await fetchAsset(
    auth,
    `/api/assets/collections/${collectionId}/items/${itemId}/content`,
    { headers: { accept: '*/*' }, signal }
  )
  return saveAssetContent(response, destinationPath, signal)
}

export async function saveAssetContent(
  response: Response,
  destinationPath: string,
  signal?: AbortSignal
): Promise<{ size: number; mimeType: string; etag: string }> {
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredSize) || declaredSize < 0 || declaredSize > MAX_CONTENT_BYTES) {
    throw requestError()
  }
  if (!response.body) throw requestError()

  await fs.mkdir(dirname(destinationPath), { recursive: true })
  const file = await fs.open(destinationPath, 'wx')
  const reader = response.body.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) throw requestError('HHC_ASSET_DOWNLOAD_CANCELLED')
      if (!value) continue
      size += value.byteLength
      if (size > MAX_CONTENT_BYTES) throw requestError()
      await file.writeFile(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (signal?.aborted) throw requestError('HHC_ASSET_DOWNLOAD_CANCELLED')
    throw error
  } finally {
    await file.close()
  }
  if ((declaredSize > 0 && size !== declaredSize) || size === 0) {
    await fs.rm(destinationPath, { force: true })
    throw requestError()
  }
  if (signal?.aborted) throw requestError('HHC_ASSET_DOWNLOAD_CANCELLED')
  return {
    size,
    mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    etag: response.headers.get('etag') ?? ''
  }
}

export function registerHhcAssetHandlers(wm: WindowManager, auth: HhcAuthService): void {
  if (new URL(APP_CONFIG.hhcAssetOrigin).origin !== APP_CONFIG.hhcAssetOrigin) {
    throw new Error('Invalid HHC Asset origin')
  }

  const authorized =
    <T extends unknown[], R>(handler: (...args: T) => Promise<R>) =>
    async (event: Electron.IpcMainInvokeEvent, ...args: T): Promise<R> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized HHC Asset access')
      return handler(...args)
    }

  ipcMain.handle(
    'hhc-assets:list-collections',
    authorized(async (rawCursor?: unknown): Promise<HhcAssetCollectionPage> => {
      const params = new URLSearchParams({ limit: '100' })
      const validatedCursor = cursor(rawCursor)
      if (validatedCursor) params.set('cursor', validatedCursor)
      return json(auth, `/api/assets/collections?${params}`, projectHhcAssetCollectionPage)
    })
  )

  ipcMain.handle(
    'hhc-assets:get-collection-changes',
    authorized(async (value: unknown): Promise<HhcAssetCollectionChangePage> => {
      const input = validateExactObject(value, ['collectionId'], ['cursor'])
      const collectionId = opaqueId(input.collectionId)
      const validatedCursor = cursor(input.cursor)
      const query = validatedCursor ? `?${new URLSearchParams({ cursor: validatedCursor })}` : ''
      return json(
        auth,
        `/api/assets/collections/${collectionId}/changes${query}`,
        projectHhcAssetChangePage
      )
    })
  )

  ipcMain.handle(
    'hhc-assets:get-collection-item',
    authorized(async (value: unknown): Promise<HhcAssetCollectionItem> => {
      const input = validateExactObject(value, ['collectionId', 'itemId'])
      const collectionId = opaqueId(input.collectionId)
      const itemId = opaqueId(input.itemId)
      return json(
        auth,
        `/api/assets/collections/${collectionId}/items/${itemId}`,
        projectHhcAssetItem
      )
    })
  )

  ipcMain.handle(
    'hhc-assets:issue-content-ticket',
    authorized(async (value: unknown): Promise<HhcAssetContentTicket> => {
      const input = validateExactObject(value, ['collectionId', 'itemId'])
      const collectionId = opaqueId(input.collectionId)
      const itemId = opaqueId(input.itemId)
      const response = await json(
        auth,
        `/api/assets/collections/${collectionId}/items/${itemId}/content-ticket`,
        responseObject,
        { method: 'POST' }
      )
      const expiresAt =
        typeof response.expiresAt === 'string' ? Date.parse(response.expiresAt) : Number.NaN
      if (
        typeof response.contentUrl !== 'string' ||
        !response.contentUrl.startsWith('/api/assets/content?ticket=') ||
        typeof response.etag !== 'string' ||
        !Number.isFinite(expiresAt)
      ) {
        throw requestError()
      }
      return {
        contentUrl: `${HHC_ASSET_ORIGIN}${response.contentUrl}`,
        expiresAt,
        etag: response.etag
      }
    })
  )

  ipcMain.handle(
    'hhc-assets:record-sync-receipt',
    authorized(async (value: unknown): Promise<void> => {
      const input = validateExactObject(value, [
        'collectionItemId',
        'contentVersion',
        'state',
        'appVersion'
      ])
      if (input.state !== 'available-offline') throw new Error('Invalid HHC Asset request')
      const receipt: HhcAssetSyncReceipt = {
        collectionItemId: opaqueId(input.collectionItemId),
        contentVersion: boundedText(input.contentVersion, 255),
        state: input.state,
        appVersion: boundedText(input.appVersion, 64)
      }
      await fetchAsset(auth, '/api/assets/sync-receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(receipt)
      })
    })
  )

  ipcMain.handle(
    'hhc-assets:download-file',
    authorized(async (value: unknown) => {
      const input = validateExactObject(value, [
        'collectionId',
        'itemId',
        'rootRemoteFolderId',
        'targetFileId'
      ])
      const collectionId = opaqueId(input.collectionId)
      const itemId = opaqueId(input.itemId)
      if (opaqueId(input.rootRemoteFolderId) !== collectionId) {
        throw new Error('Invalid HHC Asset request')
      }
      const targetFileId = opaqueId(input.targetFileId)
      if (activeDownloads.has(targetFileId)) throw requestError('HHC_ASSET_RETRYABLE')
      const controller = new AbortController()
      activeDownloads.set(targetFileId, controller)
      const destinationPath = getNativeFilePath(targetFileId)
      const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`
      return mutateVideoSource(targetFileId, async () => {
        try {
          const downloaded = await downloadContent(
            auth,
            collectionId,
            itemId,
            temporaryPath,
            controller.signal
          )
          if (controller.signal.aborted) throw requestError('HHC_ASSET_DOWNLOAD_CANCELLED')
          await fs.mkdir(dirname(destinationPath), { recursive: true })
          if (controller.signal.aborted) throw requestError('HHC_ASSET_DOWNLOAD_CANCELLED')
          await fs.rename(temporaryPath, destinationPath)
          return {
            fileId: targetFileId,
            size: downloaded.size,
            mimeType: downloaded.mimeType
          }
        } catch (error) {
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
          throw error
        } finally {
          if (activeDownloads.get(targetFileId) === controller) activeDownloads.delete(targetFileId)
        }
      })
    })
  )

  ipcMain.handle(
    'hhc-assets:cancel-download',
    authorized(async (rawTargetFileId: unknown): Promise<void> => {
      activeDownloads.get(opaqueId(rawTargetFileId))?.abort()
    })
  )

  ipcMain.handle(
    'hhc-assets:create-content-lease',
    authorized(async (value: unknown) => {
      const input = validateExactObject(value, ['collectionId', 'itemId'])
      const collectionId = opaqueId(input.collectionId)
      const itemId = opaqueId(input.itemId)
      const leaseDir = resolve(app.getPath('userData'), 'hhc-asset-leases')
      const leasePath = join(leaseDir, `${randomUUID()}.bin`)
      try {
        const downloaded = await downloadContent(auth, collectionId, itemId, leasePath)
        return registerNativeMediaLease(leasePath, downloaded.mimeType, downloaded.etag)
      } catch (error) {
        await fs.rm(leasePath, { force: true }).catch(() => undefined)
        throw error
      }
    })
  )

  ipcMain.handle(
    'hhc-assets:release-content-lease',
    authorized(async (leaseId: unknown): Promise<void> => {
      await releaseNativeMediaLease(opaqueId(leaseId))
    })
  )

  ipcMain.handle(
    'hhc-assets:clear-content-leases',
    authorized(async (): Promise<void> => {
      await clearNativeMediaLeases()
    })
  )
}
