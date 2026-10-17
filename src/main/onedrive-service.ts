import { app, net, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  OneDriveAccessTokenRequest,
  OneDriveAccessTokenResult,
  OneDriveAuthCodeExchangeRequest,
  OneDriveConnectedAccount,
  OneDriveCredentialStatus
} from '@shared/ipc-channels'
import type { WindowManager } from './windowManager'
import { parseHhcPresenterProtocolUrl } from './protocol-router'

interface StoredOneDriveCredential {
  connectionId: string
  accessToken?: string
  refreshToken: string
  expiresAt?: number
  scope?: string
  tokenType?: 'Bearer'
  updatedAt: number
}

const CONNECTION_ID_PATTERN = /^onedrive:[A-Za-z0-9._~-]{1,160}$/
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ONEDRIVE_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const MICROSOFT_GRAPH_ME_ENDPOINT = 'https://graph.microsoft.com/v1.0/me'
export const ONEDRIVE_AUTH_REDIRECT_URI = 'hhc-presenter://auth/onedrive'
const AUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 5 * 60_000

interface OneDriveAccountProfile {
  id?: unknown
  displayName?: unknown
  userPrincipalName?: unknown
  mail?: unknown
}

interface AuthCallbackWaiter {
  resolve: (url: string | null) => void
  promise: Promise<string | null>
  timeout: NodeJS.Timeout
  expectedState?: string
}

export interface OneDriveService {
  clearCredentials(): Promise<void>
  handleAuthCallbackUrl(value: string, wm?: WindowManager): boolean
  getCredentialStatus(connectionId: unknown): Promise<OneDriveCredentialStatus>
  getAccessToken(input: unknown): Promise<OneDriveAccessTokenResult>
  completeAuth(input: unknown): Promise<OneDriveConnectedAccount>
  deleteCredentials(connectionId: unknown): Promise<void>
  waitForAuthCallback(expectedState: unknown): Promise<string | null>
  dispose(): void
}

