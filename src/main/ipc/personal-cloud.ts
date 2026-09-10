import { ipcMain, net } from 'electron'
import { createReadStream, openAsBlob, promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import type { HhcAuthAdapter } from '@shared/hhc-auth'
import type { IpcInvokeChannel } from '@shared/ipc-channels'
import { isValidNativeFileId } from '@shared/native-media'
import {
  createAuthenticatedPersonalCloudApi,
  PersonalCloudHttpError,
  PERSONAL_MAX_FILE_BYTES,
  type PersonalCloudHttpApi,
  type PersonalCloudReply,
  type PersonalMutationRequest,
  type PersonalTrashPurgeInput,
  type PersonalUploadInput
} from '@shared/personal-cloud'
import type { WindowManager } from '../windowManager'
import { getNativeFilePath } from './native-fs'
import { saveAssetContent } from './hhc-assets'
import { isMainWindow } from './validate'

type Auth = Pick<
  HhcAuthAdapter,
  'getSession' | 'getAccessToken' | 'refreshAccessToken' | 'subscribe'
>

function valid(condition: unknown): asserts condition {
  if (!condition) throw new PersonalCloudHttpError(400, 'invalid-request')
}
function exact(
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  valid(value && typeof value === 'object' && !Array.isArray(value))
  const input = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  valid(
    required.every((key) => key in input) && Object.keys(input).every((key) => allowed.has(key))
  )
  return input
}
function opaque(value: unknown): string {
  valid(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))
  return value
}
function fileId(value: unknown): string {
  valid(isValidNativeFileId(value))
  return value
}
function number(value: unknown, minimum = 1): number {
  valid(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum)
  return value
}
function text(value: unknown, maxLength = 255): string {
  valid(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      Array.from(value).length <= maxLength &&
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      )
  )
  return value
}
function uploadInput(value: unknown): PersonalUploadInput {
  const input = exact(value, ['fileName', 'mimeType', 'sizeBytes'])
  const sizeBytes = number(input.sizeBytes)
  valid(sizeBytes <= PERSONAL_MAX_FILE_BYTES)
  return { fileName: text(input.fileName, 1024), mimeType: text(input.mimeType), sizeBytes }
}
function purgeInput(value: unknown): PersonalTrashPurgeInput {
  const input = exact(value, ['operationId'], ['itemIds', 'all'])
  valid(input.all === undefined || typeof input.all === 'boolean')
  valid(
    input.itemIds === undefined || (Array.isArray(input.itemIds) && input.itemIds.length <= 1000)
  )
  const itemIds = Array.isArray(input.itemIds) ? input.itemIds.map(opaque) : undefined
  valid(Boolean(input.all) !== Boolean(itemIds?.length))
  return {
    operationId: text(input.operationId, 128),
    ...(itemIds ? { itemIds } : {}),
    ...(input.all ? { all: true } : {})
  }
}
function mutationInput(value: unknown): PersonalMutationRequest {
  const input = exact(
    value,
    ['operationId', 'itemId', 'type'],
    ['parentId', 'name', 'uploadId', 'expectedRevision', 'expectedCollectionRevision']
  )
  const type = text(input.type)
  valid(
    [
      'create-folder',
      'create-file',
      'replace-content',
      'rename',
      'move',
      'delete',
      'restore'
    ].includes(type)
  )
  return {
    operationId: text(input.operationId, 128),
    itemId: opaque(input.itemId),
    type: type as PersonalMutationRequest['type'],
    ...(input.parentId === undefined
      ? {}
      : { parentId: input.parentId === '' ? '' : opaque(input.parentId) }),
    ...(input.name === undefined ? {} : { name: text(input.name) }),
    ...(input.uploadId === undefined ? {} : { uploadId: opaque(input.uploadId) }),
    ...(input.expectedRevision === undefined
      ? {}
      : { expectedRevision: number(input.expectedRevision, 0) }),
    ...(input.expectedCollectionRevision === undefined
      ? {}
      : { expectedCollectionRevision: number(input.expectedCollectionRevision, 0) })
  }
}

