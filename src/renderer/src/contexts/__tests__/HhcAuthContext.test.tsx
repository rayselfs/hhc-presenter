import { act, render, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HhcAuthAdapter, HhcSession } from '@shared/hhc-auth'
import { createBrowserHhcAssetApi } from '@renderer/lib/hhc-asset-api-browser'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { HhcAuthProvider, useHhcAuth } from '../HhcAuthContext'

const authFactory = vi.hoisted(() => ({
  adapters: [] as HhcAuthAdapter[],
  create: vi.fn(async (): Promise<HhcAuthAdapter> => {
    const adapter = authFactory.adapters.shift()
    if (!adapter) throw new Error('Missing test adapter')
    return adapter
  })
}))

const accessMocks = vi.hoisted(() => ({
  cleanupAccount: vi.fn<(userId: string) => Promise<void>>(async () => undefined)
}))

const sessionOwnerMocks = vi.hoisted(() => ({
  owner: null as (() => HhcSession | null) | null,
  unregister: vi.fn(),
  register: vi.fn((owner: () => HhcSession | null) => {
    sessionOwnerMocks.owner = owner
    return () => {
      if (sessionOwnerMocks.owner === owner) sessionOwnerMocks.owner = null
      sessionOwnerMocks.unregister()
    }
  })
}))

vi.mock('@renderer/lib/hhc-auth', () => ({
  createHhcAuthAdapter: authFactory.create,
  registerHhcSessionOwner: sessionOwnerMocks.register
}))

vi.mock('@renderer/lib/hhc-line-access', () => ({
  cleanupHhcLineAccountAccess: accessMocks.cleanupAccount
}))

const SESSION: HhcSession = {
  userId: 'user-1',
  displayName: 'Ada Lovelace',
  roles: ['media_sync_user']
}

type TestAdapter = HhcAuthAdapter & {
  emit(session: HhcSession | null): void
  unsubscribe: ReturnType<typeof vi.fn>
}

function createAdapter(session: HhcSession | null | Error = null): TestAdapter {
  let listener: ((next: HhcSession | null) => void) | null = null
  const unsubscribe = vi.fn(() => {
    listener = null
  })
  return {
    getSession: vi.fn(async () => {
      if (session instanceof Error) throw session
      return session
    }),
    signIn: vi.fn(async () => ({ expiresAt: Date.now() + 300_000 })),
    cancelSignIn: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async () => 'access-token'),
    refreshAfterUnauthorized: vi.fn(async () => 'refreshed-access-token'),
    signOut: vi.fn(async () => undefined),
    subscribe: vi.fn((nextListener) => {
      listener = nextListener
      return unsubscribe
    }),
    dispose: vi.fn(),
    emit(next) {
      listener?.(next)
    },
    unsubscribe
  }
}

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <HhcAuthProvider>{children}</HhcAuthProvider>
}

it('retries an offline bootstrap online and preserves a later subscription session', async () => {
  const adapter = createAdapter(new Error('Offline'))
  authFactory.adapters.push(adapter)
  const { result } = renderHook(() => useHhcAuth(), { wrapper })
  await waitFor(() => expect(result.current.status).toBe('unavailable'))
  vi.mocked(adapter.getSession).mockResolvedValue(SESSION)
  act(() => window.dispatchEvent(new Event('online')))
  await waitFor(() => expect(result.current.session).toEqual(SESSION))
  act(() => adapter.emit(null))
  await waitFor(() => expect(result.current.status).toBe('anonymous'))
  act(() => window.dispatchEvent(new Event('focus')))
  expect(adapter.getSession).toHaveBeenCalledTimes(2)
})

beforeEach(() => {
  authFactory.adapters = []
  authFactory.create.mockClear()
  accessMocks.cleanupAccount.mockReset()
  accessMocks.cleanupAccount.mockResolvedValue(undefined)
  sessionOwnerMocks.register.mockClear()
  sessionOwnerMocks.unregister.mockClear()
  sessionOwnerMocks.owner = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { hhcAssets: { clearContentLeases: vi.fn(async () => undefined) } }
  })
})

