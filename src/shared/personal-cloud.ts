import { APP_CONFIG } from './app-config'
import type { HhcSession } from './hhc-auth'

export interface PersonalSpace {
  id: string
  revision: number
  usedBytes: number
  quotaBytes: number
}
export interface PersonalUsage {
  activeBytes: number
  trashBytes: number
  protectedBytes: number
  usedBytes: number
  quotaBytes: number
  overrideBytes: number | null
}
export interface PersonalTrashPurgeInput {
  operationId: string
  itemIds?: string[]
  all?: boolean
}
export interface PersonalTrashPurgeResult {
  purgedItemIds: string[]
}
export interface PersonalQuotaExceededData {
  usedBytes: number
  quotaBytes: number
  requiredBytes: number
}
export interface PersonalRemoteNode {
  id: string
  collectionId: string
  parentId?: string
  kind: 'folder' | 'file'
  name: string
  assetId?: string
  revision: number
  mimeType?: string
  sizeBytes?: number
  etag?: string
  deletedAt?: string
  purged?: true
}
export interface PersonalFolderGrant {
  id: string
  folderItemId: string
  ownerUserId: string
  granteeUserId: string
  createdAt: string
}
export interface SharedFolderRoot {
  grantId: string
  ownerUserId: string
  root: PersonalRemoteNode
  collectionRevision: number
}
export interface SharedFolderSnapshot {
  grantId: string
  collectionRevision: number
  items: PersonalRemoteNode[]
  nextCursor: string
  hasMore: boolean
  reset: true
}
export interface PersonalChangePage {
  collection: Pick<PersonalSpace, 'id' | 'revision'>
  items: PersonalRemoteNode[]
  nextCursor: string
  hasMore: boolean
  reset: boolean
}
export interface PersonalUploadInput {
  fileName: string
  mimeType: string
  sizeBytes: number
}
export interface PersonalUploadState {
  id: string
  contentPath: string
  expiresAt: string
  uploadStatus: 'created' | 'completed' | 'failed'
  scanStatus: 'pending' | 'clean' | 'infected' | 'failed'
  processingStatus: 'pending' | 'ready' | 'not_required' | 'failed'
}
export interface PersonalMutationRequest {
  operationId: string
  itemId: string
  type:
    | 'create-folder'
    | 'create-file'
    | 'replace-content'
    | 'rename'
    | 'move'
    | 'delete'
    | 'restore'
  parentId?: string
  name?: string
  uploadId?: string
  expectedRevision?: number
  expectedCollectionRevision?: number
}
export interface PersonalMutationResult {
  itemId: string
  nodeRevision: number
  collectionRevision: number
}

export class PersonalCloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs = 0,
    readonly data?: PersonalQuotaExceededData
  ) {
    super(`Personal cloud request failed: ${status} ${code}`)
  }
}

