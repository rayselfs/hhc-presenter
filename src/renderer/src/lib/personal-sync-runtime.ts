import { PersonalCloudHttpError, type PersonalMutationRequest } from '@shared/personal-cloud'
import type { HhcAuthAdapter } from '@shared/hhc-auth'
import { createPersonalCloudProvider, type PersonalCloudProvider } from './personal-cloud-provider'
import { openFileExplorerDB } from './file-explorer-db'
import { ensurePersonalLocalSpace } from './personal-file-actions'
import { pullPersonalChanges } from './personal-sync-pull'
import { refreshPersonalCatalog } from '@renderer/stores/file-explorer'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { preservePersonalContentConflict } from './personal-sync-conflicts'
import { toast } from '@heroui/react/toast'
import i18n from '@renderer/i18n'
import {
  acknowledgePersonalOperation,
  acquirePersonalSyncLease,
  assertPersonalSyncLease,
  renewPersonalSyncLease,
  releasePersonalSyncLease,
  listPersonalOutbox,
  updatePersonalOperationTransfer,
  type PersonalOutboxRecord
} from './personal-sync-db'

// One durable step; the account scheduler owns retry timing, cancellation and lease renewal.
export async function advancePersonalOutbox(
  ownerId: string,
  workerId: string,
  api: PersonalCloudProvider,
  signal: AbortSignal
): Promise<'empty' | 'acknowledged' | 'scanning' | 'blocked'> {
  signal.throwIfAborted()
  let operation = (await listPersonalOutbox(ownerId))[0]
  if (!operation) return 'empty'
  if (operation.failure) return 'blocked'
  if (operation.dependsOn) throw new Error('Personal outbox dependency is unresolved')
  const update = async (
    value: Parameters<typeof updatePersonalOperationTransfer>[3]
  ): Promise<void> => {
    operation = await updatePersonalOperationTransfer(
      ownerId,
      workerId,
      operation.id,
      value,
      signal
    )
  }
  // Validate the current lease before starting any network operation.
  await update({})
  try {
    if (!operation.submittedRequest) {
      if (operation.snapshotBlobId) {
        if (!operation.fileName || !operation.mimeType || !operation.sizeBytes) {
          throw new PersonalCloudHttpError(0, 'source-missing')
        }
        const input = {
          fileName: operation.fileName,
          mimeType: operation.mimeType,
          sizeBytes: operation.sizeBytes
        }
        let upload
        try {
          upload = operation.uploadId
            ? await api.getUpload(operation.uploadId, signal)
            : await api.createUpload(
                input,
                `${operation.id}-upload-${operation.uploadAttempt ?? 0}`,
                signal
              )
        } catch (error) {
          if (!(error instanceof PersonalCloudHttpError) || ![404, 410].includes(error.status))
            throw error
          await update({ uploadId: undefined, uploadAttempt: (operation.uploadAttempt ?? 0) + 1 })
          return 'scanning'
        }
        if (upload.id !== operation.uploadId) await update({ uploadId: upload.id })
        if (Date.parse(upload.expiresAt) <= Date.now()) {
          await update({ uploadId: undefined, uploadAttempt: (operation.uploadAttempt ?? 0) + 1 })
          return 'scanning'
        }
        if (upload.uploadStatus === 'created') {
          try {
            await api.uploadSnapshot(upload.id, operation.snapshotBlobId, signal)
          } catch (error) {
            // A lost PUT response leaves immutable staging; completion verifies the original checksum.
            if (!(error instanceof PersonalCloudHttpError) || error.status !== 409) throw error
          }
          upload = await api.completeUpload(
            upload.id,
            {
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              blobId: operation.snapshotBlobId
            },
            signal
          )
        }
        if (
          upload.uploadStatus === 'failed' ||
          upload.scanStatus === 'infected' ||
          upload.scanStatus === 'failed' ||
          upload.processingStatus === 'failed'
        ) {
          await update({ failure: 'invalid-content' })
          return 'blocked'
        }
        if (
          upload.scanStatus !== 'clean' ||
          !['ready', 'not_required'].includes(upload.processingStatus)
        )
          return 'scanning'
      }
      await update({ submittedRequest: mutationRequest(operation) })
    }
    const request = operation.submittedRequest
    if (!request) throw new Error('Missing durable personal request')
    const result = await api.mutate(request, signal)
    await acknowledgePersonalOperation(ownerId, operation.id, result, signal, workerId)
    return 'acknowledged'
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof PersonalCloudHttpError)) throw error
    if (error.code === 'asset-not-ready') return 'scanning'
    if (
      error.status === 409 ||
      [400, 413, 422].includes(error.status) ||
      error.code === 'source-missing'
    ) {
      await update({
        failure:
          error.code === 'quota-exceeded'
            ? error.code
            : error.status === 409
              ? 'conflict'
              : error.code,
        ...(error.code === 'quota-exceeded' && error.data ? { failureData: error.data } : {})
      })
      return 'blocked'
    }
    throw error
  }
}

function mutationRequest(operation: PersonalOutboxRecord): PersonalMutationRequest {
  return {
    ...operation.mutation,
    operationId: operation.id,
    itemId: operation.remoteId,
    expectedRevision: operation.expectedRevision,
    expectedCollectionRevision: operation.expectedCollectionRevision,
    ...(operation.uploadId ? { uploadId: operation.uploadId } : {})
  }
}

export function requestPersonalSync(ownerId: string): void {
  window.dispatchEvent(new CustomEvent('hhc:personal-sync', { detail: ownerId }))
}

