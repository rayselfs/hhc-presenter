export type PersistenceQueueSnapshot = {
  pendingCount: number
  status: 'idle' | 'saving' | 'failed'
  error: string | null
}

export type PersistenceOperationQueue = {
  enqueue: (operation: () => Promise<void>) => void
  commit: (operation: () => Promise<void>) => Promise<void>
  retry: () => Promise<void>
  flush: () => Promise<void>
  snapshot: () => PersistenceQueueSnapshot
  subscribe: (listener: (snapshot: PersistenceQueueSnapshot) => void) => () => void
}

export function createPersistenceOperationQueue(): PersistenceOperationQueue {
  const operations: Array<{
    run: () => Promise<void>
    rejectWhenBlocked?: (cause: unknown) => void
  }> = []
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
          await operations[0].run()
        } catch (cause) {
          status = 'failed'
          error = cause instanceof Error ? cause.message : String(cause)
          for (let index = operations.length - 1; index > 0; index--) {
            const blocked = operations[index].rejectWhenBlocked
            if (blocked) {
              operations.splice(index, 1)
              blocked(cause)
            }
          }
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
      if (status !== 'failed' && operations.length > 0) void drain()
    })

    return drainPromise
  }

  const enqueue = (operation: () => Promise<void>): void => {
    operations.push({ run: operation })
    emit()
    void drain()
  }
  const flush = async (): Promise<void> => {
    do {
      await drain()
    } while (status !== 'failed' && operations.length > 0)
    if (status === 'failed') throw new Error(error ?? 'Unable to save pending changes')
  }

  return {
    enqueue,
    commit(operation): Promise<void> {
      if (status === 'failed')
        return Promise.reject(new Error(error ?? 'Unable to save pending changes'))
      return new Promise<void>((resolve, reject) => {
        operations.push({
          rejectWhenBlocked: reject,
          async run(): Promise<void> {
            try {
              await operation()
              resolve()
            } catch (cause) {
              reject(cause)
            }
          }
        })
        emit()
        void drain()
      })
    },
    flush,

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