export interface PersonalCloudHttpApi {
  ensureSpace(signal?: AbortSignal): Promise<PersonalSpace>
  getUsage(signal?: AbortSignal): Promise<PersonalUsage>
  getChanges(cursor?: string, signal?: AbortSignal): Promise<PersonalChangePage>
  createUpload(
    input: PersonalUploadInput,
    operationId: string,
    signal?: AbortSignal
  ): Promise<PersonalUploadState>
  getUpload(uploadId: string, signal?: AbortSignal): Promise<PersonalUploadState>
  putUpload(uploadId: string, blob: Blob, signal?: AbortSignal): Promise<void>
  completeUpload(
    uploadId: string,
    input: Pick<PersonalUploadInput, 'mimeType' | 'sizeBytes'> & { checksumSha256: string },
    signal?: AbortSignal
  ): Promise<PersonalUploadState>
  mutate(input: PersonalMutationRequest, signal?: AbortSignal): Promise<PersonalMutationResult>
  purgeTrash(
    input: PersonalTrashPurgeInput,
    signal?: AbortSignal
  ): Promise<PersonalTrashPurgeResult>
  downloadContent(itemId: string, revision: number, signal?: AbortSignal): Promise<Response>
  listFolderShares(itemId: string, signal?: AbortSignal): Promise<PersonalFolderGrant[]>
  createFolderShare(
    itemId: string,
    granteeUserId: string,
    signal?: AbortSignal
  ): Promise<PersonalFolderGrant>
  revokeFolderShare(itemId: string, grantId: string, signal?: AbortSignal): Promise<void>
  listSharedFolders(signal?: AbortSignal): Promise<SharedFolderRoot[]>
  getSharedFolderSnapshot(
    grantId: string,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<SharedFolderSnapshot>
  leaveSharedFolder(grantId: string, signal?: AbortSignal): Promise<void>
  downloadSharedContent(grantId: string, itemId: string, signal?: AbortSignal): Promise<Response>
}

const ROOT = '/api/assets/personal-space'
export const PERSONAL_MAX_FILE_BYTES = 200 * 1024 * 1024

export function formatPersonalGiB(bytes: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** 3)
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new PersonalCloudHttpError(0, 'invalid-response')
}
function object(value: unknown): Record<string, unknown> {
  requireValid(Boolean(value) && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  requireValid(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))
  return value
}
function revision(value: unknown, minimum = 0): number {
  requireValid(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum)
  return value
}
function bytes(value: unknown, minimum = 0): number {
  requireValid(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum)
  return value
}
function space(value: unknown): PersonalSpace {
  const item = object(value)
  return {
    ...collectionRef(value),
    usedBytes: bytes(item.usedBytes),
    quotaBytes: bytes(item.quotaBytes, 1)
  }
}
function collectionRef(value: unknown): Pick<PersonalSpace, 'id' | 'revision'> {
  const item = object(value)
  return { id: id(item.id), revision: revision(item.revision) }
}
export function requirePersonalUsage(value: unknown): PersonalUsage {
  const item = object(value)
  return {
    activeBytes: bytes(item.activeBytes),
    trashBytes: bytes(item.trashBytes),
    protectedBytes: bytes(item.protectedBytes),
    usedBytes: bytes(item.usedBytes),
    quotaBytes: bytes(item.quotaBytes, 1),
    overrideBytes: item.overrideBytes === null ? null : bytes(item.overrideBytes, 1)
  }
}
function upload(value: unknown): PersonalUploadState {
  const item = object(value)
  const uploadId = id(item.id)
  requireValid(item.contentPath === `${ROOT}/uploads/${uploadId}/content`)
  requireValid(typeof item.expiresAt === 'string' && Number.isFinite(Date.parse(item.expiresAt)))
  const uploadStatus = item.uploadStatus
  const scanStatus = item.scanStatus
  const processingStatus = item.processingStatus
  requireValid(
    uploadStatus === 'created' || uploadStatus === 'completed' || uploadStatus === 'failed'
  )
  requireValid(
    scanStatus === 'pending' ||
      scanStatus === 'clean' ||
      scanStatus === 'infected' ||
      scanStatus === 'failed'
  )
  requireValid(
    processingStatus === 'pending' ||
      processingStatus === 'ready' ||
      processingStatus === 'not_required' ||
      processingStatus === 'failed'
  )
  return {
    id: uploadId,
    contentPath: item.contentPath,
    expiresAt: item.expiresAt,
    uploadStatus,
    scanStatus,
    processingStatus
  }
}
function changes(value: unknown): PersonalChangePage {
  const page = object(value)
  const collection = collectionRef(page.collection)
  requireValid(Array.isArray(page.items) && page.items.length <= 500)
  requireValid(typeof page.nextCursor === 'string' && page.nextCursor.length <= 2048)
  requireValid(typeof page.hasMore === 'boolean' && typeof page.reset === 'boolean')
  const items = page.items.map((value): PersonalRemoteNode => {
    const item = object(value)
    requireValid(item.collectionId === collection.id)
    requireValid(item.kind === 'folder' || item.kind === 'file')
    requireValid(item.parentId === undefined || typeof item.parentId === 'string')
    requireValid(item.assetId === undefined || typeof item.assetId === 'string')
    requireValid(item.purged === undefined || item.purged === true)
    requireValid(
      item.kind !== 'file' || item.deletedAt !== undefined || item.purged || Boolean(item.assetId)
    )
    requireValid(
      typeof item.name === 'string' &&
        item.name.trim().length > 0 &&
        Array.from(item.name).length <= 255
    )
    requireValid(
      item.deletedAt === undefined ||
        (typeof item.deletedAt === 'string' && Number.isFinite(Date.parse(item.deletedAt)))
    )
    return {
      id: id(item.id),
      collectionId: collection.id,
      kind: item.kind,
      name: item.name,
      revision: revision(item.revision, 1),
      ...(item.purged ? { purged: true as const } : {}),
      ...(item.parentId ? { parentId: id(item.parentId) } : {}),
      ...(item.assetId ? { assetId: id(item.assetId) } : {}),
      ...(typeof item.deletedAt === 'string' ? { deletedAt: item.deletedAt } : {})
    }
  })
  requireValid(items.every((item) => item.revision <= collection.revision))
  return {
    collection,
    items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    reset: page.reset
  }
}