export function registerPersonalCloudHandlers(wm: WindowManager, auth: Auth): void {
  const requests = new Map<string, AbortController>()
  const register = <T>(
    channel: IpcInvokeChannel,
    keys: string[],
    action: (
      api: PersonalCloudHttpApi,
      input: Record<string, unknown>,
      signal: AbortSignal
    ) => Promise<T>,
    optional: string[] = []
  ): void => {
    ipcMain.handle(channel, async (event, value: unknown): Promise<PersonalCloudReply<T>> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized personal cloud access')
      let requestId: string | undefined
      let unsubscribe: (() => void) | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const input = exact(value, ['ownerId', 'requestId', ...keys], optional)
        const ownerId = opaque(input.ownerId)
        const id = fileId(input.requestId)
        valid(!requests.has(id))
        const controller = new AbortController()
        requestId = id
        requests.set(id, controller)
        timeout = setTimeout(() => controller.abort(), 5 * 60_000)
        unsubscribe = auth.subscribe((session) => {
          if (session?.userId !== ownerId) controller.abort()
        })
        if ((await auth.getSession())?.userId !== ownerId) {
          throw new PersonalCloudHttpError(401, 'owner-changed')
        }
        controller.signal.throwIfAborted()
        const api = createAuthenticatedPersonalCloudApi(auth, ownerId, (input, init) =>
          net.fetch(input instanceof URL ? input.toString() : input, init)
        )
        const result = await action(api, input, controller.signal)
        controller.signal.throwIfAborted()
        if ((await auth.getSession())?.userId !== ownerId) {
          throw new PersonalCloudHttpError(401, 'owner-changed')
        }
        return { ok: true, value: result }
      } catch (error) {
        if (error instanceof PersonalCloudHttpError) {
          return {
            ok: false,
            status: error.status,
            code: error.code,
            retryAfterMs: error.retryAfterMs,
            ...(error.data ? { data: error.data } : {})
          }
        }
        const aborted = requestId && requests.get(requestId)?.signal.aborted
        const fsCode =
          error && typeof error === 'object' && 'code' in error ? error.code : undefined
        return {
          ok: false,
          status: aborted ? 499 : 0,
          retryAfterMs: 0,
          code: aborted
            ? 'cancelled'
            : fsCode === 'ENOSPC'
              ? 'storage-full'
              : fsCode === 'EEXIST'
                ? 'snapshot-exists'
                : fsCode === 'ENOENT'
                  ? 'source-missing'
                  : 'transfer-failed'
        }
      } finally {
        if (timeout) clearTimeout(timeout)
        unsubscribe?.()
        if (requestId) requests.delete(requestId)
      }
    })
  }
  register('personal-cloud:ensureSpace', [], (api, _input, signal) => api.ensureSpace(signal))
  register('personal-cloud:getUsage', [], (api, _input, signal) => api.getUsage(signal))
  register(
    'personal-cloud:getChanges',
    [],
    (api, input, signal) => {
      valid(
        input.cursor === undefined ||
          (typeof input.cursor === 'string' && input.cursor.length <= 2048)
      )
      return api.getChanges(input.cursor, signal)
    },
    ['cursor']
  )
  register('personal-cloud:createUpload', ['upload', 'operationId'], (api, input, signal) =>
    api.createUpload(uploadInput(input.upload), text(input.operationId, 128), signal)
  )
  register('personal-cloud:getUpload', ['uploadId'], (api, input, signal) =>
    api.getUpload(opaque(input.uploadId), signal)
  )
  register('personal-cloud:completeUpload', ['uploadId', 'upload'], async (api, input, signal) => {
    const upload = exact(input.upload, ['mimeType', 'sizeBytes', 'blobId'])
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(getNativeFilePath(fileId(upload.blobId)), {
      signal
    })) {
      hash.update(chunk)
    }
    signal.throwIfAborted()
    return api.completeUpload(
      opaque(input.uploadId),
      {
        mimeType: text(upload.mimeType),
        sizeBytes: number(upload.sizeBytes),
        checksumSha256: hash.digest('hex')
      },
      signal
    )
  })
  register('personal-cloud:mutate', ['mutation'], (api, input, signal) =>
    api.mutate(mutationInput(input.mutation), signal)
  )
  register('personal-cloud:purgeTrash', ['purge'], (api, input, signal) =>
    api.purgeTrash(purgeInput(input.purge), signal)
  )
  register('personal-cloud:uploadSnapshot', ['uploadId', 'blobId'], async (api, input, signal) => {
    const blob = await openAsBlob(getNativeFilePath(fileId(input.blobId)))
    await api.putUpload(opaque(input.uploadId), blob, signal)
  })
  register(
    'personal-cloud:downloadSnapshot',
    ['itemId', 'revision', 'blobId'],
    async (api, input, signal) => {
      const blobId = fileId(input.blobId)
      const destination = getNativeFilePath(blobId)
      const temporary = `${destination}.download-${randomUUID()}`
      try {
        const response = await api.downloadContent(
          opaque(input.itemId),
          number(input.revision),
          signal
        )
        const downloaded = await saveAssetContent(response, temporary, signal)
        signal.throwIfAborted()
        await fs.link(temporary, destination)
        return { fileId: blobId, size: downloaded.size, mimeType: downloaded.mimeType }
      } finally {
        await fs.rm(temporary, { force: true })
      }
    }
  )
  ipcMain.handle('personal-cloud:cancel', async (event, requestId: unknown): Promise<void> => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized personal cloud access')
    requests.get(fileId(requestId))?.abort()
  })
}
