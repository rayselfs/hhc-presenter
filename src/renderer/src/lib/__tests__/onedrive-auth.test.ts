import { beforeEach, describe, expect, it } from 'vitest'
import {
  createOneDriveAuthRequest,
  createOneDriveRefreshTokenBody,
  createOneDriveTokenExchangeBody,
  ONEDRIVE_READONLY_SCOPES,
  parseOneDriveAuthCallback,
  storeOneDriveProviderConnection
} from '../onedrive-auth'
import { getProviderConnection, resetSyncDBForTests } from '../sync-db'
import { putProviderConnection } from '../sync-db'

describe('onedrive-auth', () => {
  beforeEach(async () => {
    await resetSyncDBForTests()
  })

  it('uses the shared build configuration when the client ID is omitted or blank', async () => {
    for (const clientId of [undefined, '   ']) {
      const request = await createOneDriveAuthRequest({
        clientId,
        redirectUri: 'https://client.example/onedrive-callback.html',
        state: 'state',
        codeVerifier: 'verifier'
      })
      expect(request.clientId).toBe(__ONEDRIVE_CLIENT_ID__)
      expect(new URL(request.authorizationUrl).searchParams.get('client_id')).toBe(
        __ONEDRIVE_CLIENT_ID__
      )
    }
  })

  it('creates an authorization URL with PKCE and read-only scopes', async () => {
    const request = await createOneDriveAuthRequest({
      clientId: '11111111-2222-3333-4444-555555555555',
      redirectUri: 'https://app.example.com/onedrive-callback',
      state: 'state-1',
      codeVerifier: 'verifier-1',
      prompt: 'select_account'
    })
    const url = new URL(request.authorizationUrl)
    const scope = url.searchParams.get('scope') ?? ''

    expect(url.origin).toBe('https://login.microsoftonline.com')
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('client_id')).toBe('11111111-2222-3333-4444-555555555555')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('prompt')).toBe('select_account')
    expect(scope.split(' ')).toEqual([...ONEDRIVE_READONLY_SCOPES])
    expect(scope).not.toMatch(/Files\.ReadWrite|Sites\.ReadWrite|offline_write/i)
  })

  it('accepts callback codes only when state matches', () => {
    expect(
      parseOneDriveAuthCallback(
        'https://app.example.com/onedrive-callback?code=code-1&state=state-1',
        'state-1'
      )
    ).toEqual({ code: 'code-1', state: 'state-1' })

    expect(() =>
      parseOneDriveAuthCallback(
        'https://app.example.com/onedrive-callback?code=code-1&state=other',
        'state-1'
      )
    ).toThrow('Invalid OneDrive OAuth state')
  })

  it('surfaces OAuth errors before accepting a callback', () => {
    expect(() =>
      parseOneDriveAuthCallback(
        'https://app.example.com/onedrive-callback?error=access_denied&state=state-1',
        'state-1'
      )
    ).toThrow('OneDrive OAuth failed')
  })

  it('creates an authorization-code token body without a client secret', () => {
    const body = createOneDriveTokenExchangeBody({
      clientId: '11111111-2222-3333-4444-555555555555',
      redirectUri: 'https://app.example.com/onedrive-callback',
      code: 'code-1',
      codeVerifier: 'verifier-1'
    })

    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBe('verifier-1')
    expect(body.get('scope')?.split(' ')).toEqual([...ONEDRIVE_READONLY_SCOPES])
    expect(body.has('client_secret')).toBe(false)
    expect([...body.keys()].join(' ')).not.toMatch(/refresh_token|access_token/i)
  })

  it('creates a refresh-token body without a client secret', () => {
    const body = createOneDriveRefreshTokenBody({
      clientId: '11111111-2222-3333-4444-555555555555',
      refreshToken: 'refresh-token'
    })

    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh-token')
    expect(body.get('scope')?.split(' ')).toEqual([...ONEDRIVE_READONLY_SCOPES])
    expect(body.has('client_secret')).toBe(false)
  })

  it('stores only OneDrive connection metadata', async () => {
    await storeOneDriveProviderConnection({
      id: 'account-1',
      displayName: 'Alice',
      userPrincipalName: 'alice@example.com'
    })

    const connection = await getProviderConnection('onedrive:account-1')
    expect(connection).toMatchObject({
      providerType: 'onedrive',
      displayName: 'OneDrive - Alice',
      accountLabel: 'alice@example.com'
    })
    expect(connection).not.toHaveProperty('accessToken')
    expect(connection).not.toHaveProperty('refreshToken')
    expect(connection).not.toHaveProperty('authorizationCode')
    expect(connection).not.toHaveProperty('codeVerifier')
  })

  it('rejects connecting a second OneDrive account', async () => {
    await putProviderConnection({
      id: 'onedrive:account-1',
      providerType: 'onedrive',
      displayName: 'OneDrive - Alice'
    })

    await expect(
      storeOneDriveProviderConnection({
        id: 'account-2',
        displayName: 'Bob',
        userPrincipalName: 'bob@example.com'
      })
    ).rejects.toThrow('Only one OneDrive account can be connected')
  })
})