function remoteNode(value: unknown): PersonalRemoteNode {
  const item = object(value)
  requireValid(item.kind === 'folder' || item.kind === 'file')
  requireValid(
    typeof item.name === 'string' &&
      item.name.trim().length > 0 &&
      Array.from(item.name).length <= 255
  )
  requireValid(item.kind !== 'file' || typeof item.assetId === 'string')
  return {
    id: id(item.id),
    collectionId: id(item.collectionId),
    kind: item.kind,
    name: item.name,
    revision: revision(item.revision, 1),
    ...(item.parentId === undefined ? {} : { parentId: id(item.parentId) }),
    ...(item.assetId === undefined ? {} : { assetId: id(item.assetId) }),
    ...(item.mimeType === undefined ? {} : { mimeType: textValue(item.mimeType, 255) }),
    ...(item.sizeBytes === undefined ? {} : { sizeBytes: bytes(item.sizeBytes) }),
    ...(item.etag === undefined ? {} : { etag: textValue(item.etag, 512) })
  }
}

function textValue(value: unknown, maximum: number): string {
  requireValid(typeof value === 'string' && value.length > 0 && value.length <= maximum)
  return value
}

function grant(value: unknown): PersonalFolderGrant {
  const item = object(value)
  const createdAt = textValue(item.createdAt, 64)
  requireValid(Number.isFinite(Date.parse(createdAt)))
  return {
    id: id(item.id),
    folderItemId: id(item.folderItemId),
    ownerUserId: id(item.ownerUserId),
    granteeUserId: id(item.granteeUserId),
    createdAt
  }
}

function sharedRoot(value: unknown): SharedFolderRoot {
  const item = object(value)
  const root = remoteNode(item.root)
  requireValid(root.kind === 'folder')
  return {
    grantId: id(item.grantId),
    ownerUserId: id(item.ownerUserId),
    root,
    collectionRevision: revision(item.collectionRevision, 1)
  }
}

function sharedSnapshot(value: unknown): SharedFolderSnapshot {
  const page = object(value)
  requireValid(Array.isArray(page.items) && page.items.length <= 100)
  requireValid(typeof page.nextCursor === 'string' && page.nextCursor.length <= 2048)
  requireValid(typeof page.hasMore === 'boolean' && page.reset === true)
  return {
    grantId: id(page.grantId),
    collectionRevision: revision(page.collectionRevision, 1),
    items: page.items.map(remoteNode),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    reset: true
  }
}

