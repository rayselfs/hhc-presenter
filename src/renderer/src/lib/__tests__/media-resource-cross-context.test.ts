import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  lockMediaResources,
  resetMediaResourceLocksForTests,
  withMediaResourceCleanup
} from '../media-resource-locks'

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

type LockCallback = (lock: { name: string } | null) => unknown

beforeEach(() => {
  resetMediaResourceLocksForTests()
})
afterEach(() => {
  resetMediaResourceLocksForTests()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

it('does not resolve projection acquisition while another context holds cleanup ownership', async () => {
  let grant: (() => void) | undefined
  const request = vi.fn(
    (name: string, _options: unknown, callback: LockCallback) =>
      new Promise<void>((resolve, reject) => {
        grant = () => {
          Promise.resolve(callback({ name })).then(() => resolve(), reject)
        }
      })
  )
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  const release = lockMediaResources(['clip'])
  const acquired = vi.fn()
  void release.ready?.then(acquired)
  await Promise.resolve()
  expect(acquired).not.toHaveBeenCalled()
  grant?.()
  await release.ready
  expect(acquired).toHaveBeenCalledOnce()
  release()
})

it('defers cross-context cleanup until the remote shared lease actually releases', async () => {
  let grantCleanup: (() => Promise<unknown>) | undefined
  const request = vi.fn((name: string, options: unknown, callback?: LockCallback) => {
    if (typeof options === 'function') {
      grantCleanup = () => Promise.resolve(options({ name }))
      return Promise.resolve()
    }
    return Promise.resolve(callback?.(null))
  })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  const cleanup = vi.fn(async () => undefined)
  await withMediaResourceCleanup('clip', cleanup)
  expect(cleanup).not.toHaveBeenCalled()
  expect(grantCleanup).toBeDefined()
  await grantCleanup?.()
  expect(cleanup).toHaveBeenCalledOnce()
})

it('releasing before a queued shared lease is granted does not retain that lease', async () => {
  let grant: (() => Promise<unknown>) | undefined
  const request = vi.fn((name: string, _options: unknown, callback: LockCallback) => {
    grant = () => Promise.resolve(callback({ name }))
    return Promise.resolve()
  })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  const release = lockMediaResources(['clip'])
  release()
  await expect(grant?.()).resolves.toBeUndefined()
  await release.ready
})

it('skips busy cache eviction without queuing deletion after the user action completes', async () => {
  const request = vi.fn((_name: string, _options: unknown, callback: LockCallback) =>
    Promise.resolve(callback(null))
  )
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  const cleanup = vi.fn(async () => undefined)
  await withMediaResourceCleanup('clip', cleanup, { defer: false })
  expect(request).toHaveBeenCalledOnce()
  expect(cleanup).not.toHaveBeenCalled()
})

it('reuses a held shared lease when a session replacement overlaps the same resource', async () => {
  let unlock: (() => void) | undefined
  const request = vi.fn((name: string, _options: unknown, callback: LockCallback) => {
    const result = callback({ name })
    return new Promise<void>((resolve) => {
      unlock = resolve
      void Promise.resolve(result).then(() => resolve())
    })
  })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  const oldSession = lockMediaResources(['clip'])
  await oldSession.ready
  // A remote exclusive request may now be queued. Reacquiring would wait behind it forever.
  const nextSession = lockMediaResources(['clip'])
  await nextSession.ready
  expect(request).toHaveBeenCalledOnce()
  oldSession()
  const cleanup = vi.fn(async () => undefined)
  await withMediaResourceCleanup('clip', cleanup, { defer: false })
  expect(cleanup).not.toHaveBeenCalled()
  nextSession()
  unlock?.()
})
