import {
  clearOAuthTransaction,
  createAccountSessionClient,
  createBrowserAccountAuthRuntime,
  currentReturnTo,
  readOAuthTransaction,
  type AccountAuthState
} from '@hallelujahhomechurch/account-client'
import type { HhcAuthAdapter, HhcPendingSignIn, HhcSession } from '@shared/hhc-auth'
import { HHC_AUTH } from './hhc-auth'

const transactionLifetimeMs = 10 * 60_000

export type BrowserHhcAuthOptions = {
  accountOrigin?: string
  fetcher?: typeof fetch
  now?: () => number
}

export class BrowserHhcAuthAdapter implements HhcAuthAdapter {
  readonly revalidateOnPageActivity = true
  private readonly now: () => number
  private readonly runtime
  private readonly client
  private readonly storageKey: string
  private readonly listeners = new Set<(session: HhcSession | null) => void>()

  constructor(options: BrowserHhcAuthOptions = {}) {
    const accountOrigin = options.accountOrigin ?? new URL(HHC_AUTH.accountApi).origin
    const accountApi = `${accountOrigin}/api/account/v1`
    this.now = options.now ?? Date.now
    this.storageKey = `hhc:oauth:${HHC_AUTH.clientId}`
    this.client = createAccountSessionClient({
      baseUrl: accountApi,
      fetcher: options.fetcher,
      now: this.now
    })
    this.runtime = createBrowserAccountAuthRuntime({
      client: this.client,
      now: this.now,
      oauth: {
        authorizeBaseUrl: accountApi,
        clientId: HHC_AUTH.clientId,
        redirectUri: HHC_AUTH.callbackUri,
        scope: HHC_AUTH.scope
      }
    })
    this.runtime.subscribe(() => this.notify())
  }

  async getSession(): Promise<HhcSession | null> {
    const state = this.isCallback() ? await this.completeCallback() : await this.runtime.start()
    return this.sessionFrom(state)
  }

  async signIn(): Promise<HhcPendingSignIn> {
    await this.runtime.beginSignIn(currentReturnTo(window.location))
    return { expiresAt: this.now() + transactionLifetimeMs }
  }

  cancelSignIn(): Promise<void> {
    clearOAuthTransaction({ storage: sessionStorage, storageKey: this.storageKey })
    return Promise.resolve()
  }

  getAccessToken(): Promise<string | null> {
    return this.runtime.getAccessToken()
  }

  refreshAfterUnauthorized(rejectedToken: string): Promise<string | null> {
    return this.runtime.refreshAfterUnauthorized(rejectedToken)
  }

  async signOut(): Promise<void> {
    this.runtime.clear()
    await this.client.logoutAll()
  }

  subscribe(listener: (session: HhcSession | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
    this.runtime.dispose()
  }

  private async completeCallback(): Promise<AccountAuthState> {
    const transaction = readOAuthTransaction({
      storage: sessionStorage,
      storageKey: this.storageKey,
      now: this.now
    })
    const state = await this.runtime.completeSignIn()
    if (state.status === 'authenticated') window.location.replace(transaction?.returnTo ?? '/')
    return state
  }

  private isCallback(): boolean {
    const callback = new URL(HHC_AUTH.callbackUri)
    return (
      window.location.origin === callback.origin && window.location.pathname === callback.pathname
    )
  }

  private sessionFrom(state: AccountAuthState): HhcSession | null {
    if (state.status === 'anonymous') return null
    if (state.status === 'unavailable') throw state.error
    if (state.status !== 'authenticated') throw new Error('HHC account session is still checking')
    return {
      userId: state.session.user.id,
      displayName: state.session.user.display_name,
      ...(state.session.user.avatar_url ? { avatarUrl: state.session.user.avatar_url } : {}),
      roles: [],
      permissions: [...state.session.permissions],
      permissionAvailability: { status: state.session.permissionAvailability.status }
    }
  }

  private notify(): void {
    const state = this.runtime.getSnapshot()
    if (state.status === 'unavailable' || state.status === 'checking') return
    const session = this.sessionFrom(state)
    for (const listener of this.listeners) listener(session)
  }
}

export function createBrowserHhcAuthAdapter(
  options?: BrowserHhcAuthOptions
): BrowserHhcAuthAdapter {
  return new BrowserHhcAuthAdapter(options)
}
