import { APP_CONFIG } from '@shared/app-config'
import {
  listProviderConnectionsByType,
  putProviderConnection,
  type ProviderConnectionRecord
} from './sync-db'

export const ONEDRIVE_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
export const ONEDRIVE_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
export const ONEDRIVE_READONLY_SCOPES = ['offline_access', 'User.Read', 'Files.Read'] as const

export interface OneDriveAuthRequestInput {
  clientId?: string
  redirectUri: string
  state?: string
  codeVerifier?: string
  prompt?: 'select_account' | 'consent' | 'none'
}

export interface OneDriveAuthRequest {
  authorizationUrl: string
  clientId: string
  redirectUri: string
  state: string
  codeVerifier: string
  scopes: readonly string[]
}

export interface OneDriveAuthCallbackResult {
  code: string
  state: string
}

export interface OneDriveTokenExchangeInput {
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
}

export interface OneDriveRefreshTokenInput {
  clientId: string
  refreshToken: string
}

export interface OneDriveAccountProfile {
  id: string
  displayName?: string
  userPrincipalName?: string
  mail?: string
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export async function createPkceChallenge(codeVerifier: string): Promise<string> {
  const encoded = encodeUtf8(codeVerifier)
  const buffer = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return base64UrlEncode(new Uint8Array(digest))
}

export function createPkceVerifier(): string {
  return randomBase64Url(64)
}

export function createOAuthState(): string {
  return randomBase64Url(32)
}

export async function createOneDriveAuthRequest(
  input: OneDriveAuthRequestInput
): Promise<OneDriveAuthRequest> {
  const clientId = input.clientId?.trim() || APP_CONFIG.oneDriveClientId
  const state = input.state ?? createOAuthState()
  const codeVerifier = input.codeVerifier ?? createPkceVerifier()
  const codeChallenge = await createPkceChallenge(codeVerifier)
  const url = new URL(ONEDRIVE_AUTHORITY)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', ONEDRIVE_READONLY_SCOPES.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (input.prompt) url.searchParams.set('prompt', input.prompt)

  return {
    authorizationUrl: url.toString(),
    clientId,
    redirectUri: input.redirectUri,
    state,
    codeVerifier,
    scopes: ONEDRIVE_READONLY_SCOPES
  }
}

export function parseOneDriveAuthCallback(
  callbackUrl: string,
  expectedState: string
): OneDriveAuthCallbackResult {
  const url = new URL(callbackUrl)
  const returnedState = url.searchParams.get('state')
  if (!returnedState || returnedState !== expectedState) {
    throw new Error('Invalid OneDrive OAuth state')
  }

  const error = url.searchParams.get('error')
  if (error) {
    const description = url.searchParams.get('error_description')
    throw new Error(
      description ? `OneDrive OAuth failed: ${description}` : `OneDrive OAuth failed: ${error}`
    )
  }

  const code = url.searchParams.get('code')
  if (!code) throw new Error('Missing OneDrive OAuth code')

  return { code, state: returnedState }
}

export function createOneDriveTokenExchangeBody(
  input: OneDriveTokenExchangeInput
): URLSearchParams {
  const body = new URLSearchParams()
  body.set('client_id', input.clientId)
  body.set('grant_type', 'authorization_code')
  body.set('code', input.code)
  body.set('redirect_uri', input.redirectUri)
  body.set('code_verifier', input.codeVerifier)
  body.set('scope', ONEDRIVE_READONLY_SCOPES.join(' '))
  return body
}

export function createOneDriveRefreshTokenBody(input: OneDriveRefreshTokenInput): URLSearchParams {
  const body = new URLSearchParams()
  body.set('client_id', input.clientId)
  body.set('grant_type', 'refresh_token')
  body.set('refresh_token', input.refreshToken)
  body.set('scope', ONEDRIVE_READONLY_SCOPES.join(' '))
  return body
}

export async function storeOneDriveProviderConnection(
  profile: OneDriveAccountProfile
): Promise<ProviderConnectionRecord> {
  const existing = await listProviderConnectionsByType('onedrive')
  const nextId = `onedrive:${profile.id}`
  const existingOtherAccount = existing.find((connection) => connection.id !== nextId)
  if (existingOtherAccount) {
    throw new Error('Only one OneDrive account can be connected')
  }

  const accountLabel = profile.userPrincipalName || profile.mail || profile.displayName
  return putProviderConnection({
    id: nextId,
    providerType: 'onedrive',
    displayName: profile.displayName ? `OneDrive - ${profile.displayName}` : 'OneDrive',
    accountLabel
  })
}