describe('HhcAuthContext', () => {
  it.each([
    ['authenticated', SESSION, 'authenticated'],
    ['anonymous', null, 'anonymous']
  ] as const)('bootstraps an %s session', async (_name, session, status) => {
    authFactory.adapters.push(createAdapter(session))
    const { result } = renderHook(() => useHhcAuth(), { wrapper })

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe(status))
    expect(result.current.session).toEqual(session)
  })

  it('attempts passive browser sign-in after an anonymous bootstrap', async () => {
    const adapter = Object.assign(createAdapter(null), {
      attemptPassiveSignIn: vi.fn(async () => true)
    })
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('anonymous'))
    expect(adapter.attemptPassiveSignIn).toHaveBeenCalledOnce()
  })

  it('revalidates browser sessions when the page regains focus', async () => {
    const adapter = Object.assign(createAdapter(null), { revalidateOnPageActivity: true })
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('anonymous'))
    vi.mocked(adapter.getSession).mockResolvedValue(SESSION)

    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(result.current.session).toEqual(SESSION))
    expect(adapter.getSession).toHaveBeenCalledTimes(2)
  })

  it('does not revalidate Electron sessions on page activity', async () => {
    const adapter = createAdapter(null)
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('anonymous'))

    act(() => window.dispatchEvent(new Event('focus')))

    expect(adapter.getSession).toHaveBeenCalledOnce()
  })

  it('retries an unavailable Electron bootstrap when the window regains focus', async () => {
    const adapter = createAdapter(new Error('Offline'))
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    vi.mocked(adapter.getSession).mockResolvedValue(SESSION)

    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(result.current.session).toEqual(SESSION))
    expect(adapter.getSession).toHaveBeenCalledTimes(2)
  })

  it('preserves a browser session across a transient revalidation failure', async () => {
    const adapter = Object.assign(createAdapter(SESSION), { revalidateOnPageActivity: true })
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    vi.mocked(adapter.getSession).mockRejectedValueOnce(new Error('Offline'))

    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(adapter.getSession).toHaveBeenCalledTimes(2))

    expect(result.current.status).toBe('authenticated')
    expect(result.current.session).toEqual(SESSION)

    vi.mocked(adapter.getSession).mockResolvedValueOnce({ ...SESSION, userId: 'user-2' })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(accessMocks.cleanupAccount).toHaveBeenCalledWith('user-1'))
    await waitFor(() => expect(result.current.session?.userId).toBe('user-2'))
  })

  it('becomes unavailable without mutating local or OneDrive folders when bootstrap fails', async () => {
    const folders = {
      local: {
        id: 'local',
        name: 'Local',
        parentId: null,
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null
      },
      onedrive: {
        id: 'onedrive',
        name: 'OneDrive',
        parentId: null,
        sortIndex: 1,
        createdAt: 1,
        expiresAt: null,
        syncLink: {
          providerConnectionId: 'connection-1',
          remoteFolderId: 'remote-1',
          providerType: 'onedrive' as const
        }
      }
    }
    useFileExplorerStore.setState({ folders })
    authFactory.adapters.push(createAdapter(new Error('Account unavailable')))
    const { result } = renderHook(() => useHhcAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.session).toBeNull()
    expect(useFileExplorerStore.getState().folders).toEqual(folders)
  })

  it('updates from subscriptions and forwards sign-in and sign-out', async () => {
    const adapter = createAdapter(null)
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('anonymous'))

    await act(() => result.current.signIn())
    expect(adapter.signIn).toHaveBeenCalledOnce()

    act(() => adapter.emit(SESSION))
    expect(result.current.status).toBe('authenticated')
    expect(result.current.session).toEqual(SESSION)
    expect(sessionOwnerMocks.owner?.()).toEqual(SESSION)

    await act(() => result.current.signOut())
    expect(adapter.signOut).toHaveBeenCalledOnce()
    expect(sessionOwnerMocks.owner?.()).toBeNull()
    act(() => adapter.emit(null))
    await waitFor(() => expect(result.current.status).toBe('anonymous'))
  })

  it('reports pending sign-in metadata and explicit cancellation', async () => {
    const adapter = createAdapter(null)
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('anonymous'))

    await act(() => result.current.signIn())
    expect(result.current.signInStatus).toBe('pending')
    expect(result.current.pendingSignInExpiresAt).toBeGreaterThan(Date.now())

    await act(() => result.current.cancelSignIn())
    expect(adapter.cancelSignIn).toHaveBeenCalledOnce()
    expect(result.current.signInStatus).toBe('cancelled')
    expect(result.current.pendingSignInExpiresAt).toBeNull()
  })

  it('expires pending sign-in and ignores its late begin result after cancellation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const adapter = createAdapter(null)
      let rejectSignIn!: (reason: Error) => void
      vi.mocked(adapter.signIn).mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectSignIn = reject
        })
      )
      authFactory.adapters.push(adapter)
      const { result } = renderHook(() => useHhcAuth(), { wrapper })
      await act(async () => Promise.resolve())
      expect(result.current.status).toBe('anonymous')

      const signingIn = result.current.signIn()
      await act(async () => Promise.resolve())
      expect(result.current.signInStatus).toBe('pending')
      expect(result.current.pendingSignInExpiresAt).toBeNull()

      await act(() => result.current.cancelSignIn())
      rejectSignIn(new Error('late openExternal failure'))
      await expect(signingIn).resolves.toBeUndefined()
      expect(result.current.signInStatus).toBe('cancelled')

      vi.mocked(adapter.signIn).mockResolvedValueOnce({
        expiresAt: 301_000
      })
      await act(() => result.current.signIn())
      await act(async () => vi.advanceTimersByTimeAsync(300_000))
      expect(result.current.signInStatus).toBe('expired')
      expect(adapter.cancelSignIn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps account B unusable until departing account A cleanup completes', async () => {
    const adapter = createAdapter(SESSION)
    let resolveCleanup!: () => void
    accessMocks.cleanupAccount.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
    )
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    act(() => adapter.emit({ ...SESSION, userId: 'user-2', displayName: 'Grace' }))

    await waitFor(() => expect(accessMocks.cleanupAccount).toHaveBeenCalledWith('user-1'))
    expect(window.api.hhcAssets.clearContentLeases).toHaveBeenCalledOnce()
    expect(result.current.status).toBe('loading')
    expect(result.current.session).toBeNull()
    expect(sessionOwnerMocks.owner?.()).toBeNull()
    await expect(result.current.getAccessToken()).resolves.toBeNull()

    await act(async () => resolveCleanup())
    await waitFor(() => expect(result.current.session?.userId).toBe('user-2'))
    expect(result.current.status).toBe('authenticated')
    expect(sessionOwnerMocks.owner?.()?.userId).toBe('user-2')
  })

  it('keeps account B blocked and retries a failed departing-account cleanup', async () => {
    const adapter = createAdapter(SESSION)
    let resolveRetry!: () => void
    accessMocks.cleanupAccount
      .mockRejectedValueOnce(new Error('temporary cleanup failure'))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveRetry = resolve
        })
      )
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    const accountB = { ...SESSION, userId: 'user-2', displayName: 'Grace' }

    act(() => adapter.emit(accountB))
    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.session).toBeNull()

    act(() => adapter.emit(accountB))
    await waitFor(() => expect(accessMocks.cleanupAccount).toHaveBeenCalledTimes(2))
    expect(result.current.session).toBeNull()

    await act(async () => resolveRetry())
    await waitFor(() => expect(result.current.session?.userId).toBe('user-2'))
  })

  it('captures the departing account and waits for cleanup before sign-out completes', async () => {
    const adapter = createAdapter(SESSION)
    let resolveCleanup!: () => void
    accessMocks.cleanupAccount.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
    )
    vi.mocked(adapter.signOut).mockImplementationOnce(async () => adapter.emit(null))
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    let completed = false
    const signingOut = act(() => result.current.signOut()).then(() => {
      completed = true
    })
    await waitFor(() => expect(accessMocks.cleanupAccount).toHaveBeenCalledWith('user-1'))
    expect(window.api.hhcAssets.clearContentLeases).toHaveBeenCalledOnce()
    expect(completed).toBe(false)

    resolveCleanup()
    await signingOut
    await waitFor(() => expect(result.current.status).toBe('anonymous'))
  })

  it('uses the same terminal session transition for API auth-required', async () => {
    const adapter = createAdapter(SESSION)
    vi.mocked(adapter.signOut).mockImplementationOnce(async () => adapter.emit(null))
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    await act(() => result.current.endSession())

    expect(adapter.signOut).toHaveBeenCalledOnce()
    expect(accessMocks.cleanupAccount).toHaveBeenCalledWith('user-1')
    expect(result.current.status).toBe('anonymous')
  })

  it('advances the runtime generation for re-auth and identity changes, not same-user updates', async () => {
    const adapter = createAdapter(SESSION)
    vi.mocked(adapter.signIn).mockImplementationOnce(async () => {
      adapter.emit(SESSION)
      return { expiresAt: Date.now() + 300_000 }
    })
    vi.mocked(adapter.signOut).mockImplementationOnce(async () => adapter.emit(null))
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    const initialGeneration = result.current.getAuthGeneration()

    act(() => adapter.emit({ ...SESSION, roles: ['media_sync_user', 'reader'] }))
    expect(result.current.getAuthGeneration()).toBe(initialGeneration)

    await act(() => result.current.signIn())
    expect(result.current.getAuthGeneration()).toBe(initialGeneration + 1)

    act(() => adapter.emit({ ...SESSION, userId: 'user-2' }))
    expect(result.current.getAuthGeneration()).toBe(initialGeneration + 2)

    await act(() => result.current.signOut())
    expect(result.current.getAuthGeneration()).toBe(initialGeneration + 3)
  })

  it('advances the runtime generation once when explicit sign-in emits an identity', async () => {
    const adapter = createAdapter(null)
    vi.mocked(adapter.signIn).mockImplementationOnce(async () => {
      adapter.emit(SESSION)
      return { expiresAt: Date.now() + 300_000 }
    })
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('anonymous'))
    act(() => adapter.emit(null))
    const initialGeneration = result.current.getAuthGeneration()

    await act(() => result.current.signIn())

    expect(result.current.getAuthGeneration()).toBe(initialGeneration + 1)
  })

  it('keeps a newer subscription session when bootstrap finishes late', async () => {
    const adapter = createAdapter(null)
    let resolveSession: (session: HhcSession | null) => void = () => undefined
    vi.mocked(adapter.getSession).mockReturnValue(
      new Promise<HhcSession | null>((resolve) => {
        resolveSession = resolve
      })
    )
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(adapter.subscribe).toHaveBeenCalledOnce())

    act(() => adapter.emit(SESSION))
    expect(result.current.status).toBe('authenticated')

    await act(async () => resolveSession(null))
    expect(result.current.status).toBe('authenticated')
    expect(result.current.session).toEqual(SESSION)
  })

  it('coalesces concurrent access-token requests', async () => {
    const adapter = createAdapter(SESSION)
    let resolveToken: (token: string) => void = () => undefined
    vi.mocked(adapter.getAccessToken).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve
      })
    )
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    const first = result.current.getAccessToken()
    const second = result.current.getAccessToken()
    expect(first).toBe(second)
    expect(adapter.getAccessToken).toHaveBeenCalledOnce()

    resolveToken('shared-token')
    await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token'])
  })

  it('keeps same-user token requests live and single-flight across role notifications', async () => {
    const adapter = createAdapter(SESSION)
    let resolveToken: (token: string) => void = () => undefined
    let resolveRefresh: (token: string) => void = () => undefined
    vi.mocked(adapter.getAccessToken).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve
      })
    )
    vi.mocked(adapter.refreshAfterUnauthorized).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve
      })
    )
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    const token = result.current.getAccessToken()
    const refresh = result.current.refreshAfterUnauthorized('rejected-token')
    act(() => adapter.emit({ ...SESSION, roles: ['media_sync_user', 'reader'] }))
    const sameToken = result.current.getAccessToken()
    const sameRefresh = result.current.refreshAfterUnauthorized('rejected-token')

    expect(sameToken).toBe(token)
    expect(sameRefresh).toBe(refresh)
    expect(adapter.getAccessToken).toHaveBeenCalledOnce()
    expect(adapter.refreshAfterUnauthorized).toHaveBeenCalledOnce()
    resolveToken('same-user-token')
    resolveRefresh('same-user-refresh')
    await expect(Promise.all([token, sameToken])).resolves.toEqual([
      'same-user-token',
      'same-user-token'
    ])
    await expect(Promise.all([refresh, sameRefresh])).resolves.toEqual([
      'same-user-refresh',
      'same-user-refresh'
    ])
  })

  it('fences token requests as soon as sign-out starts before an auth notification', async () => {
    const adapter = createAdapter(SESSION)
    let resolveToken: (token: string) => void = () => undefined
    let resolveRefresh: (token: string) => void = () => undefined
    let resolveSignOut: () => void = () => undefined
    vi.mocked(adapter.getAccessToken).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve
      })
    )
    vi.mocked(adapter.refreshAfterUnauthorized).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve
      })
    )
    vi.mocked(adapter.signOut).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSignOut = resolve
      })
    )
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    const token = result.current.getAccessToken()
    const refresh = result.current.refreshAfterUnauthorized('rejected-token')
    const signingOut = result.current.signOut()
    act(() => adapter.emit({ ...SESSION, roles: ['media_sync_user', 'reader'] }))
    resolveToken('stale-token')
    resolveRefresh('stale-refresh')

    await expect(Promise.all([token, refresh])).resolves.toEqual([null, null])
    await expect(result.current.getAccessToken()).resolves.toBeNull()
    await expect(result.current.refreshAfterUnauthorized('rejected-token')).resolves.toBeNull()
    resolveSignOut()
    await signingOut
  })

  it('accepts the authenticated identity emitted during sign-in', async () => {
    const adapter = createAdapter(null)
    vi.mocked(adapter.signIn).mockImplementationOnce(async () => {
      adapter.emit(SESSION)
      return { expiresAt: Date.now() + 300_000 }
    })
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('anonymous'))

    await act(() => result.current.signIn())

    expect(result.current.session).toEqual(SESSION)
    await expect(result.current.getAccessToken()).resolves.toBe('access-token')
  })

  it('fences in-flight token results when the provider unmounts', async () => {
    const adapter = createAdapter(SESSION)
    let resolveToken: (token: string) => void = () => undefined
    let resolveRefresh: (token: string) => void = () => undefined
    vi.mocked(adapter.getAccessToken).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve
      })
    )
    vi.mocked(adapter.refreshAfterUnauthorized).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve
      })
    )
    authFactory.adapters.push(adapter)
    const { result, unmount } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    const token = result.current.getAccessToken()
    const refresh = result.current.refreshAfterUnauthorized('rejected-token')
    unmount()
    resolveToken('stale-token')
    resolveRefresh('stale-refresh')

    await expect(Promise.all([token, refresh])).resolves.toEqual([null, null])
  })

  it('discards an access token completed after the session changes', async () => {
    const adapter = createAdapter(SESSION)
    let resolveToken: (token: string) => void = () => undefined
    vi.mocked(adapter.getAccessToken).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve
      })
    )
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    const token = result.current.getAccessToken()
    act(() => adapter.emit({ ...SESSION, userId: 'user-2' }))
    resolveToken('stale-token')

    await expect(token).resolves.toBeNull()
  })

  it('coalesces concurrent refreshes and discards tokens after logout or account switch', async () => {
    const adapter = createAdapter(SESSION)
    let resolveRefresh: (token: string) => void = () => undefined
    vi.mocked(adapter.refreshAfterUnauthorized).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve
      })
    )
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    const first = result.current.refreshAfterUnauthorized('rejected-token')
    const second = result.current.refreshAfterUnauthorized('rejected-token')
    expect(first).toBe(second)
    expect(adapter.refreshAfterUnauthorized).toHaveBeenCalledOnce()

    act(() => adapter.emit(null))
    resolveRefresh('stale-token')
    await expect(Promise.all([first, second])).resolves.toEqual([null, null])

    let resolveSwitchedRefresh: (token: string) => void = () => undefined
    vi.mocked(adapter.refreshAfterUnauthorized).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveSwitchedRefresh = resolve
      })
    )
    act(() => adapter.emit(SESSION))
    const switched = result.current.refreshAfterUnauthorized('rejected-token')
    act(() => adapter.emit({ ...SESSION, userId: 'user-2' }))
    resolveSwitchedRefresh('other-stale-token')
    await expect(switched).resolves.toBeNull()
  })

  it('shares one context refresh across concurrent Asset 401 retries', async () => {
    const adapter = createAdapter(SESSION)
    let resolveRefresh: (token: string) => void = () => undefined
    vi.mocked(adapter.refreshAfterUnauthorized).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve
      })
    )
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const token = new Headers(init?.headers).get('authorization')
      return token === 'Bearer refreshed-access-token'
        ? new Response(JSON.stringify({ collections: [], hasMore: false }))
        : new Response('{}', { status: 401 })
    })
    authFactory.adapters.push(adapter)
    const { result } = renderHook(() => useHhcAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    const api = createBrowserHhcAssetApi({
      getAccessToken: result.current.getAccessToken,
      refreshAfterUnauthorized: result.current.refreshAfterUnauthorized,
      fetcher
    })

    const requests = [api.listCollections(), api.listCollections()]
    await waitFor(() => expect(adapter.refreshAfterUnauthorized).toHaveBeenCalledOnce())
    resolveRefresh('refreshed-access-token')

    await expect(Promise.all(requests)).resolves.toEqual([
      { collections: [], hasMore: false },
      { collections: [], hasMore: false }
    ])
    expect(adapter.refreshAfterUnauthorized).toHaveBeenCalledOnce()
  })

  it('unsubscribes every subscription and disposes every adapter under StrictMode', async () => {
    const first = createAdapter(null)
    const second = createAdapter(null)
    authFactory.adapters.push(first, second)
    const Probe = (): React.JSX.Element => <div>{useHhcAuth().status}</div>
    const { getByText, unmount } = render(
      <StrictMode>
        <HhcAuthProvider>
          <Probe />
        </HhcAuthProvider>
      </StrictMode>
    )
    await waitFor(() => expect(getByText('anonymous')).toBeInTheDocument())

    unmount()

    expect(authFactory.create).toHaveBeenCalledTimes(2)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(first.cancelSignIn).not.toHaveBeenCalled()
    expect(second.cancelSignIn).not.toHaveBeenCalled()
    expect(first.unsubscribe).toHaveBeenCalledTimes(vi.mocked(first.subscribe).mock.calls.length)
    expect(second.unsubscribe).toHaveBeenCalledTimes(vi.mocked(second.subscribe).mock.calls.length)
    expect(sessionOwnerMocks.register).toHaveBeenCalledTimes(2)
    expect(sessionOwnerMocks.unregister).toHaveBeenCalledTimes(2)
  })
})
