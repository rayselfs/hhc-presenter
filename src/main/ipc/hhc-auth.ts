import { app, ipcMain, net, safeStorage, shell } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { APP_CONFIG } from '@shared/app-config'
import {
  HHC_AUTH_TRANSACTION_TTL_MS,
  readHhcPermissions,
  type PresenterAccountLabel,
  type HhcPendingSignIn,
  type HhcSession
} from '@shared/hhc-auth'
import type { HhcPresenterProtocolAction } from '../protocol-router'
import type { WindowManager } from '../windowManager'
import { isMainWindow } from './validate'

const CLIENT_ID = 'hhc-desktop'
const REDIRECT_URI = 'hhc-presenter://auth/account'
const SCOPE = 'openid profile presenter:cloud:manage'
const REVOKE_TIMEOUT_MS = 5000

type AccountAuthAction = Extract<HhcPresenterProtocolAction, { kind: 'account-auth' }>

type StoredCredential = {
  installationId: string
  refreshToken?: string
}

type AccessCredential = {
  token: string
  subject: string
  roles: string[]
  expiresAt: number
}

type Transaction = {
  state: string
  codeVerifier: string
  expiresAt: number
  generation: number
}

type HhcAuthServiceOptions = {
  now?: () => number
}

export interface HhcAuthService {
  begin(): Promise<HhcPendingSignIn>
  cancelSignIn(): Promise<void>
  completeProtocolCallback(action: AccountAuthAction): Promise<boolean>
  getAccessToken(): Promise<string | null>
  refreshAccessToken(): Promise<string | null>
  getSession(): Promise<HhcSession | null>
  signOut(): Promise<void>
  clearLocalData(): Promise<void>
  resolveShareTarget(email: string): Promise<PresenterAccountLabel>
  resolveAccountLabels(userIds: string[]): Promise<PresenterAccountLabel[]>
  subscribe(listener: (session: HhcSession | null) => void): () => void
}

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function parseStoredCredential(value: unknown): StoredCredential {
  if (!value || typeof value !== 'object') throw new Error('Invalid HHC credential record')
  const record = value as Record<string, unknown>
  if (typeof record.installationId !== 'string' || !record.installationId) {
    throw new Error('Invalid HHC credential record')
  }
  if (
    record.refreshToken !== undefined &&
    (typeof record.refreshToken !== 'string' || !record.refreshToken)
  ) {
    throw new Error('Invalid HHC credential record')
  }
  return {
    installationId: record.installationId,
    ...(record.refreshToken ? { refreshToken: record.refreshToken } : {})
  }
}

function parseAccessCredential(token: string, now: number): AccessCredential {
  const encoded = token.split('.')[1]
  if (!encoded) throw new Error('Invalid HHC access token')

  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    throw new Error('Invalid HHC access token')
  }
  if (
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    !Array.isArray(claims.roles) ||
    !claims.roles.every((role) => typeof role === 'string') ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now / 1000
  ) {
    throw new Error('Invalid HHC access token claims')
  }
  return {
    token,
    subject: claims.sub,
    roles: claims.roles,
    expiresAt: claims.exp * 1000
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`HHC account request failed (${response.status})`)
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    throw new Error('Invalid HHC account response')
  }
}

class MainHhcAuthService implements HhcAuthService {
  private readonly accountApi = `${APP_CONFIG.hhcAccountOrigin}/api/account/v1`
  private readonly credentialPath = join(app.getPath('userData'), 'hhc-auth.enc')
  private readonly now: () => number
  private readonly listeners = new Set<(session: HhcSession | null) => void>()
  private readonly beginsInFlight = new Set<Promise<HhcPendingSignIn>>()
  private readonly tokenPersistenceInFlight = new Set<Promise<unknown>>()
  private readonly profileLoadsInFlight = new Set<Promise<HhcSession>>()
  private transaction: Transaction | null = null
  private authGeneration = 0
  private completionInFlight: Promise<boolean> | null = null
  private refreshInFlight: Promise<string | null> | null = null
  private signOutInFlight: Promise<void> | null = null
  private clearLocalDataInFlight: Promise<void> | null = null
  private credentialLoadInFlight: Promise<StoredCredential | null> | null = null
  private storedCredential: StoredCredential | null = null
  private storedCredentialLoaded = false
  private accessCredential: AccessCredential | null = null
  private session: HhcSession | null = null

