import type { HhcAuthAdapter } from '@shared/hhc-auth'
import {
  createAuthenticatedPersonalCloudApi,
  PersonalCloudHttpError,
  PERSONAL_MAX_FILE_BYTES,
  type PersonalCloudHttpApi,
  type PersonalUploadInput,
  type PersonalUploadState,
  type PersonalCloudReply,
  type PersonalNativeRequest
} from '@shared/personal-cloud'
import { getFileBlobRecord, type FileBlobRecord } from './file-explorer-db'
import { isElectron } from './env'

export type PersonalCloudProvider = Omit<
  PersonalCloudHttpApi,
  'putUpload' | 'downloadContent' | 'completeUpload'
> & {
  completeUpload(
    uploadId: string,
    input: Pick<PersonalUploadInput, 'mimeType' | 'sizeBytes'> & { blobId: string },
    signal?: AbortSignal
  ): Promise<PersonalUploadState>
  uploadSnapshot(uploadId: string, blobId: string, signal: AbortSignal): Promise<void>
  // Native callers journal and lock blobId until the catalog transaction commits.
  downloadSnapshot(
    itemId: string,
    revision: number,
    blobId: string,
    signal: AbortSignal
  ): Promise<FileBlobRecord & { mimeType: string }>
}

export function createPersonalCloudProvider(
  auth: Pick<HhcAuthAdapter, 'getSession' | 'getAccessToken' | 'refreshAccessToken'>,
  ownerId: string
): PersonalCloudProvider {
  if (isElectron()) {
    const native = window.api.personalCloud
    const invoke = async <T>(
      call: (request: PersonalNativeRequest) => Promise<PersonalCloudReply<T>>,
      signal?: AbortSignal
    ): Promise<T> => {
      signal?.throwIfAborted()
      const request = { ownerId, requestId: crypto.randomUUID() }
      const abort = (): void => {
        void native.cancel(request.requestId).catch(() => undefined)
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const reply = await call(request)
        signal?.throwIfAborted()
        if (!reply.ok) {
          throw new PersonalCloudHttpError(reply.status, reply.code, reply.retryAfterMs, reply.data)
        }
        return reply.value
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    }
    return {
      ensureSpace: (signal) => invoke((request) => native.ensureSpace(request), signal),
      getUsage: (signal) => invoke((request) => native.getUsage(request), signal),
      getChanges: (cursor, signal) =>
        invoke(
          (request) => native.getChanges({ ...request, ...(cursor ? { cursor } : {}) }),
          signal
        ),
      createUpload: (upload, operationId, signal) =>
        invoke((request) => native.createUpload({ ...request, upload, operationId }), signal),
      getUpload: (uploadId, signal) =>
        invoke((request) => native.getUpload({ ...request, uploadId }), signal),
      completeUpload: (uploadId, upload, signal) =>
        invoke((request) => native.completeUpload({ ...request, uploadId, upload }), signal),
      mutate: (mutation, signal) =>
        invoke((request) => native.mutate({ ...request, mutation }), signal),
      purgeTrash: (purge, signal) =>
        invoke((request) => native.purgeTrash({ ...request, purge }), signal),
      uploadSnapshot: (uploadId, blobId, signal) =>
        invoke((request) => native.uploadSnapshot({ ...request, uploadId, blobId }), signal),
      downloadSnapshot: async (itemId, revision, blobId, signal) => {
        const result = await invoke(
          (request) => native.downloadSnapshot({ ...request, itemId, revision, blobId }),
          signal
        )
        return {
          id: result.fileId,
          storage: 'native-fs',
          size: result.size,
          mimeType: result.mimeType
        }
      }
    }
  }
  const api = createAuthenticatedPersonalCloudApi(auth, ownerId)
  return {
    ensureSpace: api.ensureSpace,
    getUsage: api.getUsage,
    getChanges: api.getChanges,
    createUpload: api.createUpload,
    getUpload: api.getUpload,
    completeUpload: async (uploadId, input, signal) => {
      signal?.throwIfAborted()
      const record = await getFileBlobRecord(input.blobId)
      if (!record?.blob) throw new PersonalCloudHttpError(0, 'source-missing')
      const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer())
      signal?.throwIfAborted()
      return api.completeUpload(
        uploadId,
        {
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          checksumSha256: Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0')
          ).join('')
        },
        signal
      )
    },
    mutate: api.mutate,
    purgeTrash: api.purgeTrash,
    uploadSnapshot: async (uploadId, blobId, signal) => {
      signal.throwIfAborted()
      const record = await getFileBlobRecord(blobId)
      if (!record?.blob) throw new PersonalCloudHttpError(0, 'source-missing')
      await api.putUpload(uploadId, record.blob, signal)
    },
    downloadSnapshot: async (itemId, revision, blobId, signal) => {
      const response = await api.downloadContent(itemId, revision, signal)
      const length = response.headers.get('content-length')
      const declared = length === null ? undefined : Number(length)
      if (
        !response.body ||
        (declared !== undefined &&
          (!Number.isSafeInteger(declared) || declared <= 0 || declared > PERSONAL_MAX_FILE_BYTES))
      ) {
        await response.body?.cancel().catch(() => undefined)
        throw new PersonalCloudHttpError(0, 'invalid-content')
      }
      const reader = response.body.getReader()
      const chunks: BlobPart[] = []
      let size = 0
      try {
        for (;;) {
          signal.throwIfAborted()
          const part = await reader.read()
          signal.throwIfAborted()
          if (part.done) break
          size += part.value.byteLength
          if (size > PERSONAL_MAX_FILE_BYTES) throw new PersonalCloudHttpError(0, 'file-too-large')
          chunks.push(new Uint8Array(part.value))
        }
        if (size === 0 || (declared !== undefined && size !== declared)) {
          throw new PersonalCloudHttpError(0, 'incomplete-content')
        }
        const blob = new Blob(chunks, {
          type: response.headers.get('content-type') ?? 'application/octet-stream'
        })
        return { id: blobId, storage: 'indexed-db', size, blob, mimeType: blob.type }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    }
  }
}
