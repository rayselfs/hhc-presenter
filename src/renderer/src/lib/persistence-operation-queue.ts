export type PersistenceQueueSnapshot = {
  pendingCount: number
  status: 'idle' | 'saving' | 'failed'
  error: string | null
}

export type PersistenceOperationQueue = {
  enqueue: (operation: () => Promise<void>) => void
  retry: () => Promise<void>
  flush: () => Promise<void>
  snapshot: () => PersistenceQueueSnapshot
  subscribe: (listener: (snapshot: PersistenceQueueSnapshot) => void) => () => void
}

export function createPersistenceOperationQueue(): PersistenceOperationQueue {
  const operations: Array<() => Promise<void>> = []
  const listeners = new Set<(snapshot: PersistenceQueueSnapshot) => void>()
  let status: PersistenceQueueSnapshot['status'] = 'idle'
  let error: string | null = null
  let drainPromise: Promise<void> | null = null

  const snapshot = (): PersistenceQueueSnapshot => ({
    pendingCount: operations.length,
    status,
    error
  })

  const emit = (): void => {
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }

  const drain = (): Promise<void> => {
    if (drainPromise) return drainPromise
    if (status === 'failed' || operations.length === 0) return Promise.resolve()

    status = 'saving'
    emit()

    drainPromise = (async () => {
      while (operations.length > 0) {
        try {
          await operations[0]()
        } catch (cause) {
          status = 'failed'
          error = cause instanceof Error ? cause.message : String(cause)
          emit()
          return
        }

        operations.shift()
        emit()
      }

      status = 'idle'
      error = null
      emit()
    })().finally(() => {
      drainPromise = null
    })

    return drainPromise
  }

  return {
    enqueue(operation): void {
      operations.push(operation)
      emit()
      void drain()
    },

    async flush(): Promise<void> {
      await drain()
      if (status === 'failed') throw new Error(error ?? 'Unable to save pending changes')
    },

    async retry(): Promise<void> {
      if (drainPromise) await drainPromise
      if (status !== 'failed') return

      status = 'idle'
      error = null
      await drain()
    },

    snapshot,

    subscribe(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