async function readJson(response: Response): Promise<unknown> {
  requireValid(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      requireValid(size <= 2 * 1024 * 1024)
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
}

// send supplies authentication in the browser or Electron main process; paths are fixed here.
export function createPersonalCloudHttpApi(
  send: (path: string, init: RequestInit) => Promise<Response>
): PersonalCloudHttpApi {
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    init.signal?.throwIfAborted()
    const response = await send(path, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      ...init
    })
    if (!response.ok) {
      const body = await readJson(response).catch(() => undefined)
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code.slice(0, 128)
          : 'request-failed'
      const rawData = error && typeof error === 'object' && 'data' in error ? error.data : undefined
      let data: PersonalQuotaExceededData | undefined
      if (code === 'quota-exceeded') {
        try {
          const value = object(rawData)
          data = {
            usedBytes: bytes(value.usedBytes),
            quotaBytes: bytes(value.quotaBytes, 1),
            requiredBytes: bytes(value.requiredBytes, 1)
          }
        } catch {
          data = undefined
        }
      }
      const retry = response.headers.get('retry-after')
      const seconds = retry === null ? 0 : Number(retry)
      const retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000)
        : Math.max(0, Date.parse(retry ?? '') - Date.now()) || 0
      throw new PersonalCloudHttpError(response.status, code, Math.min(retryAfterMs, 3600000), data)
    }
    return response
  }
  const json = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await request(path, init)
    try {
      return await readJson(response)
    } catch {
      throw new PersonalCloudHttpError(0, 'invalid-response')
    }
  }
  const post = (body: unknown, signal?: AbortSignal): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  return {
    ensureSpace: async (signal) => space(await json(ROOT, post({}, signal))),
    getUsage: async (signal) => requirePersonalUsage(await json(`${ROOT}/usage`, { signal })),
    getChanges: async (cursor, signal) =>
      changes(
        await json(`${ROOT}/changes${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`, {
          signal
        })
      ),
    createUpload: async (input, operationId, signal) => {
      const init = post(input, signal)
      init.headers = { ...init.headers, 'Idempotency-Key': operationId }
      return upload(await json(`${ROOT}/uploads`, init))
    },
    getUpload: async (uploadId, signal) =>
      upload(await json(`${ROOT}/uploads/${id(uploadId)}`, { signal })),
    putUpload: async (uploadId, blob, signal) => {
      requireValid(blob.size > 0 && blob.size <= PERSONAL_MAX_FILE_BYTES)
      await request(`${ROOT}/uploads/${id(uploadId)}/content`, {
        method: 'PUT',
        body: blob,
        signal
      })
    },
    completeUpload: async (uploadId, input, signal) =>
      upload(await json(`${ROOT}/uploads/${id(uploadId)}/complete`, post(input, signal))),
    mutate: async (input, signal) => {
      const result = object(await json(`${ROOT}/mutations`, post(input, signal)))
      requireValid(result.itemId === input.itemId)
      return {
        itemId: id(result.itemId),
        nodeRevision: revision(result.nodeRevision, 1),
        collectionRevision: revision(result.collectionRevision, 1)
      }
    },
    purgeTrash: async (input, signal) => {
      requireValid(
        typeof input.operationId === 'string' &&
          input.operationId.length > 0 &&
          input.operationId.length <= 128 &&
          Boolean(input.all) !== Boolean(input.itemIds?.length)
      )
      if (input.itemIds) {
        requireValid(input.itemIds.length <= 1000)
        input.itemIds.forEach(id)
      }
      const result = object(await json(`${ROOT}/trash/purge`, post(input, signal)))
      requireValid(Array.isArray(result.purgedItemIds) && result.purgedItemIds.length <= 1000)
      return { purgedItemIds: result.purgedItemIds.map(id) }
    },
    downloadContent: (itemId, version, signal) =>
      request(`${ROOT}/items/${id(itemId)}/content?revision=${revision(version, 1)}`, { signal }),
    listFolderShares: async (itemId, signal) => {
      const result = object(await json(`${ROOT}/items/${id(itemId)}/shares`, { signal }))
      requireValid(Array.isArray(result.shares) && result.shares.length <= 100)
      return result.shares.map(grant)
    },
    createFolderShare: (itemId, granteeUserId, signal) =>
      json(
        `${ROOT}/items/${id(itemId)}/shares`,
        post({ granteeUserId: id(granteeUserId) }, signal)
      ).then(grant),
    revokeFolderShare: async (itemId, grantId, signal) => {
      await request(`${ROOT}/items/${id(itemId)}/shares/${id(grantId)}`, {
        method: 'DELETE',
        signal
      })
    },
    listSharedFolders: async (signal) => {
      const result = object(await json('/api/assets/shared-folders', { signal }))
      requireValid(Array.isArray(result.folders) && result.folders.length <= 100)
      return result.folders.map(sharedRoot)
    },
    getSharedFolderSnapshot: (grantId, cursor, signal) =>
      json(
        `/api/assets/shared-folders/${id(grantId)}/snapshot${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
        { signal }
      ).then(sharedSnapshot),
    leaveSharedFolder: async (grantId, signal) => {
      await request(`/api/assets/shared-folders/${id(grantId)}`, { method: 'DELETE', signal })
    },
    downloadSharedContent: (grantId, itemId, signal) =>
      request(`/api/assets/shared-folders/${id(grantId)}/items/${id(itemId)}/content`, { signal })
  }
}

export function createAuthenticatedPersonalCloudApi(
  auth: {
    getSession(): HhcSession | null | Promise<HhcSession | null>
    getAccessToken(): Promise<string | null>
    refreshAccessToken(): Promise<string | null>
  },
  ownerId: string,
  fetcher: typeof fetch = fetch
): PersonalCloudHttpApi {
  const assertOwner = async (signal?: AbortSignal | null): Promise<void> => {
    signal?.throwIfAborted()
    if ((await auth.getSession())?.userId !== ownerId) {
      throw new PersonalCloudHttpError(401, 'owner-changed')
    }
    signal?.throwIfAborted()
  }
  return createPersonalCloudHttpApi(async (path, init) => {
    await assertOwner(init.signal)
    const send = async (refresh: boolean): Promise<Response> => {
      const token = await (refresh ? auth.refreshAccessToken() : auth.getAccessToken())
      if (!token) throw new PersonalCloudHttpError(401, 'auth-required')
      await assertOwner(init.signal)
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${token}`)
      return fetcher(`${APP_CONFIG.hhcAssetOrigin}${path}`, { ...init, headers })
    }
    let response = await send(false)
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      response = await send(true)
    }
    try {
      await assertOwner(init.signal)
    } catch (error) {
      await response.body?.cancel().catch(() => undefined)
      throw error
    }
    return response
  })
}