  constructor(options: HhcAuthServiceOptions) {
    this.now = options.now ?? Date.now
  }

  async begin(): Promise<HhcPendingSignIn> {
    if (this.completionInFlight || this.signOutInFlight || this.clearLocalDataInFlight) {
      throw new Error('HHC sign-in is already in progress')
    }
    const generation = ++this.authGeneration
    this.transaction = null
    const request = this.startAuthorization(generation)
    this.beginsInFlight.add(request)
    void request.then(
      () => this.beginsInFlight.delete(request),
      () => this.beginsInFlight.delete(request)
    )
    return request
  }

  cancelSignIn(): Promise<void> {
    this.authGeneration += 1
    this.transaction = null
    return Promise.resolve()
  }

  completeProtocolCallback(action: AccountAuthAction): Promise<boolean> {
    if (this.signOutInFlight || this.clearLocalDataInFlight) return Promise.resolve(false)
    const transaction = this.transaction
    if (
      !transaction ||
      transaction.generation !== this.authGeneration ||
      transaction.expiresAt <= this.now()
    ) {
      this.transaction = null
      return Promise.resolve(false)
    }
    if (action.state !== transaction.state) return Promise.resolve(false)
    this.transaction = null

    const completion = this.finishProtocolCallback(action, transaction).finally(() => {
      if (this.completionInFlight === completion) this.completionInFlight = null
    })
    this.completionInFlight = completion
    return completion
  }

  private async finishProtocolCallback(
    action: AccountAuthAction,
    transaction: Transaction
  ): Promise<boolean> {
    await this.trackTokenPersistence(this.persistProtocolCallbackToken(action, transaction))
    await this.loadSessionFromAccessToken()
    return true
  }

