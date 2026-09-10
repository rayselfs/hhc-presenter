import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserHhcAuthAdapter,
  completeBrowserRedirectSignIn,
  createBrowserHhcAuthAdapter,
  createPkceChallenge,
  HHC_AUTH_REDIRECT_TRANSACTION_KEY
} from '../hhc-auth-browser'

const ACCOUNT_ORIGIN = 'https://account.alive.org.tw'
const CLIENT_ORIGIN = 'https://client.alive.org.tw'
const broadcastChannels: MockBroadcastChannel[] = []

class MockBroadcastChannel extends EventTarget {
  readonly close = vi.fn()
  readonly postMessage = vi.fn()

  constructor(readonly name: string) {
    super()
    broadcastChannels.push(this)
  }
}

function jwt(claims: object): string {
  return `header.${btoa(JSON.stringify(claims)).replaceAll('=', '')}.signature`
}

function response(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function popup(): Window {
  return {
    closed: false,
    close: vi.fn(),
    focus: vi.fn(),
    postMessage: vi.fn(),
    location: { href: '' }
  } as unknown as Window
}

function createAdapter(
  options: {
    fetcher?: typeof fetch
    now?: () => number
    open?: ReturnType<typeof vi.fn>
    accountOrigin?: string
  } = {}
): {
  adapter: BrowserHhcAuthAdapter
  assign: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  target: Window
} {
  const open = options.open ?? vi.fn(() => popup())
  const assign = vi.fn()
  const target = new EventTarget() as Window
  Object.assign(target, {
    location: { href: `${CLIENT_ORIGIN}/#/files`, origin: CLIENT_ORIGIN, assign },
    open
  })

  return {
    adapter: createBrowserHhcAuthAdapter({
      accountOrigin: options.accountOrigin ?? ACCOUNT_ORIGIN,
      fetcher: options.fetcher ?? vi.fn(),
      now: options.now ?? (() => 1_000),
      window: target
    }),
    assign,
    open,
    target
  }
}

describe('browser HHC auth', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    broadcastChannels.length = 0
    sessionStorage.clear()
    document.cookie = 'hhc_sso_hint=; Max-Age=0; Path=/'
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([undefined, null, ['*', true]])(
    'rejects missing or malformed permissions despite the legacy flag: %j',
    async (permissions) => {
      const { adapter } = createAdapter({
        fetcher: async () =>
          response({
            authenticated: true,
            user: {
              id: 'user-1',
              display_name: 'Ada',
              presenter_cloud_access: true,
              permissions
            }
          })
      })
      await expect(adapter.getSession()).rejects.toThrow('Invalid HHC account permissions')
      adapter.dispose()
    }
  )

  it('maps permissions without using the legacy cloud flag', async () => {
    const { adapter } = createAdapter({
      fetcher: async () =>
        response({
          authenticated: true,
          user: {
            id: 'user-1',
            display_name: 'Ada',
            presenter_cloud_access: false,
            permissions: ['presenter:cloud:use']
          }
        })
    })
    await expect(adapter.getSession()).resolves.toMatchObject({
      permissions: ['presenter:cloud:use']
    })
    adapter.dispose()
  })

  it('does not cache a token whose permission refresh fails', async () => {
    let permissions: unknown = []
    let issued = 0
    const token = jwt({ sub: 'user-1', roles: [], exp: 9_999_999_999 })
    const { adapter } = createAdapter({
      accountOrigin: 'https://permission-failure.example',
      fetcher: async (input) => {
        const url = String(input)
        if (url.endsWith('/session'))
          return response({
            authenticated: true,
            user: { id: 'user-1', display_name: 'Ada', permissions }
          })
        if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf' })
        issued += 1
        return response({ access_token: token })
      }
    })
    await adapter.getSession()
    permissions = null
    await expect(adapter.refreshAccessToken()).rejects.toThrow('Invalid HHC account permissions')
    await expect(adapter.getAccessToken()).rejects.toThrow('Invalid HHC account permissions')
    expect(issued).toBe(2)
    adapter.dispose()
  })

  it('creates an S256 PKCE challenge', async () => {
    await expect(createPkceChallenge('abc')).resolves.toBe(
      'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0'
    )
  })

  it('calls the default native fetch with the Window receiver', async () => {
    const nativeFetch = vi.fn(function (this: unknown): Promise<Response> {
      if (this !== window) throw new TypeError('Illegal invocation')
      return Promise.resolve(response({ authenticated: false }))
    })
    vi.stubGlobal('fetch', nativeFetch)
    const adapter = createBrowserHhcAuthAdapter({ accountOrigin: ACCOUNT_ORIGIN })

    try {
      await expect(adapter.getSession()).resolves.toBeNull()
      expect(nativeFetch).toHaveBeenCalledOnce()
    } finally {
      adapter.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('opens a blank popup synchronously and navigates it to the exact authorization URL', async () => {
    const { adapter, open } = createAdapter()

    await expect(adapter.signIn()).resolves.toEqual({
      expiresAt: 301_000
    })

    expect(open).toHaveBeenCalledWith('', 'hhc-account-auth', 'popup,width=520,height=720')
    const opened = open.mock.results[0]?.value as Window
    const url = new URL(String(opened.location.href))
    expect(url.origin).toBe(ACCOUNT_ORIGIN)
    expect(url.pathname).toBe('/api/account/v1/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client-web',
      redirect_uri: `${CLIENT_ORIGIN}/oauth/callback`,
      response_type: 'code',
      scope: 'openid profile presenter:cloud:manage',
      code_challenge_method: 'S256'
    })
    expect(url.searchParams.get('state')).toHaveLength(43)
    expect(url.searchParams.get('code_challenge')).toHaveLength(43)
  })

  it('redirects once with prompt=none when the shared SSO hint exists', async () => {
    document.cookie = 'hhc_sso_hint=1; Path=/'
    const { adapter, assign } = createAdapter()

    await expect(adapter.attemptPassiveSignIn()).resolves.toBe(true)
    await expect(adapter.attemptPassiveSignIn()).resolves.toBe(false)

    expect(assign).toHaveBeenCalledOnce()
    const url = new URL(String(assign.mock.calls[0]?.[0]))
    expect(url.origin).toBe(ACCOUNT_ORIGIN)
    expect(url.pathname).toBe('/api/account/v1/oauth/authorize')
    expect(url.searchParams.get('prompt')).toBe('none')
    expect(url.searchParams.get('client_id')).toBe('client-web')
    expect(sessionStorage.length).toBe(2)
  })

  it('exchanges a stored passive callback and restores its same-origin route', async () => {
    const replace = vi.fn()
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({
        grant_type: 'authorization_code',
        client_id: 'client-web',
        redirect_uri: `${CLIENT_ORIGIN}/oauth/callback`,
        code_verifier: 'verifier-1',
        code: 'code-1'
      })
      return response({ access_token: 'access-token' })
    })
    sessionStorage.setItem(
      HHC_AUTH_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        state: 'state-1',
        codeVerifier: 'verifier-1',
        expiresAt: 2_000,
        returnRoute: `${CLIENT_ORIGIN}/#/files`
      })
    )

    await expect(
      completeBrowserRedirectSignIn(
        { code: 'code-1', state: 'state-1' },
        {
          fetcher,
          now: () => 1_000,
          storage: sessionStorage,
          location: { origin: CLIENT_ORIGIN, replace }
        }
      )
    ).resolves.toBe(true)

    expect(fetcher).toHaveBeenCalledWith(
      `${ACCOUNT_ORIGIN}/api/account/v1/oauth/token`,
      expect.anything()
    )
    expect(replace).toHaveBeenCalledWith(`${CLIENT_ORIGIN}/#/files`)
    expect(sessionStorage.getItem(HHC_AUTH_REDIRECT_TRANSACTION_KEY)).toBeNull()
  })

  it('restores the route without a token exchange when passive sign-in is declined', async () => {
    const replace = vi.fn()
    const fetcher = vi.fn()
    sessionStorage.setItem(
      HHC_AUTH_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        state: 'state-1',
        codeVerifier: 'verifier-1',
        expiresAt: 2_000,
        returnRoute: `${CLIENT_ORIGIN}/#/files`
      })
    )

    await expect(
      completeBrowserRedirectSignIn(
        { error: 'login_required', state: 'state-1' },
        {
          fetcher,
          now: () => 1_000,
          storage: sessionStorage,
          location: { origin: CLIENT_ORIGIN, replace }
        }
      )
    ).resolves.toBe(true)

    expect(fetcher).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith(`${CLIENT_ORIGIN}/#/files`)
  })

  it('rejects a passive callback return route outside Presenter Web', async () => {
    const replace = vi.fn()
    const fetcher = vi.fn()
    sessionStorage.setItem(
      HHC_AUTH_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        state: 'state-1',
        codeVerifier: 'verifier-1',
        expiresAt: 2_000,
        returnRoute: 'https://attacker.example/steal'
      })
    )

    await expect(
      completeBrowserRedirectSignIn(
        { code: 'code-1', state: 'state-1' },
        {
          fetcher,
          now: () => 1_000,
          storage: sessionStorage,
          location: { origin: CLIENT_ORIGIN, replace }
        }
      )
    ).rejects.toThrow('Invalid HHC redirect transaction')
    expect(fetcher).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('fails explicitly when the sign-in popup is blocked', async () => {
    const { adapter } = createAdapter({ open: vi.fn(() => null) })
    await expect(adapter.signIn()).rejects.toThrow('Sign-in popup was blocked')
  })

  it('replaces an active popup and rejects the abandoned callback', async () => {
    const { adapter, open } = createAdapter()
    await adapter.signIn()
    const abandoned = open.mock.results[0]?.value as Window
    const abandonedState = new URL(String(abandoned.location.href)).searchParams.get('state')!
    await adapter.signIn()
    const replacement = open.mock.results[1]?.value as Window
    const replacementState = new URL(String(replacement.location.href)).searchParams.get('state')!

    expect(open).toHaveBeenCalledTimes(2)
    expect(abandoned.close).toHaveBeenCalledOnce()
    expect(replacementState).not.toBe(abandonedState)
  })

  it('cancels the owned popup and ignores its late message', async () => {
    const fetcher = vi.fn()
    const { adapter, open, target } = createAdapter({ fetcher })
    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    const state = new URL(String(opened.location.href)).searchParams.get('state')!

    await adapter.cancelSignIn()
    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: opened,
        data: { code: 'late-code', state }
      })
    )
    await Promise.resolve()

    expect(opened.close).toHaveBeenCalledOnce()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('closes and invalidates an expired popup transaction', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn()
      let now = 1_000
      const { adapter, open, target } = createAdapter({ fetcher, now: () => now })
      await adapter.signIn()
      const opened = open.mock.results[0]?.value as Window
      const state = new URL(String(opened.location.href)).searchParams.get('state')!

      now += 300_000
      await vi.advanceTimersByTimeAsync(300_000)
      target.dispatchEvent(
        new MessageEvent('message', {
          origin: CLIENT_ORIGIN,
          source: opened,
          data: { code: 'late-code', state }
        })
      )
      await Promise.resolve()

      expect(opened.close).toHaveBeenCalledOnce()
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps token completion exclusive from replacement sign-in', async () => {
    let resolveToken!: (value: Response) => void
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/oauth/token')) {
        return new Promise<Response>((resolve) => {
          resolveToken = resolve
        })
      }
      if (String(input).endsWith('/session')) {
        return Promise.resolve(
          response({
            authenticated: true,
            user: { permissions: [], id: 'user-1', display_name: 'Ada' }
          })
        )
      }
      throw new Error(`Unexpected URL: ${String(input)}`)
    })
    const { adapter, open, target } = createAdapter({ fetcher })
    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    const state = new URL(String(opened.location.href)).searchParams.get('state')!
    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: opened,
        data: { code: 'code-1', state }
      })
    )
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())

    await expect(adapter.signIn()).rejects.toThrow('HHC sign-in is already in progress')

    resolveToken(
      response({
        access_token: jwt({ sub: 'user-1', roles: [], exp: 9_999_999_999 })
      })
    )
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })

  it('keeps sign-out exclusive from replacement sign-in', async () => {
    let resolveLogout!: (value: Response) => void
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/csrf-token')) {
        return Promise.resolve(response({ csrf_token: 'csrf-sign-out' }))
      }
      if (String(input).endsWith('/session/logout-all')) {
        return new Promise<Response>((resolve) => {
          resolveLogout = resolve
        })
      }
      throw new Error(`Unexpected URL: ${String(input)}`)
    })
    const { adapter } = createAdapter({ fetcher })
    const signingOut = adapter.signOut()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))

    await expect(adapter.signIn()).rejects.toThrow('HHC sign-in is already in progress')

    resolveLogout(response({}))
    await signingOut
  })

  it('ends the shared Account session when signing out of Presenter Web', async () => {
    const requests: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf-1' })
      if (url.endsWith('/session/logout-all')) return response({})
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({ fetcher })

    await expect(adapter.signOut()).resolves.toBeUndefined()
    expect(requests.at(-1)).toBe(`${ACCOUNT_ORIGIN}/api/account/v1/session/logout-all`)
  })

  it('waits for token completion before clearing the cookie session', async () => {
    const requests: string[] = []
    let resolveToken!: (value: Response) => void
    let resolveLogout!: (value: Response) => void
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        requests.push('token')
        return new Promise<Response>((resolve) => {
          resolveToken = resolve
        })
      }
      if (url.endsWith('/csrf-token')) {
        requests.push('csrf')
        return Promise.resolve(response({ csrf_token: 'csrf-after-completion' }))
      }
      if (url.endsWith('/session/logout-all')) {
        requests.push('logout')
        return new Promise<Response>((resolve) => {
          resolveLogout = resolve
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter, open, target } = createAdapter({ fetcher })
    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    const state = new URL(String(opened.location.href)).searchParams.get('state')!
    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: opened,
        data: { code: 'code-before-sign-out', state }
      })
    )
    await vi.waitFor(() => expect(requests).toEqual(['token']))

    const signingOut = adapter.signOut()
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toEqual(['token'])

    resolveToken(
      response({
        access_token: jwt({ sub: 'user-1', roles: [], exp: 9_999_999_999 })
      })
    )
    await vi.waitFor(() => expect(requests).toEqual(['token', 'csrf', 'logout']))
    resolveLogout(response({}))
    await signingOut
  })

  it('exchanges only an exact-origin, matching-popup, matching-state callback once', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/oauth/token')) {
        expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
        const body = new URLSearchParams(String(init?.body))
        expect(Object.fromEntries(body)).toMatchObject({
          grant_type: 'authorization_code',
          client_id: 'client-web',
          redirect_uri: `${CLIENT_ORIGIN}/oauth/callback`,
          code: 'code-1'
        })
        return response({
          access_token: jwt({ sub: 'user-1', roles: ['media_sync_user'], exp: 9_999_999_999 })
        })
      }
      if (String(input).endsWith('/session')) {
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada', avatar_url: 'https://avatar' }
        })
      }
      throw new Error(`Unexpected URL: ${String(input)}`)
    })
    const { adapter, open, target } = createAdapter({ fetcher })
    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    const state = new URL(String(opened.location.href)).searchParams.get('state')!

    target.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        source: opened,
        data: { code: 'code-1', state }
      })
    )
    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: popup(),
        data: { code: 'code-1', state }
      })
    )
    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: opened,
        data: { code: 'code-1', state: 'wrong' }
      })
    )
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()

    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: opened,
        data: { code: 'code-1', state }
      })
    )
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(opened.close).not.toHaveBeenCalled()
    expect(await adapter.getAccessToken()).toContain('.')
    expect(await adapter.getAccessToken()).not.toContain('refresh')
    expect(await adapter.getSession()).toEqual({
      userId: 'user-1',
      displayName: 'Ada',
      avatarUrl: 'https://avatar',
      roles: ['media_sync_user'],
      permissions: []
    })

    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: opened,
        data: { code: 'code-1', state }
      })
    )
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('exchanges a matching callback received without a popup opener', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/oauth/token')) {
        return response({
          access_token: jwt({ sub: 'user-1', roles: [], exp: 9_999_999_999 })
        })
      }
      if (String(input).endsWith('/session')) {
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      }
      throw new Error(`Unexpected URL: ${String(input)}`)
    })
    const { adapter, open } = createAdapter({ fetcher })
    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    const state = new URL(String(opened.location.href)).searchParams.get('state')!

    expect(broadcastChannels).toHaveLength(1)
    expect(broadcastChannels[0]?.name).toBe('hhc-auth-callback')
    broadcastChannels[0]?.dispatchEvent(
      new MessageEvent('message', { data: { code: 'broadcast-code', state } })
    )

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(broadcastChannels[0]?.postMessage).toHaveBeenCalledWith({
      state,
      status: 'complete'
    })
    expect(await adapter.getSession()).toMatchObject({ userId: 'user-1' })
    adapter.dispose()
    expect(broadcastChannels[0]?.close).toHaveBeenCalledOnce()
  })

  it('reports a failed callback exchange to the callback page', async () => {
    const fetcher = vi.fn(async () => response({ error: 'invalid code' }, 400))
    const { adapter, open } = createAdapter({ fetcher })
    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    const state = new URL(String(opened.location.href)).searchParams.get('state')!

    broadcastChannels[0]?.dispatchEvent(
      new MessageEvent('message', { data: { code: 'rejected-code', state } })
    )

    await vi.waitFor(() =>
      expect(broadcastChannels[0]?.postMessage).toHaveBeenCalledWith({
        state,
        status: 'failed'
      })
    )
    adapter.dispose()
  })

  it('rejects expired callbacks without exchanging', async () => {
    const fetcher = vi.fn()
    let now = 1_000
    const { adapter, open, target } = createAdapter({ fetcher, now: () => now })
    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    const state = new URL(String(opened.location.href)).searchParams.get('state')!
    now = 301_001
    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: opened,
        data: { code: 'code', state }
      })
    )
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('obtains a cookie-backed session access token through CSRF and never sends identity headers', async () => {
    const accessToken = jwt({ sub: 'user-1', roles: ['media_sync_user'], exp: 9_999_999_999 })
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/session'))
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      if (String(input).endsWith('/csrf-token')) return response({ csrf_token: 'csrf-1' })
      if (String(input).endsWith('/session/access-token'))
        return response({ access_token: accessToken })
      throw new Error(`Unexpected URL: ${String(input)}`)
    })
    const { adapter } = createAdapter({ fetcher, accountOrigin: 'https://coalesce.example' })

    await expect(adapter.getSession()).resolves.toEqual({
      userId: 'user-1',
      displayName: 'Ada',
      roles: [],
      permissions: []
    })
    await expect(adapter.getAccessToken()).resolves.toBe(accessToken)
    const csrf = fetcher.mock.calls.find(([url]) => String(url).endsWith('/csrf-token'))?.[1]
    const access = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith('/session/access-token')
    )?.[1]
    expect(csrf).toMatchObject({ credentials: 'include', cache: 'no-store' })
    expect(access).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(new Headers(access?.headers).get('x-csrf-token')).toBe('csrf-1')
    expect(new Headers(access?.headers).get('authorization')).toBeNull()
    expect(new Headers(access?.headers).get('x-hhc-roles')).toBeNull()
  })

  it('explicitly refreshes a still-valid cached access token', async () => {
    const firstToken = jwt({ sub: 'user-1', roles: ['media_sync_user'], exp: 9_999_999_999 })
    const secondToken = jwt({
      sub: 'user-1',
      roles: ['media_sync_user', 'reader'],
      exp: 9_999_999_999
    })
    let accessTokenRequests = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/session')) {
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      }
      if (String(input).endsWith('/csrf-token')) return response({ csrf_token: 'csrf-refresh' })
      if (String(input).endsWith('/session/access-token')) {
        accessTokenRequests += 1
        return response({ access_token: accessTokenRequests === 1 ? firstToken : secondToken })
      }
      throw new Error(`Unexpected URL: ${String(input)}`)
    })
    const { adapter } = createAdapter({ fetcher, accountOrigin: 'https://force-refresh.example' })

    await expect(adapter.getAccessToken()).resolves.toBe(firstToken)
    await expect(adapter.getAccessToken()).resolves.toBe(firstToken)
    await expect(adapter.refreshAccessToken()).resolves.toBe(secondToken)
    await expect(adapter.getSession()).resolves.toMatchObject({
      roles: ['media_sync_user', 'reader'],
      permissions: []
    })
    expect(accessTokenRequests).toBe(2)
  })

  it('coalesces CSRF calls and retries a rejected protected request once with a new token', async () => {
    let csrfRequests = 0
    let accessRequests = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session'))
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      if (url.endsWith('/csrf-token')) return response({ csrf_token: `csrf-${++csrfRequests}` })
      if (url.endsWith('/session/access-token')) {
        accessRequests++
        return accessRequests === 1
          ? response({ error_code: 'ACC_CSRF_TOKEN_INVALID' }, 403)
          : response({ access_token: jwt({ sub: 'user-1', roles: [], exp: 9_999_999_999 }) })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({ fetcher, accountOrigin: 'https://logout.example' })
    await adapter.getSession()
    await Promise.all([adapter.getAccessToken(), adapter.getAccessToken()])
    expect(csrfRequests).toBe(2)
    expect(accessRequests).toBe(3)
  })

  it('clears memory and calls CSRF-protected logout even when logout fails', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session'))
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf-1' })
      if (url.endsWith('/session/access-token'))
        return response({ access_token: jwt({ sub: 'user-1', roles: [], exp: 9_999_999_999 }) })
      if (url.endsWith('/session/logout-all')) return response({ error_code: 'ERR' }, 500)
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({ fetcher, accountOrigin: 'https://logout.example' })
    const sessions: unknown[] = []
    adapter.subscribe((session) => sessions.push(session))
    await adapter.getSession()
    await adapter.getAccessToken()
    await expect(adapter.signOut()).rejects.toThrow()
    expect(sessions.at(-1)).toBeNull()
  })

  it('keeps a signed-out adapter anonymous when an older session request finishes late', async () => {
    let resolveSession: (value: Response) => void = () => undefined
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) {
        return new Promise<Response>((resolve) => {
          resolveSession = resolve
        })
      }
      if (url.endsWith('/csrf-token'))
        return Promise.resolve(response({ csrf_token: 'csrf-fence' }))
      if (url.endsWith('/session/logout-all')) return Promise.resolve(response({}))
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({
      fetcher,
      accountOrigin: 'https://session-fence.example'
    })
    const sessions: Array<unknown> = []
    adapter.subscribe((session) => sessions.push(session))

    const staleSession = adapter.getSession()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await adapter.signOut()
    resolveSession(
      response({
        authenticated: true,
        user: { permissions: [], id: 'user-a', display_name: 'User A' }
      })
    )

    await expect(staleSession).resolves.toBeNull()
    expect(sessions.at(-1)).toBeNull()
  })

  it('accepts another account after an explicit sign-in but not from a post-logout session poll', async () => {
    let userId = 'user-a'
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) {
        return response({
          authenticated: true,
          user: { permissions: [], id: userId, display_name: userId }
        })
      }
      if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf-explicit-sign-in' })
      if (url.endsWith('/session/logout-all')) return response({})
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({
      fetcher,
      accountOrigin: 'https://explicit-sign-in.example'
    })
    await expect(adapter.getSession()).resolves.toMatchObject({ userId: 'user-a' })

    await adapter.signOut()
    await expect(adapter.getSession()).resolves.toBeNull()

    userId = 'user-b'
    await adapter.signIn()
    await expect(adapter.getSession()).resolves.toMatchObject({ userId: 'user-b' })
  })

  it.each(['getAccessToken', 'refreshAccessToken'] as const)(
    'does not let stale %s completion replace a newer account session',
    async (method) => {
      const staleToken = jwt({ sub: 'user-a', roles: ['reader'], exp: 9_999_999_999 })
      let sessionRequests = 0
      let resolveToken: (value: Response) => void = () => undefined
      const fetcher = vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/session')) {
          sessionRequests += 1
          const user = sessionRequests === 1 ? 'a' : 'b'
          return Promise.resolve(
            response({
              authenticated: true,
              user: {
                permissions: [],
                id: `user-${user}`,
                display_name: `User ${user.toUpperCase()}`
              }
            })
          )
        }
        if (url.endsWith('/csrf-token'))
          return Promise.resolve(response({ csrf_token: 'csrf-account-fence' }))
        if (url.endsWith('/session/access-token')) {
          return new Promise<Response>((resolve) => {
            resolveToken = resolve
          })
        }
        throw new Error(`Unexpected URL: ${url}`)
      })
      const { adapter } = createAdapter({
        fetcher,
        accountOrigin: `https://${method.toLowerCase()}.example`
      })
      const sessions: Array<unknown> = []
      adapter.subscribe((session) => sessions.push(session))
      await adapter.getSession()

      const staleRequest = adapter[method]()
      await vi.waitFor(() =>
        expect(
          fetcher.mock.calls.some(([url]) => String(url).endsWith('/session/access-token'))
        ).toBe(true)
      )
      await expect(adapter.getSession()).resolves.toMatchObject({ userId: 'user-b' })
      resolveToken(response({ access_token: staleToken }))

      await expect(staleRequest).resolves.toBeNull()
      expect(sessions.at(-1)).toMatchObject({ userId: 'user-b' })
    }
  )

  it('does not clear a newer session when an older sign-in exchange fails', async () => {
    let rejectExchange: (reason: Error) => void = () => undefined
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        return new Promise<Response>((_resolve, reject) => {
          rejectExchange = reject
        })
      }
      if (url.endsWith('/session')) {
        return Promise.resolve(
          response({
            authenticated: true,
            user: { permissions: [], id: 'user-b', display_name: 'User B' }
          })
        )
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter, open, target } = createAdapter({ fetcher })
    const sessions: Array<unknown> = []
    adapter.subscribe((session) => sessions.push(session))
    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    const state = new URL(String(opened.location.href)).searchParams.get('state')!

    target.dispatchEvent(
      new MessageEvent('message', {
        origin: CLIENT_ORIGIN,
        source: opened,
        data: { code: 'stale-code', state }
      })
    )
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await adapter.getSession()
    rejectExchange(new Error('stale exchange failed'))
    await Promise.resolve()
    await Promise.resolve()

    expect(sessions.at(-1)).toMatchObject({ userId: 'user-b' })
  })

  it('refreshes the cookie session once after an access-token rejection', async () => {
    let accessRequests = 0
    let refreshRequests = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session'))
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf-1' })
      if (url.endsWith('/session/access-token')) {
        accessRequests++
        return accessRequests === 1
          ? response({ error_code: 'ACC_AUTH_TOKEN_INVALID' }, 401)
          : response({ access_token: jwt({ sub: 'user-1', roles: [], exp: 9_999_999_999 }) })
      }
      if (url.endsWith('/refresh')) {
        refreshRequests++
        return response({ access_token: 'unused-cookie-refresh-response' })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({ fetcher, accountOrigin: 'https://refresh.example' })
    await adapter.getSession()

    await expect(adapter.getAccessToken()).resolves.toContain('.')
    expect(accessRequests).toBe(2)
    expect(refreshRequests).toBe(1)
  })

  it('does not touch browser Web Storage during browser authentication', async () => {
    const local = vi.spyOn(Storage.prototype, 'getItem')
    const session = vi.spyOn(Storage.prototype, 'setItem')
    const { adapter } = createAdapter()
    await adapter.signIn()
    adapter.dispose()
    expect(local).not.toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
  })

  it('uses the only registered production callback by default and removes its listener on dispose', async () => {
    const open = vi.fn(() => popup())
    const target = new EventTarget() as Window
    Object.assign(target, {
      location: { href: 'https://preview.example/#/files', origin: 'https://preview.example' },
      open
    })
    const adapter = createBrowserHhcAuthAdapter({
      accountOrigin: ACCOUNT_ORIGIN,
      fetcher: vi.fn(),
      window: target
    })

    await adapter.signIn()
    const opened = open.mock.results[0]?.value as Window
    expect(new URL(String(opened.location.href)).searchParams.get('redirect_uri')).toBe(
      'https://client.alive.org.tw/oauth/callback'
    )
    const remove = vi.spyOn(target, 'removeEventListener')
    adapter.dispose()
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('reacquires an expired cached access token using the current clock', async () => {
    let now = 1_000
    let tokenIssues = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session'))
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf-1' })
      if (url.endsWith('/session/access-token')) {
        tokenIssues++
        return response({
          access_token: jwt({ sub: 'user-1', roles: [], exp: tokenIssues === 1 ? 2 : 10 })
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({
      fetcher,
      now: () => now,
      accountOrigin: 'https://clock.example'
    })
    await adapter.getSession()

    const first = await adapter.getAccessToken()
    now = 3_000
    const second = await adapter.getAccessToken()
    expect(first).not.toBe(second)
    expect(tokenIssues).toBe(2)
  })

  it.each([
    ['sub mismatch', jwt({ sub: 'other', roles: [], exp: 9_999_999_999 })],
    ['missing roles', jwt({ sub: 'user-1', exp: 9_999_999_999 })],
    ['expired token', jwt({ sub: 'user-1', roles: [], exp: 1 })],
    ['malformed token', 'not-a-jwt']
  ])('rejects %s claims without retaining a token', async (_name, accessToken) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session'))
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf-1' })
      if (url.endsWith('/session/access-token')) return response({ access_token: accessToken })
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({ fetcher })
    await adapter.getSession()
    await expect(adapter.getAccessToken()).rejects.toThrow()
    await expect(adapter.getAccessToken()).rejects.toThrow()
  })

  it('does not retain an access token whose claims fail validation', async () => {
    const invalidToken = jwt({ sub: 'other', roles: [], exp: 9_999_999_999 })
    let issues = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session'))
        return response({
          authenticated: true,
          user: { permissions: [], id: 'user-1', display_name: 'Ada' }
        })
      if (url.endsWith('/csrf-token')) return response({ csrf_token: 'csrf-1' })
      if (url.endsWith('/session/access-token')) {
        issues++
        return response({ access_token: invalidToken })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const { adapter } = createAdapter({ fetcher, accountOrigin: 'https://invalid-token.example' })
    await adapter.getSession()

    await expect(adapter.getAccessToken()).rejects.toThrow('Invalid HHC access token claims')
    await expect(adapter.getAccessToken()).rejects.toThrow('Invalid HHC access token claims')
    expect(issues).toBe(2)
  })
})
