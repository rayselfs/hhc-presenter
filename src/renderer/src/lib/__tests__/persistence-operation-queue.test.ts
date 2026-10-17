import { describe, expect, it, vi } from 'vitest'
import { createPersistenceOperationQueue } from '@renderer/lib/persistence-operation-queue'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve = (): void => undefined
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('createPersistenceOperationQueue', () => {
  it('runs operations serially in enqueue order', async () => {
    const first = deferred()
    const calls: string[] = []
    const queue = createPersistenceOperationQueue()

    queue.enqueue(async () => {
      calls.push('first:start')
      await first.promise
      calls.push('first:end')
    })
    queue.enqueue(async () => {
      calls.push('second')
    })

    await vi.waitFor(() => expect(calls).toEqual(['first:start']))
    expect(queue.snapshot()).toMatchObject({ pendingCount: 2, status: 'saving' })

    first.resolve()

    await vi.waitFor(() => {
      expect(calls).toEqual(['first:start', 'first:end', 'second'])
      expect(queue.snapshot()).toEqual({ pendingCount: 0, status: 'idle', error: null })
    })
  })

  it('retains a failed operation and blocks later writes until retry succeeds', async () => {
    let shouldFail = true
    const calls: string[] = []
    const queue = createPersistenceOperationQueue()

    queue.enqueue(async () => {
      calls.push('first')
      if (shouldFail) throw new Error('quota exceeded')
    })
    queue.enqueue(async () => {
      calls.push('second')
    })

    await vi.waitFor(() => expect(queue.snapshot().status).toBe('failed'))
    expect(calls).toEqual(['first'])
    expect(queue.snapshot()).toEqual({
      pendingCount: 2,
      status: 'failed',
      error: 'quota exceeded'
    })

    shouldFail = false
    await queue.retry()

    expect(calls).toEqual(['first', 'first', 'second'])
    expect(queue.snapshot()).toEqual({ pendingCount: 0, status: 'idle', error: null })
  })

  it('reports non-Error failures and notifies subscribers of state changes', async () => {
    const listener = vi.fn()
    const queue = createPersistenceOperationQueue()
    const unsubscribe = queue.subscribe(listener)

    queue.enqueue(async () => {
      throw 'storage unavailable'
    })

    await vi.waitFor(() => expect(queue.snapshot().status).toBe('failed'))
    expect(queue.snapshot()).toEqual({
      pendingCount: 1,
      status: 'failed',
      error: 'storage unavailable'
    })
    expect(listener).toHaveBeenCalledWith({
      pendingCount: 1,
      status: 'failed',
      error: 'storage unavailable'
    })

    unsubscribe()
    listener.mockClear()
    await queue.retry()
    expect(listener).not.toHaveBeenCalled()
  })
})

it('waits for earlier writes and resolves a command independently of later writes', async () => {
  const first = deferred()
  const last = deferred()
  const calls: string[] = []
  const queue = createPersistenceOperationQueue()
  queue.enqueue(async () => {
    await first.promise
    calls.push('earlier')
  })
  const committed = queue.commit(async () => {
    calls.push('command')
  })
  queue.enqueue(async () => {
    await last.promise
    calls.push('later')
  })
  expect(calls).toEqual([])
  first.resolve()
  await committed
  expect(calls).toEqual(['earlier', 'command'])
  last.resolve()
  await queue.flush()
  expect(calls).toEqual(['earlier', 'command', 'later'])
})

it('reports failed commands once without replaying a rejected action on persistence retry', async () => {
  const queue = createPersistenceOperationQueue()
  const command = vi.fn().mockRejectedValue(new Error('Invalid destination'))
  await expect(queue.commit(command)).rejects.toThrow('Invalid destination')
  await queue.flush()
  await queue.retry()
  expect(command).toHaveBeenCalledOnce()
  expect(queue.snapshot()).toMatchObject({ pendingCount: 0, status: 'idle' })
})

it('rejects blocked commands while retaining prior and later legacy writes for explicit retry', async () => {
  const first = deferred()
  let failing = true
  const queue = createPersistenceOperationQueue()
  const command = vi.fn()
  const later = vi.fn().mockResolvedValue(undefined)
  queue.enqueue(async () => {
    await first.promise
    if (failing) throw new Error('Storage full')
  })
  const blocked = expect(queue.commit(command)).rejects.toThrow('Storage full')
  queue.enqueue(later)
  first.resolve()
  await blocked
  expect(command).not.toHaveBeenCalled()
  expect(queue.snapshot()).toMatchObject({ pendingCount: 2, status: 'failed' })
  await expect(queue.commit(command)).rejects.toThrow('Storage full')
  failing = false
  await queue.retry()
  expect(later).toHaveBeenCalledOnce()
  expect(command).not.toHaveBeenCalled()
})

it('drains a write enqueued synchronously by an idle-state subscriber', async () => {
  const queue = createPersistenceOperationQueue()
  const write = vi.fn().mockResolvedValue(undefined)
  let added = false
  queue.subscribe((state) => {
    if (state.status === 'idle' && !added) {
      added = true
      queue.enqueue(write)
    }
  })
  queue.enqueue(async () => {})
  await queue.flush()
  expect(write).toHaveBeenCalledOnce()
  expect(queue.snapshot()).toMatchObject({ pendingCount: 0, status: 'idle' })
})