  private async persistProtocolCallbackToken(
    action: AccountAuthAction,
    transaction: Transaction
  ): Promise<void> {
    const credential = await this.loadCredential(true)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: transaction.codeVerifier,
      code: action.code,
      device_id: credential.installationId,
      device_name: this.deviceName()
    })
    const data = await this.requestToken(body)
    await this.acceptTokenResponse(data, credential)
  }

  async getAccessToken(): Promise<string | null> {
    if (this.signOutInFlight || this.clearLocalDataInFlight) return null
    if (this.accessCredential && this.accessCredential.expiresAt > this.now()) {
      if (!this.session) await this.loadSessionFromAccessToken()
      return this.accessCredential.token
    }
    this.accessCredential = null
    if (this.refreshInFlight) return this.refreshInFlight

    this.refreshInFlight = this.refreshStoredCredential().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  async refreshAccessToken(): Promise<string | null> {
    if (this.signOutInFlight || this.clearLocalDataInFlight) return null
    const completion = this.completionInFlight
    if (completion) await completion
    if (this.signOutInFlight || this.clearLocalDataInFlight) return null
    if (this.refreshInFlight) return this.refreshInFlight

    this.refreshInFlight = this.refreshStoredCredential().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  async getSession(): Promise<HhcSession | null> {
    if (this.signOutInFlight || this.clearLocalDataInFlight) return null
    if (this.session && this.accessCredential && this.accessCredential.expiresAt > this.now()) {
      return this.session
    }
    if (this.accessCredential && this.accessCredential.expiresAt > this.now()) {
      return this.loadSessionFromAccessToken()
    }
    const token = await this.getAccessToken()
    return token ? this.session : null
  }

  resolveShareTarget(email: string): Promise<PresenterAccountLabel> {
    return this.presenterPost('/presenter/share-targets/resolve', { email }).then((value) =>
      this.presenterLabel(value, true)
    )
  }

  async resolveAccountLabels(userIds: string[]): Promise<PresenterAccountLabel[]> {
    const value = await this.presenterPost('/presenter/account-labels/resolve', { userIds })
    if (!value || !Array.isArray(value.accounts) || value.accounts.length > 50) {
      throw new Error('Invalid HHC account response')
    }
    return value.accounts.map((account) => this.presenterLabel(account, false))
  }

  private presenterLabel(value: unknown, includeEmail: boolean): PresenterAccountLabel {
    if (!value || typeof value !== 'object') throw new Error('Invalid HHC account response')
    const item = value as Record<string, unknown>
    if (
      typeof item.userId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(item.userId) ||
      typeof item.displayName !== 'string' ||
      !item.displayName.trim() ||
      (includeEmail && (typeof item.email !== 'string' || !item.email))
    ) {
      throw new Error('Invalid HHC account response')
    }
    return {
      userId: item.userId,
      displayName: item.displayName,
      ...(includeEmail ? { email: item.email as string } : {})
    }
  }

  private async presenterPost(path: string, body: unknown): Promise<Record<string, unknown>> {
    const csrfResponse = await net.fetch(`${this.accountApi}/csrf-token`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' }
    })
    const csrf = await responseJson(csrfResponse)
    if (typeof csrf.csrf_token !== 'string' || !csrf.csrf_token) {
      throw new Error('CSRF token missing')
    }
    const csrfToken = csrf.csrf_token
    const send = async (refresh: boolean): Promise<Response> => {
      const token = await (refresh ? this.refreshAccessToken() : this.getAccessToken())
      if (!token) throw new Error('HHC account authentication required')
      return net.fetch(`${this.accountApi}${path}`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify(body)
      })
    }
    let response = await send(false)
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      response = await send(true)
    }
    return responseJson(response)
  }

  signOut(): Promise<void> {
    if (this.clearLocalDataInFlight) return this.clearLocalDataInFlight
    if (this.signOutInFlight) return this.signOutInFlight
    this.authGeneration += 1
    this.transaction = null
    const beginsInFlight = [...this.beginsInFlight]
    const completionInFlight = this.completionInFlight
    this.signOutInFlight = this.performSignOut(beginsInFlight, completionInFlight).finally(() => {
      this.signOutInFlight = null
    })
    return this.signOutInFlight
  }

  private async performSignOut(
    beginsInFlight: Promise<HhcPendingSignIn>[],
    completionInFlight: Promise<boolean> | null
  ): Promise<void> {
    await Promise.allSettled(beginsInFlight)
    this.transaction = null
    if (completionInFlight) await completionInFlight.catch(() => false)
    if (this.refreshInFlight) await this.refreshInFlight.catch(() => null)
    await Promise.allSettled([...this.profileLoadsInFlight])
    const credential = await this.loadCredential(false)
    if (!credential) {
      this.clearMemory()
      return
    }

    await this.revokeRefreshToken(credential)

    await this.saveCredential({ installationId: credential.installationId })
    this.clearMemory()
  }

  clearLocalData(): Promise<void> {
    if (this.clearLocalDataInFlight) return this.clearLocalDataInFlight
    this.authGeneration += 1
    this.transaction = null
    const clearing = this.performClearLocalData(
      [...this.beginsInFlight],
      [...this.tokenPersistenceInFlight],
      this.completionInFlight,
      this.refreshInFlight,
      this.signOutInFlight
    ).finally(() => {
      if (this.clearLocalDataInFlight === clearing) this.clearLocalDataInFlight = null
    })
    this.clearLocalDataInFlight = clearing
    return clearing
  }

  private async performClearLocalData(
    beginsInFlight: Promise<HhcPendingSignIn>[],
    tokenPersistenceInFlight: Promise<unknown>[],
    completionInFlight: Promise<boolean> | null,
    refreshInFlight: Promise<string | null> | null,
    signOutInFlight: Promise<void> | null
  ): Promise<void> {
    await Promise.allSettled(beginsInFlight)
    this.transaction = null
    await Promise.allSettled(tokenPersistenceInFlight)
    const credential = await this.loadCredential(false).catch(() => null)
    if (completionInFlight) await completionInFlight.catch(() => false)
    if (refreshInFlight) await refreshInFlight.catch(() => null)
    if (signOutInFlight) await signOutInFlight.catch(() => undefined)
    await Promise.allSettled([...this.profileLoadsInFlight])

    this.storedCredential = null
    this.storedCredentialLoaded = true
    this.clearMemory()
    await fs.rm(this.credentialPath, { force: true })
    if (credential) await this.revokeRefreshToken(credential)
  }

  private async revokeRefreshToken(credential: StoredCredential): Promise<void> {
    if (!credential.refreshToken) return
    try {
      await net.fetch(`${this.accountApi}/oauth/revoke`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          token: credential.refreshToken,
          client_id: CLIENT_ID,
          token_type_hint: 'refresh_token'
        }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS)
      })
    } catch {
      // Local credential removal remains authoritative when the remote service is unavailable.
    }
  }

  subscribe(listener: (session: HhcSession | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async startAuthorization(generation: number): Promise<HhcPendingSignIn> {
    const pending = { expiresAt: this.now() + HHC_AUTH_TRANSACTION_TTL_MS }
    await this.loadCredential(true)
    if (generation !== this.authGeneration) return pending
    const codeVerifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const url = new URL(`${this.accountApi}/oauth/authorize`)
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: SCOPE,
      state
    }).toString()
    this.transaction = { state, codeVerifier, expiresAt: pending.expiresAt, generation }
    try {
      await shell.openExternal(url.toString())
    } catch (error) {
      if (this.transaction?.generation === generation) this.transaction = null
      throw error
    }
    return pending
  }

  private async refresh(credential: StoredCredential): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: credential.refreshToken!,
      device_id: credential.installationId,
      device_name: this.deviceName()
    })
    let data: Record<string, unknown>
    try {
      data = await this.requestToken(body)
      await this.acceptTokenResponse(data, credential)
    } catch (error) {
      if (
        error instanceof Error &&
        /^HHC account request failed \((400|401)\)$/.test(error.message)
      ) {
        await this.clearStoredRefreshToken(credential)
      }
      throw error
    }
    return this.accessCredential!.token
  }

  private async persistStoredCredentialRefresh(): Promise<string | null> {
    const credential = await this.loadCredential(false)
    return credential?.refreshToken ? this.refresh(credential) : null
  }

  private async refreshStoredCredential(): Promise<string | null> {
    const token = await this.trackTokenPersistence(this.persistStoredCredentialRefresh())
    if (!token) return null
    await this.loadSessionFromAccessToken()
    return token
  }

  private async requestToken(body: URLSearchParams): Promise<Record<string, unknown>> {
    return responseJson(
      await net.fetch(`${this.accountApi}/oauth/token`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body
      })
    )
  }

  private async acceptTokenResponse(
    data: Record<string, unknown>,
    credential: StoredCredential
  ): Promise<void> {
    if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
      throw new Error('Invalid HHC token response')
    }
    const accessCredential = parseAccessCredential(data.access_token, this.now())
    await this.saveCredential({
      installationId: credential.installationId,
      refreshToken: data.refresh_token
    })
    this.accessCredential = accessCredential
    this.session = null
  }

  private trackTokenPersistence<T>(request: Promise<T>): Promise<T> {
    this.tokenPersistenceInFlight.add(request)
    void request.then(
      () => this.tokenPersistenceInFlight.delete(request),
      () => this.tokenPersistenceInFlight.delete(request)
    )
    return request
  }

  private loadSessionFromAccessToken(): Promise<HhcSession> {
    if (this.clearLocalDataInFlight) {
      return Promise.reject(new Error('HHC authentication changed'))
    }
    const request = this.fetchSessionFromAccessToken(this.authGeneration, this.accessCredential)
    this.profileLoadsInFlight.add(request)
    void request.then(
      () => this.profileLoadsInFlight.delete(request),
      () => this.profileLoadsInFlight.delete(request)
    )
    return request
  }

  private async fetchSessionFromAccessToken(
    generation: number,
    access: AccessCredential | null
  ): Promise<HhcSession> {
    if (!access || access.expiresAt <= this.now()) throw new Error('HHC access token expired')
    const data = await responseJson(
      await net.fetch(`${this.accountApi}/me`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${access.token}` }
      })
    )
    this.assertCurrentAccess(generation, access)
    if (typeof data.id !== 'string' || data.id !== access.subject) {
      const credential = await this.loadCredential(false)
      this.assertCurrentAccess(generation, access)
      if (credential) await this.clearStoredRefreshToken(credential)
      this.clearMemory()
      throw new Error('HHC account identity mismatch')
    }

    const firstName = typeof data.first_name === 'string' ? data.first_name.trim() : ''
    const lastName = typeof data.last_name === 'string' ? data.last_name.trim() : ''
    const email = typeof data.email === 'string' ? data.email.trim() : ''
    const displayName = [firstName, lastName].filter(Boolean).join(' ') || email
    if (!displayName) throw new Error('Invalid HHC account profile')

    this.session = {
      userId: access.subject,
      displayName,
      ...(typeof data.avatar_url === 'string' && data.avatar_url
        ? { avatarUrl: data.avatar_url }
        : {}),
      roles: access.roles,
      permissions: readHhcPermissions(data.permissions)
    }
    this.notify()
    return this.session
  }

  private assertCurrentAccess(generation: number, access: AccessCredential): void {
    if (generation !== this.authGeneration || access !== this.accessCredential) {
      throw new Error('HHC authentication changed')
    }
  }

  private async loadCredential(create: true): Promise<StoredCredential>
  private async loadCredential(create: false): Promise<StoredCredential | null>
  private async loadCredential(create: boolean): Promise<StoredCredential | null> {
    const existing = this.credentialLoadInFlight
    if (existing) {
      const credential = await existing
      if (credential || !create) return credential
      return this.loadCredential(true)
    }

    const request = this.loadCredentialOnce(create)
    this.credentialLoadInFlight = request
    try {
      return await request
    } finally {
      if (this.credentialLoadInFlight === request) this.credentialLoadInFlight = null
    }
  }

  private async loadCredentialOnce(create: boolean): Promise<StoredCredential | null> {
    if (this.storedCredentialLoaded) {
      if (this.storedCredential) return this.storedCredential
      if (!create) return null
    } else {
      try {
        const encrypted = await fs.readFile(this.credentialPath)
        if (!secureStorageAvailable()) throw new Error('Secure credential storage is unavailable')
        this.storedCredential = parseStoredCredential(
          JSON.parse(safeStorage.decryptString(encrypted))
        )
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        this.storedCredential = null
      }
      this.storedCredentialLoaded = true
    }

    if (!this.storedCredential && create) {
      await this.saveCredential({ installationId: randomUUID() })
    }
    return this.storedCredential
  }

  private async saveCredential(credential: StoredCredential): Promise<void> {
    if (!secureStorageAvailable()) throw new Error('Secure credential storage is unavailable')
    const temporaryPath = `${this.credentialPath}.${process.pid}.${Date.now()}.tmp`
    await fs.mkdir(dirname(this.credentialPath), { recursive: true })
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify(credential))
      await fs.writeFile(temporaryPath, encrypted, { mode: 0o600 })
      await fs.rename(temporaryPath, this.credentialPath)
      this.storedCredential = credential
      this.storedCredentialLoaded = true
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async clearStoredRefreshToken(credential: StoredCredential): Promise<void> {
    await this.saveCredential({ installationId: credential.installationId })
    this.clearMemory()
  }

  private clearMemory(): void {
    this.accessCredential = null
    this.session = null
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.session)
  }

  private deviceName(): string {
    return `HHC Presenter Electron (${process.platform})`
  }
}

export function createHhcAuthService(options: HhcAuthServiceOptions = {}): HhcAuthService {
  return new MainHhcAuthService(options)
}

export function registerHhcAuthIpc(wm: WindowManager, service: HhcAuthService): void {
  const authorized =
    <T>(handler: () => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent): Promise<T> => {
      if (!isMainWindow(wm, event)) {
        throw new Error('Unauthorized HHC authentication access')
      }
      return handler()
    }

  ipcMain.handle(
    'hhc-auth:begin',
    authorized(() => service.begin())
  )
  ipcMain.handle('hhc-auth:resolve-share-target', async (event, email: unknown) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized HHC authentication access')
    if (typeof email !== 'string' || email.length > 320 || !email.includes('@')) {
      throw new Error('Invalid sharing email')
    }
    return service.resolveShareTarget(email)
  })
  ipcMain.handle('hhc-auth:resolve-account-labels', async (event, userIds: unknown) => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized HHC authentication access')
    if (
      !Array.isArray(userIds) ||
      userIds.length < 1 ||
      userIds.length > 50 ||
      !userIds.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
    ) {
      throw new Error('Invalid account IDs')
    }
    return service.resolveAccountLabels(userIds)
  })
  ipcMain.handle(
    'hhc-auth:cancel',
    authorized(() => service.cancelSignIn())
  )
  ipcMain.handle(
    'hhc-auth:get-access-token',
    authorized(() => service.getAccessToken())
  )
  ipcMain.handle(
    'hhc-auth:refresh-access-token',
    authorized(() => service.refreshAccessToken())
  )
  ipcMain.handle(
    'hhc-auth:get-session',
    authorized(() => service.getSession())
  )
  ipcMain.handle(
    'hhc-auth:sign-out',
    authorized(() => service.signOut())
  )
  service.subscribe((session) => wm.sendToMain('hhc-auth:session-changed', session))
}