export interface PersonalNativeRequest {
  ownerId: string
  requestId: string
}
export interface PersonalNativeDownload {
  fileId: string
  size: number
  mimeType: string
}
export type PersonalCloudReply<T> =
  | { ok: true; value: T }
  | {
      ok: false
      status: number
      code: string
      retryAfterMs: number
      data?: PersonalQuotaExceededData
    }
export interface PersonalNativeApi {
  ensureSpace(input: PersonalNativeRequest): Promise<PersonalCloudReply<PersonalSpace>>
  getUsage(input: PersonalNativeRequest): Promise<PersonalCloudReply<PersonalUsage>>
  getChanges(
    input: PersonalNativeRequest & { cursor?: string }
  ): Promise<PersonalCloudReply<PersonalChangePage>>
  createUpload(
    input: PersonalNativeRequest & { upload: PersonalUploadInput; operationId: string }
  ): Promise<PersonalCloudReply<PersonalUploadState>>
  getUpload(
    input: PersonalNativeRequest & { uploadId: string }
  ): Promise<PersonalCloudReply<PersonalUploadState>>
  uploadSnapshot(
    input: PersonalNativeRequest & { uploadId: string; blobId: string }
  ): Promise<PersonalCloudReply<void>>
  completeUpload(
    input: PersonalNativeRequest & {
      uploadId: string
      upload: Pick<PersonalUploadInput, 'mimeType' | 'sizeBytes'> & { blobId: string }
    }
  ): Promise<PersonalCloudReply<PersonalUploadState>>
  mutate(
    input: PersonalNativeRequest & { mutation: PersonalMutationRequest }
  ): Promise<PersonalCloudReply<PersonalMutationResult>>
  purgeTrash(
    input: PersonalNativeRequest & { purge: PersonalTrashPurgeInput }
  ): Promise<PersonalCloudReply<PersonalTrashPurgeResult>>
  downloadSnapshot(
    input: PersonalNativeRequest & { itemId: string; revision: number; blobId: string }
  ): Promise<PersonalCloudReply<PersonalNativeDownload>>
  listFolderShares(
    input: PersonalNativeRequest & { itemId: string }
  ): Promise<PersonalCloudReply<PersonalFolderGrant[]>>
  createFolderShare(
    input: PersonalNativeRequest & { itemId: string; granteeUserId: string }
  ): Promise<PersonalCloudReply<PersonalFolderGrant>>
  revokeFolderShare(
    input: PersonalNativeRequest & { itemId: string; grantId: string }
  ): Promise<PersonalCloudReply<void>>
  listSharedFolders(input: PersonalNativeRequest): Promise<PersonalCloudReply<SharedFolderRoot[]>>
  getSharedFolderSnapshot(
    input: PersonalNativeRequest & { grantId: string; cursor?: string }
  ): Promise<PersonalCloudReply<SharedFolderSnapshot>>
  leaveSharedFolder(
    input: PersonalNativeRequest & { grantId: string }
  ): Promise<PersonalCloudReply<void>>
  downloadSharedSnapshot(
    input: PersonalNativeRequest & { grantId: string; itemId: string; blobId: string }
  ): Promise<PersonalCloudReply<PersonalNativeDownload>>
  cancel(requestId: string): Promise<void>
}
