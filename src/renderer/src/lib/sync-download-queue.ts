import { SyncDownloadCancelledError } from './sync-provider'
import type {
  ReadOnlySyncProvider,
  SyncDownloadRequest,
  SyncDownloadResult,
  SyncDownloadCommitGuard,
  SyncRetryClassification
} from './sync-provider'
import { getFileBlobRecord, isFileBlobRecordAvailable } from './file-explorer-db'
import {
  getSyncEntryByRemoteItem,
  putSyncEntry,
  type SyncEntryRecord,
  type SyncEntryStatus
} from './sync-db'
import { isSyncStorageLimitError } from './sync-download-storage'

export const SYNC_DOWNLOAD_CONCURRENCY = 1

const RETRY_BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000]

export type SyncDownloadPriority = 'presentation' | 'manual' | 'background'

export interface SyncDownloadEntry {
  providerConnectionId: string
  remoteItemId: string
  parentRemoteItemId: string | null
  kind: 'file'
  name: string
  itemId: string
  mimeType?: string
  size?: number
  etag?: string
  contentHash?: string
}

export interface SyncDownloadFailure {
  status: SyncEntryStatus
  errorKind?: SyncRetryClassification
  retryCount?: number
  nextRetryAt?: number
  lastError: string
}

export interface EnqueueSyncDownloadInput {
  provider: ReadOnlySyncProvider
  request: SyncDownloadRequest
  entry: SyncDownloadEntry
  previousEntry?: SyncEntryRecord
  priority?: SyncDownloadPriority
  canCommit?: SyncDownloadCommitGuard
  withCommitLock?: (mutation: () => Promise<void>) => Promise<void>
  onDownloaded?: (
    result: SyncDownloadResult,
    canCommit: SyncDownloadCommitGuard
  ) => void | Promise<void>
  onFailed?: (error: unknown) => void | Promise<void>
}

interface SyncDownloadQueueJob extends EnqueueSyncDownloadInput {
  key: string
  priorityValue: number
  sequence: number
  promise: Promise<SyncDownloadResult | null>
  resolve: (result: SyncDownloadResult | null) => void
  controller: AbortController
  cancelled: boolean
  active: boolean
}

const priorityValues: Record<SyncDownloadPriority, number> = {
  presentation: 0,
  manual: 1,
  background: 2
}

const queuedJobs: SyncDownloadQueueJob[] = []
const jobsByKey = new Map<string, SyncDownloadQueueJob>()
let activeCount = 0
let nextSequence = 0

function getQueueKey(request: SyncDownloadRequest): string {
  return `${request.providerConnectionId}:${request.remoteItemId}`
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getRetryDelayMs(retryCount: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(retryCount - 1, 0), RETRY_BACKOFF_MS.length - 1)]
}

function hasSameContentIdentity(current: SyncEntryRecord, entry: SyncDownloadEntry): boolean {
  if (current.etag && entry.etag && current.etag !== entry.etag) return false
  if (current.contentHash && entry.contentHash && current.contentHash !== entry.contentHash) {
    return false
  }
  if (
    typeof current.size === 'number' &&
    typeof entry.size === 'number' &&
    current.size !== entry.size
  ) {
    return false
  }
  return true
}

async function getAlreadyAvailableResult(
  job: SyncDownloadQueueJob
): Promise<SyncDownloadResult | null> {
  const current = await getSyncEntryByRemoteItem(
    job.entry.providerConnectionId,
    job.entry.remoteItemId
  )
  if (
    current?.kind !== 'file' ||
    current.status !== 'available-offline' ||
    !current.blobId ||
    current.itemId !== job.entry.itemId ||
    !hasSameContentIdentity(current, job.entry)
  ) {
    return null
  }
  const record = await getFileBlobRecord(current.blobId)
  if (!record || !(await isFileBlobRecordAvailable(record))) return null
  return {
    blobId: current.blobId,
    size: record.size ?? current.size ?? 0,
    mimeType: current.mimeType ?? job.entry.mimeType ?? ''
  }
}

export function classifySyncDownloadFailure(
  provider: Pick<ReadOnlySyncProvider, 'classifyError'>,
  error: unknown,
  previousEntry: SyncEntryRecord | undefined,
  now = Date.now()
): SyncDownloadFailure {
  if (isSyncStorageLimitError(error)) {
    return {
      status: 'insufficient-storage',
      lastError: getErrorMessage(error)
    }
  }

  const errorKind = provider.classifyError(error)
  if (errorKind === 'retryable' || errorKind === 'offline') {
    const retryCount = (previousEntry?.retryCount ?? 0) + 1
    return {
      status: 'failed',
      errorKind,
      retryCount,
      nextRetryAt: now + getRetryDelayMs(retryCount),
      lastError: getErrorMessage(error)
    }
  }

  return {
    status: 'failed',
    errorKind,
    lastError: getErrorMessage(error)
  }
}

export function enqueueSyncDownload(
  input: EnqueueSyncDownloadInput
): Promise<SyncDownloadResult | null> {
  const key = getQueueKey(input.request)
  const priorityValue = priorityValues[input.priority ?? 'background']
  const existing = jobsByKey.get(key)
  if (existing) {
    existing.priorityValue = Math.min(existing.priorityValue, priorityValue)
    sortQueuedJobs()
    return existing.promise
  }

  let resolve!: (result: SyncDownloadResult | null) => void
  const promise = new Promise<SyncDownloadResult | null>((resolvePromise) => {
    resolve = resolvePromise
  })
  const job: SyncDownloadQueueJob = {
    ...input,
    key,
    priorityValue,
    sequence: nextSequence++,
    promise,
    resolve,
    controller: new AbortController(),
    cancelled: false,
    active: false
  }
  queuedJobs.push(job)
  jobsByKey.set(key, job)
  sortQueuedJobs()
  pumpSyncDownloadQueue()
  return promise
}