export function createOneDriveService(): OneDriveService {
  let disposed = false
  function assertActive(): void {
    if (disposed) throw new Error('OneDrive service was disposed')
  }

  let authCallbackWaiter: AuthCallbackWaiter | null = null
  let queuedAuthCallbackUrl: string | null = null
  const refreshesByConnection = new Map<string, Promise<OneDriveAccessTokenResult>>()

  let credentialRevision = 0
  let clearedAtRevision = 0
  const changedAtRevision = new Map<string, number>()
  let credentialIO: Promise<void> = Promise.resolve()

  function serializeCredentialIO<T>(operation: () => Promise<T>): Promise<T> {
    const result = credentialIO.then(operation)
    credentialIO = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function assertCredentialCurrent(connectionId: string, revision: number): void {
    assertActive()
    if (clearedAtRevision > revision || (changedAtRevision.get(connectionId) ?? 0) > revision) {
      throw new Error('OneDrive credential operation was revoked')
    }
  }

  function invalidateCredential(connectionId: string): void {
    changedAtRevision.set(connectionId, ++credentialRevision)
    refreshesByConnection.delete(connectionId)
  }

  function clearOneDriveCredentials(): Promise<void> {
    assertActive()
    queuedAuthCallbackUrl = null
    settleAuthCallback(null)
    clearedAtRevision = ++credentialRevision
    refreshesByConnection.clear()
    return serializeCredentialIO(() => fs.rm(getCredentialDir(), { recursive: true, force: true }))
  }

  function validateConnectionId(connectionId: unknown): string {
    if (
      typeof connectionId !== 'string' ||
      !CONNECTION_ID_PATTERN.test(connectionId) ||
      connectionId.includes('..')
    ) {
      throw new Error('Invalid OneDrive connection id')
    }
    return connectionId
  }

  function validateClientId(clientId: unknown): string {
    if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId.trim())) {
      throw new Error('Invalid OneDrive Client ID')
    }
    return clientId.trim()
  }

  function isOneDriveAuthCallbackUrl(value: string): boolean {
    return parseHhcPresenterProtocolUrl(value).kind === 'onedrive-auth'
  }

  function settleAuthCallback(result: string | null): void {
    const waiter = authCallbackWaiter
    authCallbackWaiter = null
    if (!waiter) return
    clearTimeout(waiter.timeout)
    waiter.resolve(result)
  }

  function getAuthCallbackState(value: string): string | null {
    try {
      return new URL(value).searchParams.get('state')
    } catch {
      return null
    }
  }

  function matchesExpectedAuthState(value: string, expectedState?: string): boolean {
    return !expectedState || getAuthCallbackState(value) === expectedState
  }

  function handleOneDriveAuthCallbackUrl(value: string, wm?: WindowManager): boolean {
    if (disposed || !isOneDriveAuthCallbackUrl(value)) return false
    const mainWindow = wm?.getMainWindow()
    mainWindow?.show()
    mainWindow?.focus()
    if (authCallbackWaiter) {
      if (matchesExpectedAuthState(value, authCallbackWaiter.expectedState)) {
        settleAuthCallback(value)
      }
    } else {
      queuedAuthCallbackUrl = value
    }
    return true
  }

  function validateExpectedAuthState(value: unknown): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Invalid OneDrive OAuth state')
    }
    return value.trim()
  }

  function waitForAuthCallback(expectedState?: string): Promise<string | null> {
    if (queuedAuthCallbackUrl) {
      const callbackUrl = queuedAuthCallbackUrl
      queuedAuthCallbackUrl = null
      if (matchesExpectedAuthState(callbackUrl, expectedState)) return Promise.resolve(callbackUrl)
    }
    if (authCallbackWaiter) return authCallbackWaiter.promise

    let resolvePromise: (url: string | null) => void = () => undefined
    const promise = new Promise<string | null>((resolve) => {
      resolvePromise = resolve
    })
    const timeout = setTimeout(() => settleAuthCallback(null), AUTH_CALLBACK_TIMEOUT_MS)
    authCallbackWaiter = { resolve: resolvePromise, promise, timeout, expectedState }
    return promise
  }

  function getCredentialDir(): string {
    return join(app.getPath('userData'), 'onedrive-credentials')
  }

  function getCredentialPath(connectionId: string): string {
    return join(getCredentialDir(), `${encodeURIComponent(connectionId)}.enc`)
  }

  function normalizeCredential(input: unknown): StoredOneDriveCredential {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid OneDrive credential payload')
    }
    const value = input as Record<string, unknown>
    const connectionId = validateConnectionId(value.connectionId)
    if (typeof value.refreshToken !== 'string' || value.refreshToken.trim().length === 0) {
      throw new Error('Invalid OneDrive refresh token')
    }
    if (value.accessToken !== undefined && typeof value.accessToken !== 'string') {
      throw new Error('Invalid OneDrive access token')
    }
    if (
      value.expiresAt !== undefined &&
      (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt))
    ) {
      throw new Error('Invalid OneDrive token expiry')
    }
    if (value.scope !== undefined && typeof value.scope !== 'string') {
      throw new Error('Invalid OneDrive token scope')
    }

    return {
      connectionId,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      scope: value.scope,
      tokenType: value.tokenType === 'Bearer' ? 'Bearer' : undefined,
      updatedAt: Date.now()
    }
  }

  function normalizeAccessTokenRequest(input: unknown): OneDriveAccessTokenRequest {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid OneDrive access token request')
    }
    const value = input as Record<string, unknown>
    return {
      connectionId: validateConnectionId(value.connectionId),
      clientId: validateClientId(value.clientId)
    }
  }

  function normalizeAuthCodeExchangeRequest(input: unknown): OneDriveAuthCodeExchangeRequest {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid OneDrive auth code exchange request')
    }
    const value = input as Record<string, unknown>
    if (value.redirectUri !== ONEDRIVE_AUTH_REDIRECT_URI) {
      throw new Error('Invalid OneDrive redirect URI')
    }
    if (typeof value.code !== 'string' || value.code.trim().length === 0) {
      throw new Error('Invalid OneDrive auth code')
    }
    if (typeof value.codeVerifier !== 'string' || value.codeVerifier.trim().length === 0) {
      throw new Error('Invalid OneDrive code verifier')
    }
    return {
      clientId: validateClientId(value.clientId),
      redirectUri: value.redirectUri,
      code: value.code,
      codeVerifier: value.codeVerifier
    }
  }

  function normalizeTokenResponse(input: unknown): {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scope?: string
    tokenType?: 'Bearer'
  } {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid OneDrive token response')
    }
    const value = input as Record<string, unknown>
    if (typeof value.access_token !== 'string' || value.access_token.trim().length === 0) {
      throw new Error('Invalid OneDrive access token response')
    }
    if (value.refresh_token !== undefined && typeof value.refresh_token !== 'string') {
      throw new Error('Invalid OneDrive refresh token response')
    }
    if (value.expires_in !== undefined && typeof value.expires_in !== 'number') {
      throw new Error('Invalid OneDrive token expiry response')
    }
    if (value.scope !== undefined && typeof value.scope !== 'string') {
      throw new Error('Invalid OneDrive token scope response')
    }

    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt:
        typeof value.expires_in === 'number' && Number.isFinite(value.expires_in)
          ? Date.now() + value.expires_in * 1000
          : undefined,
      scope: value.scope,
      tokenType: value.token_type === 'Bearer' ? 'Bearer' : undefined
    }
  }

  function toStatus(credential: StoredOneDriveCredential | null): OneDriveCredentialStatus {
    if (!credential) return { hasRefreshToken: false }
    return {
      hasRefreshToken: true,
      expiresAt: credential.expiresAt,
      scope: credential.scope
    }
  }

  function hasFreshAccessToken(credential: StoredOneDriveCredential): boolean {
    return (
      typeof credential.accessToken === 'string' &&
      credential.accessToken.length > 0 &&
      typeof credential.expiresAt === 'number' &&
      credential.expiresAt - Date.now() > ACCESS_TOKEN_EXPIRY_SKEW_MS
    )
  }

  function toAccessTokenResult(credential: StoredOneDriveCredential): OneDriveAccessTokenResult {
    if (!credential.accessToken) throw new Error('OneDrive credentials not found')
    return {
      accessToken: credential.accessToken,
      expiresAt: credential.expiresAt,
      scope: credential.scope,
      tokenType: credential.tokenType
    }
  }

  async function readCredential(connectionId: string): Promise<StoredOneDriveCredential | null> {
    try {
      const encrypted = await fs.readFile(getCredentialPath(connectionId))
      const decrypted = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(decrypted) as unknown
      return normalizeCredential(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async function writeCredential(
    credential: StoredOneDriveCredential,
    revision: number
  ): Promise<void> {
    assertCredentialCurrent(credential.connectionId, revision)
    const dir = getCredentialDir()
    await fs.mkdir(dir, { recursive: true })
    const targetPath = getCredentialPath(credential.connectionId)
    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
    const encrypted = safeStorage.encryptString(JSON.stringify(credential))
    try {
      await fs.writeFile(temporaryPath, encrypted)
      assertCredentialCurrent(credential.connectionId, revision)
      await fs.rename(temporaryPath, targetPath)
      assertCredentialCurrent(credential.connectionId, revision)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async function exchangeAuthCode(request: OneDriveAuthCodeExchangeRequest): Promise<{
    accessToken: string
    refreshToken: string
    expiresAt?: number
    scope?: string
    tokenType?: 'Bearer'
  }> {
    const body = new URLSearchParams()
    body.set('client_id', request.clientId)
    body.set('grant_type', 'authorization_code')
    body.set('code', request.code)
    body.set('redirect_uri', request.redirectUri)
    body.set('code_verifier', request.codeVerifier)
    body.set('scope', 'offline_access User.Read Files.Read')

    const response = await net.fetch(ONEDRIVE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!response.ok) throw new Error(`OneDrive token exchange failed: ${response.status}`)

    const token = normalizeTokenResponse(await response.json())
    if (!token.refreshToken) throw new Error('Invalid OneDrive token response')
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scope: token.scope,
      tokenType: token.tokenType
    }
  }

  function normalizeAccountProfile(input: OneDriveAccountProfile): OneDriveConnectedAccount {
    if (typeof input.id !== 'string' || input.id.trim().length === 0) {
      throw new Error('Invalid OneDrive account profile')
    }
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
    const userPrincipalName =
      typeof input.userPrincipalName === 'string' ? input.userPrincipalName.trim() : ''
    const mail = typeof input.mail === 'string' ? input.mail.trim() : ''
    const accountLabel = userPrincipalName || mail || displayName || undefined

    return {
      id: `onedrive:${input.id.trim()}`,
      providerType: 'onedrive',
      displayName: displayName ? `OneDrive - ${displayName}` : 'OneDrive',
      accountLabel
    }
  }

  async function fetchConnectedAccount(accessToken: string): Promise<OneDriveConnectedAccount> {
    const response = await net.fetch(MICROSOFT_GRAPH_ME_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!response.ok) throw new Error(`OneDrive profile fetch failed: ${response.status}`)
    return normalizeAccountProfile((await response.json()) as OneDriveAccountProfile)
  }

  async function completeAuth(
    request: OneDriveAuthCodeExchangeRequest
  ): Promise<OneDriveConnectedAccount> {
    const revision = credentialRevision
    const token = await exchangeAuthCode(request)
    const account = await fetchConnectedAccount(token.accessToken)
    const connectionId = validateConnectionId(account.id)
    await serializeCredentialIO(async () => {
      assertCredentialCurrent(connectionId, revision)
      // A reconnect supersedes refreshes started with the previous credential.
      invalidateCredential(connectionId)
      await writeCredential(
        {
          connectionId,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          scope: token.scope,
          tokenType: token.tokenType,
          updatedAt: Date.now()
        },
        credentialRevision
      )
    })
    return account
  }

  async function refreshAccessToken(
    credential: StoredOneDriveCredential,
    clientId: string,
    revision: number
  ): Promise<OneDriveAccessTokenResult> {
    const body = new URLSearchParams()
    body.set('client_id', clientId)
    body.set('grant_type', 'refresh_token')
    body.set('refresh_token', credential.refreshToken)
    body.set('scope', 'offline_access User.Read Files.Read')

    const response = await net.fetch(ONEDRIVE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!response.ok) throw new Error(`OneDrive token refresh failed: ${response.status}`)

    const token = normalizeTokenResponse(await response.json())
    const updatedCredential: StoredOneDriveCredential = {
      ...credential,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? credential.refreshToken,
      expiresAt: token.expiresAt,
      scope: token.scope,
      tokenType: token.tokenType,
      updatedAt: Date.now()
    }
    await serializeCredentialIO(() => writeCredential(updatedCredential, revision))
    assertCredentialCurrent(credential.connectionId, revision)

    return {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      scope: token.scope,
      tokenType: token.tokenType
    }
  }

  function getFreshAccessToken(
    request: OneDriveAccessTokenRequest
  ): Promise<OneDriveAccessTokenResult> {
    const existing = refreshesByConnection.get(request.connectionId)
    if (existing) return existing
    const revision = credentialRevision
    const refresh = serializeCredentialIO(async () => {
      assertCredentialCurrent(request.connectionId, revision)
      const credential = await readCredential(request.connectionId)
      assertCredentialCurrent(request.connectionId, revision)
      if (!credential) throw new Error('OneDrive credentials not found')
      return credential
    })
      .then((credential) => {
        assertCredentialCurrent(request.connectionId, revision)
        return hasFreshAccessToken(credential)
          ? toAccessTokenResult(credential)
          : refreshAccessToken(credential, request.clientId, revision)
      })
      .finally(() => {
        if (refreshesByConnection.get(request.connectionId) === refresh) {
          refreshesByConnection.delete(request.connectionId)
        }
      })
    refreshesByConnection.set(request.connectionId, refresh)
    return refresh
  }

  return {
    clearCredentials: clearOneDriveCredentials,
    handleAuthCallbackUrl: handleOneDriveAuthCallbackUrl,
    async getCredentialStatus(connectionId) {
      assertActive()
      const validConnectionId = validateConnectionId(connectionId)
      const revision = credentialRevision
      return serializeCredentialIO(async () => {
        assertCredentialCurrent(validConnectionId, revision)
        const credential = await readCredential(validConnectionId)
        assertCredentialCurrent(validConnectionId, revision)
        return toStatus(credential)
      })
    },
    async getAccessToken(input) {
      assertActive()
      return getFreshAccessToken(normalizeAccessTokenRequest(input))
    },
    async completeAuth(input) {
      assertActive()
      return completeAuth(normalizeAuthCodeExchangeRequest(input))
    },
    async deleteCredentials(connectionId) {
      assertActive()
      const validConnectionId = validateConnectionId(connectionId)
      invalidateCredential(validConnectionId)
      await serializeCredentialIO(() =>
        fs.rm(getCredentialPath(validConnectionId), { force: true })
      )
    },
    async waitForAuthCallback(expectedState) {
      assertActive()
      return waitForAuthCallback(validateExpectedAuthState(expectedState))
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearedAtRevision = ++credentialRevision
      refreshesByConnection.clear()
      queuedAuthCallbackUrl = null
      settleAuthCallback(null)
    }
  }
}
