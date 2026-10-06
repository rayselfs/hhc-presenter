type DeferredCleanup = () => Promise<void> | void

const lockCounts = new Map<string, number>()
const sharedLocks = new Map<string, { ready: Promise<void>; release?: () => void }>()
const deferredCleanups = new Map<string, Set<DeferredCleanup>>()

async function runDeferredCleanups(resourceId: string): Promise<void> {
  const cleanups = deferredCleanups.get(resourceId)
  if (!cleanups) return
  deferredCleanups.delete(resourceId)
  await Promise.allSettled([...cleanups].map((cleanup) => cleanup()))
}

export function isMediaResourceLocked(resourceId: string): boolean {
  return (lockCounts.get(resourceId) ?? 0) > 0
}

export type MediaResourceRelease = (() => void) & { ready?: Promise<void> }

export function lockMediaResources(resourceIds: Iterable<string>): MediaResourceRelease {
  const lockedIds = [...new Set(resourceIds)]
  for (const resourceId of lockedIds) {
    lockCounts.set(resourceId, (lockCounts.get(resourceId) ?? 0) + 1)
  }

  // Reuse this renderer's shared lease: a queued remote writer must not deadlock a session swap.
  let released = false
  const acquisitions: Promise<void>[] = []
  if (typeof navigator !== 'undefined' && navigator.locks) {
    for (const resourceId of lockedIds) {
      let shared = sharedLocks.get(resourceId)
      if (!shared) {
        const lease: { ready: Promise<void>; release?: () => void } = { ready: Promise.resolve() }
        sharedLocks.set(resourceId, lease)
        lease.ready = new Promise<void>((resolve, reject) => {
          void navigator.locks
            .request(`media-resource:${resourceId}`, { mode: 'shared' }, () => {
              resolve()
              if (sharedLocks.get(resourceId) !== lease) return
              return new Promise<void>((finish) => {
                lease.release = finish
              })
            })
            .catch(reject)
        })
        shared = lease
      }
      acquisitions.push(shared.ready)
    }
  }
  const release: MediaResourceRelease = () => {
    if (released) return
    released = true
    for (const resourceId of lockedIds) {
      const nextCount = (lockCounts.get(resourceId) ?? 1) - 1
      if (nextCount > 0) {
        lockCounts.set(resourceId, nextCount)
        continue
      }
      lockCounts.delete(resourceId)
      sharedLocks.get(resourceId)?.release?.()
      sharedLocks.delete(resourceId)
      void runDeferredCleanups(resourceId)
    }
  }
  if (acquisitions.length)
    release.ready = Promise.all(acquisitions).then(
      () => undefined,
      (error) => {
        release()
        throw error
      }
    )
  return release
}

export function deferMediaResourceCleanup(resourceId: string, cleanup: DeferredCleanup): boolean {
  if (!isMediaResourceLocked(resourceId)) return false
  const cleanups = deferredCleanups.get(resourceId) ?? new Set<DeferredCleanup>()
  cleanups.add(cleanup)
  deferredCleanups.set(resourceId, cleanups)
  return true
}

export function resetMediaResourceLocksForTests(): void {
  for (const lease of sharedLocks.values()) lease.release?.()
  sharedLocks.clear()
  lockCounts.clear()
  deferredCleanups.clear()
}

export async function withMediaResourceCleanup<T>(
  resourceId: string,
  operation: () => Promise<T>,
  options: { defer?: boolean } = {}
): Promise<T | undefined> {
  if (isMediaResourceLocked(resourceId)) {
    if (options.defer === false) return undefined
    deferMediaResourceCleanup(resourceId, async () => {
      await withMediaResourceCleanup(resourceId, operation)
    })
    return undefined
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(
      `media-resource:${resourceId}`,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => {
        if (lock) return operation()
        if (options.defer === false) return undefined
        // Another renderer still owns this source. Web Locks releases on tab/process exit.
        void navigator.locks
          .request(`media-resource:${resourceId}`, operation)
          .catch(() => undefined)
        return undefined
      }
    )
  }
  return operation()
}