export function startPersonalSync(
  ownerId: string,
  auth: Pick<HhcAuthAdapter, 'getSession' | 'getAccessToken' | 'refreshAccessToken'>
): () => void {
  const workerId = crypto.randomUUID()
  const api = createPersonalCloudProvider(auth, ownerId)
  let stopped = false
  let running = false
  let pending = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  const publish = (
    syncStatus: ReturnType<typeof usePersonalSyncStore.getState>['syncStatus'],
    errorCode: string | null = null
  ): void => {
    if (!stopped && usePersonalSyncStore.getState().activeOwnerId === ownerId) {
      usePersonalSyncStore.setState({ syncStatus, errorCode })
    }
  }
  const schedule = (delay: number): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void run()
    }, delay)
  }
  const run = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    const current = new AbortController()
    controller = current
    const signal = current.signal
    let renewal: ReturnType<typeof setInterval> | undefined
    let delay = 30_000
    try {
      if (usePersonalSyncStore.getState().activeOwnerId !== ownerId) return
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        publish('pending')
        return
      }
      const db = await openFileExplorerDB()
      if (!(await db.get('personal-sync-state', ownerId))) {
        await ensurePersonalLocalSpace(ownerId, await api.ensureSpace(signal), signal)
      }
      signal.throwIfAborted()
      if (!(await acquirePersonalSyncLease(ownerId, workerId))) {
        usePersonalSyncStore.setState({ usage: await api.getUsage(signal) })
        await refreshPersonalCatalog(ownerId)
        delay = 2_000
        return
      }
      renewal = setInterval(() => {
        void renewPersonalSyncLease(ownerId, workerId)
          .then((owned) => {
            if (!owned) current.abort()
          })
          .catch(() => current.abort())
      }, 10_000)
      publish('syncing')
      let result: Awaited<ReturnType<typeof advancePersonalOutbox>> = 'empty'
      for (let count = 0; count < 50; count += 1) {
        result = await advancePersonalOutbox(ownerId, workerId, api, signal)
        if (result !== 'acknowledged') break
      }
      let more = false
      for (let count = 0; count < 10; count += 1) {
        try {
          more = await pullPersonalChanges(ownerId, workerId, api, signal)
        } catch (error) {
          if (error instanceof PersonalCloudHttpError && error.status === 404) {
            const tx = db.transaction('personal-sync-state', 'readwrite')
            const state = await tx.store.get(ownerId)
            if (state) {
              try {
                assertPersonalSyncLease(state, workerId)
                signal.throwIfAborted()
                await tx.store.put({ ...state, cursor: undefined, pullRevision: undefined })
                signal.throwIfAborted()
                await tx.done
              } catch (resetError) {
                try {
                  tx.abort()
                } catch {
                  /* Already aborted. */
                }
                await tx.done.catch(() => undefined)
                throw resetError
              }
            } else await tx.done
          }
          throw error
        }
        if (!more) break
      }
      const preserved = !more && (await preservePersonalContentConflict(ownerId, workerId, signal))
      if (preserved) {
        toast.warning(i18n.t('personalCloud.copyCreated'))
        result = 'scanning'
      }
      await refreshPersonalCatalog(ownerId)
      signal.throwIfAborted()
      const remaining = await listPersonalOutbox(ownerId)
      const failure = remaining[0]?.failure
      usePersonalSyncStore.setState({
        quotaExceeded: failure === 'quota-exceeded' ? (remaining[0]?.failureData ?? null) : null
      })
      usePersonalSyncStore.setState({ usage: await api.getUsage(signal) })
      publish(
        failure === 'conflict'
          ? 'conflict'
          : failure
            ? 'failed'
            : remaining.length || more
              ? 'pending'
              : 'synced',
        failure ?? null
      )
      failures = 0
      if (more || (remaining.length && result !== 'blocked')) delay = 2_000
    } catch (error) {
      if (!stopped) {
        failures += 1
        const status = error instanceof PersonalCloudHttpError ? error.status : 0
        const code = error instanceof PersonalCloudHttpError ? error.code : 'sync-failed'
        publish(status === 401 ? 'auth-required' : 'failed', code)
        delay = Math.max(
          Math.min(60_000, 2 ** Math.min(failures, 6) * 1_000),
          error instanceof PersonalCloudHttpError ? error.retryAfterMs : 0
        )
      }
    } finally {
      if (renewal) clearInterval(renewal)
      await releasePersonalSyncLease(ownerId, workerId).catch(() => undefined)
      if (controller === current) controller = undefined
      running = false
      if (pending) {
        pending = false
        delay = 0
      }
      schedule(delay)
    }
  }
  const wake = (): void => {
    if (running) pending = true
    else schedule(0)
  }
  const requested = (event: Event): void => {
    if (event instanceof CustomEvent && event.detail === ownerId) wake()
  }
  const visible = (): void => {
    if (document.visibilityState === 'visible') wake()
  }
  window.addEventListener('online', wake)
  window.addEventListener('focus', wake)
  window.addEventListener('hhc:personal-sync', requested)
  document.addEventListener('visibilitychange', visible)
  schedule(0)
  return () => {
    stopped = true
    controller?.abort()
    if (timer) clearTimeout(timer)
    window.removeEventListener('online', wake)
    window.removeEventListener('focus', wake)
    window.removeEventListener('hhc:personal-sync', requested)
    document.removeEventListener('visibilitychange', visible)
  }
}
