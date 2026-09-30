import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserHhcAuthAdapter } from '../hhc-auth-browser'
import {
  createBrowserAccountAuthRuntime,
  createOAuthTransaction,
  saveOAuthTransaction
} from '@hallelujahhomechurch/account-client'
import { HHC_AUTH } from '../hhc-auth'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function session(permissionAvailability: object = { status: 'available' }): Response {
  return response({
    authenticated: true,
    user: { id: 'user-1', email: 'ada@example.test', display_name: 'Ada', avatar_url: null },
    permissions: [],
    permission_availability: permissionAvailability
  })
}

describe('browser HHC auth', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('revalidates after OAuth exchange when startup still has an anonymous result in flight', async () => {
    let finishInitial!: (value: { authenticated: false }) => void
    const initial = new Promise<{ authenticated: false }>((resolve) => {
      finishInitial = resolve
    })
    const authenticated = await session().json()
    const getSession = vi
      .fn()
      .mockImplementationOnce(() => initial)
      .mockResolvedValue(authenticated)
    const transaction = await createOAuthTransaction('/', {
      randomBytes: () => new Uint8Array(32).fill(7),
      now: () => 1_000
    })
    saveOAuthTransaction(transaction, {
      storage: sessionStorage,
      storageKey: `hhc:oauth:${HHC_AUTH.clientId}`
    })
    vi.stubGlobal('location', {
      href: `${HHC_AUTH.callbackUri}?code=code-1&state=${transaction.state}`
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ access_token: 'token-1', expires_in: 900 }))
    )
    const runtime = createBrowserAccountAuthRuntime({
      client: {
        getSession,
        issueAccessToken: async () => ({ accessToken: 'token-1', expiresIn: 900 }),
        refreshAccessToken: async () => ({ accessToken: 'token-2', expiresIn: 900 }),
        logout: async () => undefined,
        logoutAll: async () => undefined
      },
      now: () => 1_000,
      storage: sessionStorage,
      oauth: {
        authorizeBaseUrl: HHC_AUTH.accountApi,
        clientId: HHC_AUTH.clientId,
        redirectUri: HHC_AUTH.callbackUri,
        scope: HHC_AUTH.scope
      }
    })
    try {
      const startup = runtime.start()
      const callback = runtime.completeSignIn()
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      finishInitial({ authenticated: false })
      await expect(startup).resolves.toMatchObject({ status: 'anonymous' })
      await expect(callback).resolves.toMatchObject({ status: 'authenticated' })
      expect(getSession).toHaveBeenCalledTimes(2)
    } finally {
      runtime.dispose()
    }
  })

  it('keeps an empty permission list authenticated', async () => {
    const adapter = createBrowserHhcAuthAdapter({ fetcher: vi.fn(async () => session()) })

    await expect(adapter.getSession()).resolves.toEqual({
      userId: 'user-1',
      displayName: 'Ada',
      roles: [],
      permissions: [],
      permissionAvailability: { status: 'available' }
    })
    adapter.dispose()
  })

  it('keeps identity authenticated when permissions are unavailable', async () => {
    const adapter = createBrowserHhcAuthAdapter({
      fetcher: vi.fn(async () =>
        session({ status: 'unavailable', code: 'permission_unavailable', request_id: 'req-1' })
      )
    })

    await expect(adapter.getSession()).resolves.toMatchObject({
      userId: 'user-1',
      permissions: [],
      permissionAvailability: { status: 'unavailable' }
    })
    adapter.dispose()
  })

  it('delegates access-token refresh to the shared runtime', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) return session()
      if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf' })
      if (url.endsWith('/session/access-token'))
        return response({ access_token: 'token-1', expires_in: 900 })
      if (url.endsWith('/refresh')) return response({ access_token: 'token-2', expires_in: 900 })
      throw new Error(`Unexpected URL: ${url}`)
    })
    const adapter = createBrowserHhcAuthAdapter({ fetcher })

    await adapter.getSession()
    await expect(adapter.getAccessToken()).resolves.toBe('token-1')
    await expect(adapter.refreshAfterUnauthorized('token-1')).resolves.toBe('token-2')
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/refresh'))).toHaveLength(1)
    adapter.dispose()
  })
})