export function cancelSyncDownloads(scope: {
  providerConnectionId: string
  remoteItemId?: string
  rootRemoteFolderId?: string
}): number {
  let cancelledCount = 0
  for (const job of [...jobsByKey.values()]) {
    if (
      job.request.providerConnectionId !== scope.providerConnectionId ||
      (scope.remoteItemId !== undefined && job.request.remoteItemId !== scope.remoteItemId) ||
      (scope.rootRemoteFolderId !== undefined &&
        job.request.rootRemoteFolderId !== scope.rootRemoteFolderId)
    ) {
      continue
    }
    cancelledCount += 1
    job.cancelled = true
    job.controller.abort()
    if (job.active && job.provider.providerType === 'hhc-line') {
      void window.api?.hhcAssets?.cancelDownload(job.request.targetBlobId).catch(() => undefined)
    }
    const queuedIndex = queuedJobs.indexOf(job)
    if (queuedIndex >= 0) {
      queuedJobs.splice(queuedIndex, 1)
      jobsByKey.delete(job.key)
      job.resolve(null)
    }
  }
  return cancelledCount
}

export async function cancelSyncDownloadsAndWait(scope: {
  providerConnectionId: string
  remoteItemId?: string
  rootRemoteFolderId?: string
}): Promise<number> {
  const pending = [...jobsByKey.values()]
    .filter(
      (job) =>
        job.request.providerConnectionId === scope.providerConnectionId &&
        (scope.remoteItemId === undefined || job.request.remoteItemId === scope.remoteItemId) &&
        (scope.rootRemoteFolderId === undefined ||
          job.request.rootRemoteFolderId === scope.rootRemoteFolderId)
    )
    .map((job) => job.promise)
  const cancelled = cancelSyncDownloads(scope)
  await Promise.all(pending)
  return cancelled
}

function sortQueuedJobs(): void {
  queuedJobs.sort((a, b) => a.priorityValue - b.priorityValue || a.sequence - b.sequence)
}

function pumpSyncDownloadQueue(): void {
  while (activeCount < SYNC_DOWNLOAD_CONCURRENCY && queuedJobs.length > 0) {
    const job = queuedJobs.shift()
    if (!job) return
    job.active = true
    activeCount += 1
    void runSyncDownloadJob(job)
  }
}

async function runSyncDownloadJob(job: SyncDownloadQueueJob): Promise<void> {
  let detached = false
  const canCommit = async (): Promise<boolean> =>
    !job.cancelled &&
    !job.controller.signal.aborted &&
    (job.canCommit ? await job.canCommit() : true)
  const commit = job.withCommitLock ?? ((mutation: () => Promise<void>) => mutation())
  try {
    if (!(await canCommit())) throw new SyncDownloadCancelledError()
    const alreadyAvailable = await getAlreadyAvailableResult(job)
    if (!(await canCommit())) throw new SyncDownloadCancelledError()
    if (alreadyAvailable) {
      job.resolve(alreadyAvailable)
      return
    }
    await commit(async () => {
      if (!(await canCommit())) throw new SyncDownloadCancelledError()
      await putSyncEntry({
        ...job.entry,
        status: 'downloading',
        errorKind: undefined,
        retryCount: undefined,
        nextRetryAt: undefined,
        lastError: undefined,
        downloadedBytes: 0,
        downloadTotalBytes: job.entry.size
      })
    })
    const result = await job.provider.downloadContent(job.request, job.controller.signal, canCommit)
    if (!(await canCommit())) throw new SyncDownloadCancelledError()
    await job.onDownloaded?.(result, canCommit)
    if (!(await canCommit())) throw new SyncDownloadCancelledError()
    job.resolve(result)
  } catch (error) {
    if (job.cancelled || error instanceof SyncDownloadCancelledError) {
      job.resolve(null)
      return
    }
    let committedFailure = false
    try {
      await commit(async () => {
        if (!(await canCommit())) return
        const failure = classifySyncDownloadFailure(job.provider, error, job.previousEntry)
        await putSyncEntry({ ...job.entry, ...failure })
        committedFailure = true
      })
    } catch (persistenceError) {
      console.warn('[sync] Failed to persist download failure', persistenceError)
      job.resolve(null)
      return
    }
    if (!committedFailure) {
      job.resolve(null)
      return
    }
    console.warn('[sync] Failed to download synced file', {
      providerConnectionId: job.entry.providerConnectionId,
      remoteItemId: job.entry.remoteItemId,
      error
    })
    job.cancelled = true
    job.active = false
    activeCount = Math.max(0, activeCount - 1)
    if (jobsByKey.get(job.key) === job) jobsByKey.delete(job.key)
    detached = true
    await Promise.resolve(job.onFailed?.(error)).catch(() => {
      console.warn('[sync] Failed to handle synced file failure')
    })
    job.resolve(null)
  } finally {
    if (!detached) {
      job.active = false
      activeCount = Math.max(0, activeCount - 1)
      if (jobsByKey.get(job.key) === job) jobsByKey.delete(job.key)
    }
    pumpSyncDownloadQueue()
  }
}

export function resetSyncDownloadQueueForTests(): void {
  queuedJobs.splice(0, queuedJobs.length)
  jobsByKey.clear()
  activeCount = 0
  nextSequence = 0
}
