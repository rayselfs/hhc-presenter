import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const {
  handlers,
  mockDecryptString,
  mockEncryptString,
  mockGetSelectedStorageBackend,
  mockIsEncryptionAvailable,
  mockMkdir,
  mockNetFetch,
  mockOpenExternal,
  mockReadFile,
  mockRename,
  mockRm,
  mockWriteFile
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockDecryptString: vi.fn(),
  mockEncryptString: vi.fn(),
  mockGetSelectedStorageBackend: vi.fn(),
  mockIsEncryptionAvailable: vi.fn(),
  mockMkdir: vi.fn(),
  mockNetFetch: vi.fn(),
  mockOpenExternal: vi.fn(),
  mockReadFile: vi.fn(),
  mockRename: vi.fn(),
  mockRm: vi.fn(),
  mockWriteFile: vi.fn()
}))

const mainWindow = { id: 1 }
const projectionWindow = { id: 2 }

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/hhc-user-data') },
  BrowserWindow: { fromWebContents: vi.fn(() => mainWindow) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  },
  net: { fetch: mockNetFetch },
  safeStorage: {
    decryptString: mockDecryptString,
    encryptString: mockEncryptString,
    getSelectedStorageBackend: mockGetSelectedStorageBackend,
    isEncryptionAvailable: mockIsEncryptionAvailable
  },
  shell: { openExternal: mockOpenExternal }
}))

vi.mock('node:fs', () => {
  const promises = {
    mkdir: mockMkdir,
    readFile: mockReadFile,
    rename: mockRename,
    rm: mockRm,
    writeFile: mockWriteFile
  }
  return { default: { promises }, promises }
})

import { BrowserWindow } from 'electron'
import type { HhcSession } from '@shared/hhc-auth'
import type { WindowManager } from '../../windowManager'
import { createHhcAuthService, registerHhcAuthIpc, type HhcAuthService } from '../../ipc/hhc-auth'

const credentialPath = '/tmp/hhc-user-data/hhc-auth.enc'
let disk: Buffer | null
let temporaryFiles: Map<string, Buffer>
let plaintextByCiphertext: Map<string, string>
let ciphertextSequence: number
let now: number

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function accessToken(userId = 'user-1', expiresAt = now + 60 * 60_000): string {
  const claims = Buffer.from(
    JSON.stringify({ sub: userId, roles: ['media_sync_user'], exp: expiresAt / 1000 })
  ).toString('base64url')
  return `header.${claims}.signature`
}

function tokenResponse(refreshToken: string, userId = 'user-1'): Response {
  return jsonResponse({
    access_token: accessToken(userId),
    refresh_token: refreshToken,
    expires_in: 3600,
    token_type: 'Bearer'
  })
}

function profileResponse(userId = 'user-1'): Response {
  return jsonResponse({
    id: userId,
    email: 'alice@example.com',
    first_name: ' Alice ',
    last_name: ' Chen ',
    avatar_url: 'https://account.example/avatar.png',
    roles: ['ignored-server-role'],
    permissions: []
  })
}

function bodyAt(index: number): URLSearchParams {
  const body = mockNetFetch.mock.calls[index]?.[1]?.body
  if (!(body instanceof URLSearchParams)) throw new Error('Expected form body')
  return body
}

function currentStoredRecord(): { installationId: string; refreshToken?: string } {
  if (!disk) throw new Error('Expected encrypted record')
  return JSON.parse(mockDecryptString(disk)) as {
    installationId: string
    refreshToken?: string
  }
}

function deferNextCredentialWrite(): Promise<() => void> {
  return new Promise((writeStarted) => {
    mockRename.mockImplementationOnce(
      (source: string, target: string) =>
        new Promise<void>((resolve) => {
          writeStarted(() => {
            const value = temporaryFiles.get(source)
            if (!value) throw new Error('Missing deferred credential')
            if (target === credentialPath) disk = value
            temporaryFiles.delete(source)
            resolve()
          })
        })
    )
  })
}

function callbackFromOpenedUrl(): { kind: 'account-auth'; code: string; state: string } {
  const opened = new URL(mockOpenExternal.mock.calls.at(-1)?.[0] as string)
  return {
    kind: 'account-auth',
    code: 'authorization-code',
    state: opened.searchParams.get('state')!
  }
}

function makeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

async function seedAccessWithoutSession(service: HhcAuthService): Promise<void> {
  await service.begin()
  mockNetFetch
    .mockResolvedValueOnce(tokenResponse('refresh-1'))
    .mockResolvedValueOnce(jsonResponse({}, 503))
  await expect(service.completeProtocolCallback(callbackFromOpenedUrl())).rejects.toThrow(
    'HHC account request failed'
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const mock of [
    mockDecryptString,
    mockEncryptString,
    mockGetSelectedStorageBackend,
    mockIsEncryptionAvailable,
    mockMkdir,
    mockNetFetch,
    mockOpenExternal,
    mockReadFile,
    mockRename,
    mockRm,
    mockWriteFile
  ]) {
    mock.mockReset()
  }
  handlers.clear()
  disk = null
  temporaryFiles = new Map()
  plaintextByCiphertext = new Map()
  ciphertextSequence = 0
  now = Date.UTC(2026, 7, 16, 4, 0, 0)

  mockIsEncryptionAvailable.mockReturnValue(true)
  mockGetSelectedStorageBackend.mockReturnValue('keychain')
  mockMkdir.mockResolvedValue(undefined)
  mockReadFile.mockImplementation(async (path: string) => {
    if (path === credentialPath && disk) return disk
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  mockEncryptString.mockImplementation((plaintext: string) => {
    const ciphertext = Buffer.from(`ciphertext-${++ciphertextSequence}`)
    plaintextByCiphertext.set(ciphertext.toString('hex'), plaintext)
    return ciphertext
  })
  mockDecryptString.mockImplementation((ciphertext: Buffer) => {
    const plaintext = plaintextByCiphertext.get(ciphertext.toString('hex'))
    if (!plaintext) throw new Error('Unable to decrypt')
    return plaintext
  })
  mockWriteFile.mockImplementation(
    async (path: string, value: Buffer) => void temporaryFiles.set(path, value)
  )
  mockRename.mockImplementation(async (source: string, target: string) => {
    const value = temporaryFiles.get(source)
    if (!value) throw new Error('Missing temporary credential')
    if (target === credentialPath) disk = value
    temporaryFiles.delete(source)
  })
  mockRm.mockImplementation(async (path: string) => {
    if (path === credentialPath) disk = null
    temporaryFiles.delete(path)
  })
  mockOpenExternal.mockResolvedValue(undefined)
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mainWindow as never)
})

describe('HhcAuthService authorization', () => {
  it('creates exact PKCE authorization and token forms with one stable installation id', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()

    const authorize = new URL(mockOpenExternal.mock.calls[0][0] as string)
    expect(authorize.origin).toBe('https://account.alive.org.tw')
    expect(authorize.pathname).toBe('/api/account/v1/oauth/authorize')
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'hhc-desktop',
      redirect_uri: 'hhc-presenter://auth/account',
      response_type: 'code',
      code_challenge_method: 'S256',
      scope: 'openid profile presenter:cloud:manage'
    })
    expect(authorize.searchParams.get('state')).toBeTruthy()
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy()

    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await expect(service.completeProtocolCallback(callbackFromOpenedUrl())).resolves.toBe(true)

    expect(mockNetFetch.mock.calls[0][0]).toBe(
      'https://account.alive.org.tw/api/account/v1/oauth/token'
    )
    const tokenBody = bodyAt(0)
    expect(Object.fromEntries(tokenBody)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'hhc-desktop',
      redirect_uri: 'hhc-presenter://auth/account',
      code_verifier: expect.any(String),
      code: 'authorization-code',
      device_id: expect.any(String),
      device_name: expect.stringContaining('HHC Presenter Electron')
    })
    expect(createHash('sha256').update(tokenBody.get('code_verifier')!).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge')
    )
    expect(currentStoredRecord()).toEqual({
      installationId: tokenBody.get('device_id'),
      refreshToken: 'refresh-1'
    })
  })

  it('returns shared expiry metadata and replaces an unconsumed transaction immediately', async () => {
    const service = createHhcAuthService({ now: () => now })
    await expect(service.begin()).resolves.toEqual({
      expiresAt: now + 300_000
    })
    const abandonedCallback = callbackFromOpenedUrl()

    await expect(service.begin()).resolves.toEqual({
      expiresAt: now + 300_000
    })
    const replacementCallback = callbackFromOpenedUrl()
    await expect(
      service.completeProtocolCallback({ ...replacementCallback, state: 'wrong-state' })
    ).resolves.toBe(false)
    await expect(service.completeProtocolCallback(abandonedCallback)).resolves.toBe(false)

    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await expect(service.completeProtocolCallback(replacementCallback)).resolves.toBe(true)
    expect(mockOpenExternal).toHaveBeenCalledTimes(2)
  })

  it('lets cancel win while openExternal is pending and ignores the late callback', async () => {
    const service = createHhcAuthService({ now: () => now })
    let finishOpen!: () => void
    mockOpenExternal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve
        })
    )
    const beginning = service.begin()
    await vi.waitFor(() => expect(mockOpenExternal).toHaveBeenCalledOnce())
    const cancelledCallback = callbackFromOpenedUrl()

    await service.cancelSignIn()
    finishOpen()
    await beginning

    await expect(service.completeProtocolCallback(cancelledCallback)).resolves.toBe(false)
    expect(mockNetFetch).not.toHaveBeenCalled()
  })

  it('replaces a transaction while its openExternal call is still pending', async () => {
    const service = createHhcAuthService({ now: () => now })
    let finishAbandonedOpen!: () => void
    mockOpenExternal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishAbandonedOpen = resolve
        })
    )
    const abandonedBegin = service.begin()
    await vi.waitFor(() => expect(mockOpenExternal).toHaveBeenCalledOnce())
    const abandonedCallback = callbackFromOpenedUrl()

    await service.begin()
    const replacementCallback = callbackFromOpenedUrl()
    await expect(service.completeProtocolCallback(abandonedCallback)).resolves.toBe(false)
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('replacement-refresh'))
      .mockResolvedValueOnce(profileResponse())
    await expect(service.completeProtocolCallback(replacementCallback)).resolves.toBe(true)

    finishAbandonedOpen()
    await abandonedBegin
  })

  it('shares first credential initialization across cancel and immediate retry', async () => {
    const service = createHhcAuthService({ now: () => now })
    let rejectInitialRead!: (reason: Error) => void
    mockReadFile.mockImplementationOnce(
      () =>
        new Promise<Buffer>((_resolve, reject) => {
          rejectInitialRead = reject
        })
    )

    const abandonedBegin = service.begin()
    await vi.waitFor(() => expect(mockReadFile).toHaveBeenCalledOnce())
    await service.cancelSignIn()
    const replacementBegin = service.begin()
    await Promise.resolve()
    await Promise.resolve()
    rejectInitialRead(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    await Promise.all([abandonedBegin, replacementBegin])
    expect(mockReadFile).toHaveBeenCalledOnce()
    expect(mockWriteFile).toHaveBeenCalledOnce()
    expect(mockOpenExternal).toHaveBeenCalledOnce()
  })

  it('invalidates a transaction cancelled after the system browser opens', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    const cancelledCallback = callbackFromOpenedUrl()

    await service.cancelSignIn()

    await expect(service.completeProtocolCallback(cancelledCallback)).resolves.toBe(false)
    expect(mockNetFetch).not.toHaveBeenCalled()
  })

  it('keeps token completion exclusive from replacement sign-in', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    const callback = callbackFromOpenedUrl()
    let resolveToken!: (response: Response) => void
    mockNetFetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveToken = resolve)))
      .mockResolvedValueOnce(profileResponse())

    const completion = service.completeProtocolCallback(callback)
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledOnce())

    await expect(service.begin()).rejects.toThrow('HHC sign-in is already in progress')
    resolveToken(tokenResponse('refresh-1'))
    await expect(completion).resolves.toBe(true)
  })

  it('expires state after five minutes and consumes a match before network completion', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    const expiredCallback = callbackFromOpenedUrl()
    now += 5 * 60_000 + 1

    await expect(service.completeProtocolCallback(expiredCallback)).resolves.toBe(false)
    await expect(service.begin()).resolves.toEqual({
      expiresAt: now + 300_000
    })
    const activeCallback = callbackFromOpenedUrl()

    let resolveToken!: (response: Response) => void
    mockNetFetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveToken = resolve)))
      .mockResolvedValueOnce(profileResponse())
    const completion = service.completeProtocolCallback(activeCallback)
    await expect(service.completeProtocolCallback(activeCallback)).resolves.toBe(false)
    resolveToken(tokenResponse('refresh-1'))
    await expect(completion).resolves.toBe(true)
    expect(mockNetFetch).toHaveBeenCalledTimes(2)
  })

  it('invalidates a pending callback and waits for an in-flight begin during sign-out', async () => {
    const service = createHhcAuthService({ now: () => now })
    let finishOpen!: () => void
    mockOpenExternal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve
        })
    )
    const beginning = service.begin()
    await vi.waitFor(() => expect(mockOpenExternal).toHaveBeenCalledOnce())
    const callback = callbackFromOpenedUrl()
    const installationId = currentStoredRecord().installationId

    let signOutSettled = false
    const signOut = service.signOut().finally(() => {
      signOutSettled = true
    })
    await expect(service.begin()).rejects.toThrow('HHC sign-in is already in progress')
    await expect(service.completeProtocolCallback(callback)).resolves.toBe(false)
    await Promise.resolve()
    expect(signOutSettled).toBe(false)
    finishOpen()
    await beginning
    await signOut
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('late-refresh'))
      .mockResolvedValueOnce(profileResponse())

    await expect(service.completeProtocolCallback(callback)).resolves.toBe(false)
    expect(mockNetFetch).not.toHaveBeenCalled()
    expect(currentStoredRecord()).toEqual({ installationId })
  })

  it('fails closed with no write when encryption is unavailable', async () => {
    mockIsEncryptionAvailable.mockReturnValue(false)
    const service = createHhcAuthService({ now: () => now })

    await expect(service.begin()).rejects.toThrow('Secure credential storage is unavailable')
    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(mockOpenExternal).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'win32'] as NodeJS.Platform[])(
    'does not query the Linux storage backend on %s',
    async (platform) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      mockGetSelectedStorageBackend.mockImplementation(() => {
        throw new TypeError('getSelectedStorageBackend is unavailable')
      })

      try {
        const service = createHhcAuthService({ now: () => now })

        await expect(service.begin()).resolves.toEqual({
          expiresAt: now + 300_000
        })
        expect(mockGetSelectedStorageBackend).not.toHaveBeenCalled()
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

  it.each([
    ['basic_text', true],
    ['gnome_libsecret', false]
  ])('rejects Linux %s storage: %s', async (backend, rejected) => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockGetSelectedStorageBackend.mockReturnValue(backend)

    try {
      const service = createHhcAuthService({ now: () => now })
      const beginning = service.begin()

      if (rejected) {
        await expect(beginning).rejects.toThrow('Secure credential storage is unavailable')
        expect(mockWriteFile).not.toHaveBeenCalled()
        expect(mockOpenExternal).not.toHaveBeenCalled()
      } else {
        await expect(beginning).resolves.toEqual({
          expiresAt: now + 300_000
        })
      }
    } finally {
      platformSpy.mockRestore()
    }
  })
})

describe('HhcAuthService credentials and session', () => {
  it('rejects a malformed profile permission list without granting the legacy flag', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch.mockResolvedValueOnce(tokenResponse('refresh-1')).mockResolvedValueOnce(
      jsonResponse({
        id: 'user-1',
        email: 'alice@example.com',
        presenter_cloud_access: true,
        permissions: ['*', true]
      })
    )
    await expect(service.completeProtocolCallback(callbackFromOpenedUrl())).rejects.toThrow(
      'Invalid HHC account permissions'
    )
  })

  it('does not access secure storage when no credential exists', async () => {
    const service = createHhcAuthService({ now: () => now })

    await expect(service.getSession()).resolves.toBeNull()
    expect(mockReadFile).toHaveBeenCalledWith(credentialPath)
    expect(mockIsEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('writes only ciphertext through a same-directory atomic replace with mode 0600', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('plaintext-refresh'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())

    const [temporaryPath, ciphertext, options] = mockWriteFile.mock.calls.at(-1)!
    expect(temporaryPath).toMatch(/^\/tmp\/hhc-user-data\/hhc-auth\.enc\./)
    expect((ciphertext as Buffer).toString()).not.toContain('plaintext-refresh')
    expect(options).toEqual({ mode: 0o600 })
    expect(mockRename).toHaveBeenLastCalledWith(temporaryPath, credentialPath)
  })

  it('cleans a failed temporary replace without deleting the prior ciphertext', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    const priorCiphertext = disk
    mockRename.mockRejectedValueOnce(new Error('rename failed'))
    mockNetFetch.mockResolvedValueOnce(tokenResponse('refresh-1'))

    await expect(service.completeProtocolCallback(callbackFromOpenedUrl())).rejects.toThrow(
      'rename failed'
    )
    expect(disk).toBe(priorCiphertext)
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining('hhc-auth.enc.'), { force: true })
  })

  it('maps /me only after token claim validation and clears credentials on subject mismatch', async () => {
    const service = createHhcAuthService({ now: () => now })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())

    await service.completeProtocolCallback(callbackFromOpenedUrl())
    await expect(service.getSession()).resolves.toEqual({
      userId: 'user-1',
      displayName: 'Alice Chen',
      avatarUrl: 'https://account.example/avatar.png',
      roles: ['media_sync_user'],
      permissions: []
    })
    expect(mockNetFetch.mock.calls[1][0]).toBe('https://account.alive.org.tw/api/account/v1/me')
    expect(mockNetFetch.mock.calls[1][1].headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer /)
    })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }))

    const mismatched = createHhcAuthService({ now: () => now })
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-2'))
      .mockResolvedValueOnce(profileResponse('other-user'))
    await expect(mismatched.getSession()).rejects.toThrow('HHC account identity mismatch')
    expect(currentStoredRecord()).not.toHaveProperty('refreshToken')
  })

  it('keeps rotated credentials when /me fails transiently', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(jsonResponse({}, 503))

    await expect(service.completeProtocolCallback(callbackFromOpenedUrl())).rejects.toThrow(
      'HHC account request failed'
    )
    expect(currentStoredRecord()).toMatchObject({ refreshToken: 'refresh-1' })

    mockNetFetch.mockResolvedValueOnce(profileResponse())
    await expect(service.getAccessToken()).resolves.toBeTruthy()
    expect(mockNetFetch.mock.calls[2][0]).toBe('https://account.alive.org.tw/api/account/v1/me')
  })

  it('does not publish a deferred profile after local data clearing begins', async () => {
    const service = createHhcAuthService({ now: () => now })
    const listener = vi.fn()
    service.subscribe(listener)
    await seedAccessWithoutSession(service)

    let resolveProfile!: (response: Response) => void
    mockNetFetch
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => void (resolveProfile = resolve))
      )
      .mockResolvedValueOnce(jsonResponse({}))
    const profile = service.getSession()
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledTimes(3))

    const clear = service.clearLocalData()
    resolveProfile(profileResponse())
    const [profileResult, clearResult] = await Promise.allSettled([profile, clear])

    expect(profileResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'HHC authentication changed' })
    })
    expect(clearResult).toEqual({ status: 'fulfilled', value: undefined })
    expect(listener.mock.calls.some(([session]) => session !== null)).toBe(false)
    await expect(service.getSession()).resolves.toBeNull()
    await expect(service.getAccessToken()).resolves.toBeNull()
    expect(disk).toBeNull()
  })

  it('does not recreate credentials from a deferred identity mismatch', async () => {
    const service = createHhcAuthService({ now: () => now })
    await seedAccessWithoutSession(service)

    let resolveProfile!: (response: Response) => void
    mockNetFetch
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => void (resolveProfile = resolve))
      )
      .mockResolvedValueOnce(jsonResponse({}))
    const profile = service.getSession()
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledTimes(3))
    const writesBeforeClear = mockWriteFile.mock.calls.length

    const clear = service.clearLocalData()
    resolveProfile(profileResponse('other-user'))
    const [profileResult, clearResult] = await Promise.allSettled([profile, clear])

    expect(profileResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'HHC authentication changed' })
    })
    expect(clearResult).toEqual({ status: 'fulfilled', value: undefined })
    expect(mockWriteFile).toHaveBeenCalledTimes(writesBeforeClear)
    expect(disk).toBeNull()
  })

  it('waits for identity-mismatch credential cleanup before the final wipe', async () => {
    const service = createHhcAuthService({ now: () => now })
    await seedAccessWithoutSession(service)

    const credentialWrite = deferNextCredentialWrite()
    mockNetFetch
      .mockResolvedValueOnce(profileResponse('other-user'))
      .mockResolvedValueOnce(jsonResponse({}))
    const profile = service.getSession()
    const finishCredentialWrite = await credentialWrite

    let clearSettled = false
    const clear = service.clearLocalData().then(
      () => void (clearSettled = true),
      () => void (clearSettled = true)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const clearSettledBeforeCredentialWrite = clearSettled
    finishCredentialWrite()
    const [profileResult, clearResult] = await Promise.allSettled([profile, clear])

    expect(clearSettledBeforeCredentialWrite).toBe(false)
    expect(profileResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'HHC account identity mismatch' })
    })
    expect(clearResult).toEqual({ status: 'fulfilled', value: undefined })
    const revokeCalls = mockNetFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/oauth/revoke')
    )
    expect(revokeCalls).toHaveLength(1)
    const revokeBody = revokeCalls[0]?.[1]?.body
    expect(revokeBody).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries(revokeBody as URLSearchParams)).toEqual({
      token: 'refresh-1',
      client_id: 'hhc-desktop',
      token_type_hint: 'refresh_token'
    })
    expect(disk).toBeNull()
  })

  it('captures a completed authorization token before mismatched profile cleanup', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()

    let resolveProfile!: (response: Response) => void
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('authorization-refresh'))
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => void (resolveProfile = resolve))
      )
      .mockResolvedValueOnce(jsonResponse({}))
    const completion = service.completeProtocolCallback(callbackFromOpenedUrl())
    await vi.waitFor(() =>
      expect(currentStoredRecord()).toMatchObject({ refreshToken: 'authorization-refresh' })
    )

    const credentialWrite = deferNextCredentialWrite()
    resolveProfile(profileResponse('other-user'))
    const finishCredentialWrite = await credentialWrite

    let clearSettled = false
    const clear = service.clearLocalData().finally(() => {
      clearSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(clearSettled).toBe(false)
    finishCredentialWrite()
    const [completionResult, clearResult] = await Promise.allSettled([completion, clear])

    expect(completionResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'HHC account identity mismatch' })
    })
    expect(clearResult).toEqual({ status: 'fulfilled', value: undefined })
    const revokeCalls = mockNetFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/oauth/revoke')
    )
    expect(revokeCalls).toHaveLength(1)
    const revokeBody = revokeCalls[0]?.[1]?.body
    expect(revokeBody).toBeInstanceOf(URLSearchParams)
    expect((revokeBody as URLSearchParams).get('token')).toBe('authorization-refresh')
    expect(disk).toBeNull()
    await expect(service.getSession()).resolves.toBeNull()
    await expect(service.getAccessToken()).resolves.toBeNull()
  })

  it('captures a rotated refresh token before mismatched profile cleanup', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    now += 2 * 60 * 60_000

    let resolveProfile!: (response: Response) => void
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-2'))
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => void (resolveProfile = resolve))
      )
      .mockResolvedValueOnce(jsonResponse({}))
    const refresh = service.getAccessToken()
    await vi.waitFor(() =>
      expect(currentStoredRecord()).toMatchObject({ refreshToken: 'refresh-2' })
    )

    const credentialWrite = deferNextCredentialWrite()
    resolveProfile(profileResponse('other-user'))
    const finishCredentialWrite = await credentialWrite

    let clearSettled = false
    const clear = service.clearLocalData().finally(() => {
      clearSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(clearSettled).toBe(false)
    finishCredentialWrite()
    const [refreshResult, clearResult] = await Promise.allSettled([refresh, clear])

    expect(refreshResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'HHC account identity mismatch' })
    })
    expect(clearResult).toEqual({ status: 'fulfilled', value: undefined })
    const revokeCalls = mockNetFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/oauth/revoke')
    )
    expect(revokeCalls).toHaveLength(1)
    const revokeBody = revokeCalls[0]?.[1]?.body
    expect(revokeBody).toBeInstanceOf(URLSearchParams)
    expect((revokeBody as URLSearchParams).get('token')).toBe('refresh-2')
    expect(disk).toBeNull()
    await expect(service.getSession()).resolves.toBeNull()
    await expect(service.getAccessToken()).resolves.toBeNull()
  })

  it('waits for refresh persistence before choosing the revocation token', async () => {
    const service = createHhcAuthService({ now: () => now })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    listener.mockClear()
    now += 2 * 60 * 60_000

    let resolveRefresh!: (response: Response) => void
    mockNetFetch.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return new Promise<Response>((resolve) => void (resolveRefresh = resolve))
      }
      if (url.endsWith('/me')) return Promise.resolve(profileResponse())
      if (url.endsWith('/oauth/revoke')) return Promise.resolve(jsonResponse({}))
      throw new Error(`Unexpected HHC request: ${url}`)
    })
    const refresh = service.getAccessToken()
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledTimes(3))

    const clear = service.clearLocalData()
    await Promise.resolve()
    expect(mockRm).not.toHaveBeenCalledWith(credentialPath, { force: true })
    resolveRefresh(tokenResponse('refresh-2'))
    const [refreshResult, clearResult] = await Promise.allSettled([refresh, clear])

    expect(refreshResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'HHC authentication changed' })
    })
    expect(clearResult).toEqual({ status: 'fulfilled', value: undefined })
    const revokeCalls = mockNetFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/oauth/revoke')
    )
    expect(revokeCalls).toHaveLength(1)
    const revokeBody = revokeCalls[0]?.[1]?.body
    expect(revokeBody).toBeInstanceOf(URLSearchParams)
    expect((revokeBody as URLSearchParams).get('token')).toBe('refresh-2')
    expect(listener.mock.calls.some(([session]) => session !== null)).toBe(false)
    expect(disk).toBeNull()
  })

  it('coalesces refresh, rotates atomically, and restores the same installation id', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    const installationId = currentStoredRecord().installationId

    now += 2 * 60 * 60_000
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-2'))
      .mockResolvedValueOnce(profileResponse())
    const [first, second] = await Promise.all([service.getAccessToken(), service.getAccessToken()])
    expect(first).toBe(second)
    expect(mockNetFetch).toHaveBeenCalledTimes(4)
    expect(Object.fromEntries(bodyAt(2))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'hhc-desktop',
      refresh_token: 'refresh-1',
      device_id: installationId,
      device_name: expect.stringContaining('HHC Presenter Electron')
    })
    expect(currentStoredRecord()).toEqual({ installationId, refreshToken: 'refresh-2' })

    const restarted = createHhcAuthService({ now: () => now })
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-3'))
      .mockResolvedValueOnce(profileResponse())
    await expect(restarted.getSession()).resolves.toMatchObject({ userId: 'user-1' })
    expect(bodyAt(4).get('device_id')).toBe(installationId)
    expect(currentStoredRecord()).toEqual({ installationId, refreshToken: 'refresh-3' })
  })

  it('explicitly refreshes a still-valid cached access token and coalesces callers', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    const cached = await service.getAccessToken()

    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-2'))
      .mockResolvedValueOnce(profileResponse())
    const [first, second] = await Promise.all([
      service.refreshAccessToken(),
      service.refreshAccessToken()
    ])

    expect(first).toBe(second)
    expect(first).toBeTruthy()
    expect(cached).toBeTruthy()
    expect(mockNetFetch).toHaveBeenCalledTimes(4)
    expect(Object.fromEntries(bodyAt(2))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1'
    })
    expect(currentStoredRecord()).toMatchObject({ refreshToken: 'refresh-2' })
  })

  it('clears invalid refresh credentials while preserving the installation id', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    const installationId = currentStoredRecord().installationId
    now += 2 * 60 * 60_000
    mockNetFetch.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400))

    await expect(service.getAccessToken()).rejects.toThrow('HHC account request failed')
    expect(currentStoredRecord()).toEqual({ installationId })
  })

  it('revokes the refresh family and clears tokens even when remote revoke fails', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    const installationId = currentStoredRecord().installationId
    mockNetFetch.mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))

    await expect(service.signOut()).resolves.toBeUndefined()
    const revokeBody = bodyAt(2)
    expect(mockNetFetch.mock.calls[2][0]).toBe(
      'https://account.alive.org.tw/api/account/v1/oauth/revoke'
    )
    expect(Object.fromEntries(revokeBody)).toEqual({
      token: 'refresh-1',
      client_id: 'hhc-desktop',
      token_type_hint: 'refresh_token'
    })
    expect(currentStoredRecord()).toEqual({ installationId })

    await service.begin()
    expect(currentStoredRecord().installationId).toBe(installationId)
  })

  it('waits for refresh rotation before revoking during sign-out', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    now += 2 * 60 * 60_000

    let resolveRefresh!: (response: Response) => void
    mockNetFetch.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return new Promise<Response>((resolve) => (resolveRefresh = resolve))
      }
      if (url.endsWith('/me')) return Promise.resolve(profileResponse())
      return Promise.resolve(jsonResponse({}))
    })
    const refresh = service.getAccessToken()
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledTimes(3))
    const signOut = service.signOut()
    await Promise.resolve()
    expect(mockNetFetch).toHaveBeenCalledTimes(3)
    resolveRefresh(tokenResponse('refresh-2'))

    await expect(refresh).resolves.toBeTruthy()
    await expect(signOut).resolves.toBeUndefined()
    expect(bodyAt(4).get('token')).toBe('refresh-2')
    expect(currentStoredRecord()).not.toHaveProperty('refreshToken')
  })

  it('waits for a standalone profile cleanup before sign-out allows another sign-in', async () => {
    const service = createHhcAuthService({ now: () => now })
    await seedAccessWithoutSession(service)
    const installationId = currentStoredRecord().installationId
    const credentialWrite = deferNextCredentialWrite()
    mockNetFetch
      .mockResolvedValueOnce(profileResponse('other-user'))
      .mockResolvedValueOnce(jsonResponse({}))
    const profile = service.getSession()
    const finishCredentialWrite = await credentialWrite

    let signOutSettled = false
    const signOut = service.signOut().finally(() => {
      signOutSettled = true
    })
    await Promise.resolve()

    expect(signOutSettled).toBe(false)
    await expect(service.begin()).rejects.toThrow('HHC sign-in is already in progress')
    finishCredentialWrite()
    await expect(profile).rejects.toThrow('HHC account identity mismatch')
    await expect(signOut).resolves.toBeUndefined()
    await expect(service.begin()).resolves.toEqual({ expiresAt: now + 300_000 })
    expect(currentStoredRecord()).toEqual({ installationId })
  })

  it('keeps callback completion single-flight until sign-out cleanup', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    const callback = callbackFromOpenedUrl()
    const installationId = currentStoredRecord().installationId

    let resolveToken!: (response: Response) => void
    mockNetFetch.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return new Promise<Response>((resolve) => (resolveToken = resolve))
      }
      if (url.endsWith('/me')) return Promise.resolve(profileResponse())
      if (url.endsWith('/oauth/revoke')) return Promise.resolve(jsonResponse({}))
      throw new Error(`Unexpected HHC request: ${url}`)
    })

    let finishCredentialWrite!: () => void
    mockRename.mockImplementationOnce(
      (source: string, target: string) =>
        new Promise<void>((resolve) => {
          finishCredentialWrite = () => {
            const value = temporaryFiles.get(source)
            if (!value) throw new Error('Missing deferred credential')
            if (target === credentialPath) disk = value
            temporaryFiles.delete(source)
            resolve()
          }
        })
    )

    const completion = service.completeProtocolCallback(callback)
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledTimes(1))
    await expect(service.begin()).rejects.toThrow('HHC sign-in is already in progress')
    expect(mockOpenExternal).toHaveBeenCalledOnce()
    await expect(service.completeProtocolCallback(callback)).resolves.toBe(false)
    let signOutSettled = false
    const signOut = service.signOut().finally(() => {
      signOutSettled = true
    })

    resolveToken(tokenResponse('refresh-from-callback'))
    await vi.waitFor(() => expect(mockRename).toHaveBeenCalledTimes(2))
    expect(signOutSettled).toBe(false)
    finishCredentialWrite()

    await expect(completion).resolves.toBe(true)
    await expect(signOut).resolves.toBeUndefined()
    expect(Object.fromEntries(bodyAt(2))).toEqual({
      token: 'refresh-from-callback',
      client_id: 'hhc-desktop',
      token_type_hint: 'refresh_token'
    })
    expect(currentStoredRecord()).toEqual({ installationId })
    await expect(service.getAccessToken()).resolves.toBeNull()
    await expect(service.getSession()).resolves.toBeNull()
  })

  it('does not report clean sign-out when local token removal fails', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    mockNetFetch.mockResolvedValueOnce(jsonResponse({}))
    mockRename.mockRejectedValueOnce(new Error('local write failed'))

    await expect(service.signOut()).rejects.toThrow('local write failed')
    expect(currentStoredRecord()).toHaveProperty('refreshToken', 'refresh-1')
  })

  it('removes the complete credential record and cached session', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
      .mockResolvedValueOnce(jsonResponse({}))
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    await expect(service.getSession()).resolves.toMatchObject({ userId: 'user-1' })
    expect(currentStoredRecord()).toMatchObject({ refreshToken: 'refresh-1' })

    await service.clearLocalData()

    expect(mockNetFetch.mock.calls[2][0]).toBe(
      'https://account.alive.org.tw/api/account/v1/oauth/revoke'
    )
    expect(bodyAt(2).get('token')).toBe('refresh-1')
    expect(disk).toBeNull()
    await expect(service.getAccessToken()).resolves.toBeNull()
    await expect(service.getSession()).resolves.toBeNull()
  })

  it('deletes local credentials before waiting for remote revoke during data clear', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    let finishRevoke!: (response: Response) => void
    mockNetFetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => void (finishRevoke = resolve))
    )

    const clearing = service.clearLocalData()

    await vi.waitFor(() => expect(mockRm).toHaveBeenCalledWith(credentialPath, { force: true }))
    expect(disk).toBeNull()
    const revokeOptions = mockNetFetch.mock.calls[2][1]
    expect(revokeOptions.signal).toBeInstanceOf(AbortSignal)
    finishRevoke(jsonResponse({}))
    await expect(clearing).resolves.toBeUndefined()
  })

  it('invalidates a pending completion after capturing its persisted token', async () => {
    const service = createHhcAuthService({ now: () => now })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.begin()
    const callback = callbackFromOpenedUrl()
    let resolveToken!: (response: Response) => void
    mockNetFetch.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return new Promise<Response>((resolve) => {
          resolveToken = resolve
        })
      }
      if (url.endsWith('/me')) return Promise.resolve(profileResponse())
      if (url.endsWith('/oauth/revoke')) return Promise.resolve(jsonResponse({}))
      throw new Error(`Unexpected HHC request: ${url}`)
    })

    const completion = service.completeProtocolCallback(callback)
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledOnce())
    const clear = service.clearLocalData()
    await Promise.resolve()
    expect(mockRm).not.toHaveBeenCalledWith(credentialPath, { force: true })

    resolveToken(tokenResponse('late-refresh'))
    await expect(completion).rejects.toThrow('HHC authentication changed')
    await expect(clear).resolves.toBeUndefined()
    expect(mockNetFetch).toHaveBeenCalledTimes(2)
    expect(mockNetFetch.mock.calls[1][0]).toBe(
      'https://account.alive.org.tw/api/account/v1/oauth/revoke'
    )
    expect(bodyAt(1).get('token')).toBe('late-refresh')
    expect(listener.mock.calls.some(([session]) => session !== null)).toBe(false)
    expect(disk).toBeNull()
  })

  it('deletes local credentials when remote revocation fails', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    mockNetFetch.mockRejectedValueOnce(new Error('offline'))

    await expect(service.clearLocalData()).resolves.toBeUndefined()
    expect(mockNetFetch.mock.calls[2][0]).toBe(
      'https://account.alive.org.tw/api/account/v1/oauth/revoke'
    )
    expect(disk).toBeNull()
  })

  it('reports credential deletion failure after clearing memory', async () => {
    const service = createHhcAuthService({ now: () => now })
    await service.begin()
    mockNetFetch
      .mockResolvedValueOnce(tokenResponse('refresh-1'))
      .mockResolvedValueOnce(profileResponse())
      .mockResolvedValueOnce(jsonResponse({}))
    await service.completeProtocolCallback(callbackFromOpenedUrl())
    mockRm.mockRejectedValueOnce(new Error('local delete failed'))

    await expect(service.clearLocalData()).rejects.toThrow('local delete failed')
    await expect(service.getAccessToken()).resolves.toBeNull()
    await expect(service.getSession()).resolves.toBeNull()
  })
})

describe('HHC auth IPC', () => {
  function fakeService(): HhcAuthService {
    return {
      begin: vi.fn().mockResolvedValue({ expiresAt: now + 300_000 }),
      cancelSignIn: vi.fn().mockResolvedValue(undefined),
      completeProtocolCallback: vi.fn().mockResolvedValue(false),
      getAccessToken: vi.fn().mockResolvedValue('access-token'),
      refreshAccessToken: vi.fn().mockResolvedValue('refreshed-access-token'),
      getSession: vi.fn().mockResolvedValue(null),
      signOut: vi.fn().mockResolvedValue(undefined),
      clearLocalData: vi.fn().mockResolvedValue(undefined),
      resolveShareTarget: vi.fn().mockResolvedValue({
        userId: '11111111-1111-1111-1111-111111111111',
        displayName: 'Member',
        email: 'member@example.com'
      }),
      resolveAccountLabels: vi.fn().mockResolvedValue([]),
      subscribe: vi.fn(() => () => undefined)
    }
  }

  it.each([projectionWindow, null])(
    'rejects every HHC method outside the main window',
    async (sender) => {
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(sender as never)
      const service = fakeService()
      const wm = {
        getMainWindow: vi.fn(() => mainWindow),
        sendToMain: vi.fn()
      } as unknown as WindowManager
      registerHhcAuthIpc(wm, service)

      for (const channel of [
        'hhc-auth:begin',
        'hhc-auth:cancel',
        'hhc-auth:get-access-token',
        'hhc-auth:refresh-access-token',
        'hhc-auth:get-session',
        'hhc-auth:resolve-share-target',
        'hhc-auth:resolve-account-labels',
        'hhc-auth:sign-out'
      ]) {
        await expect(handlers.get(channel)!(makeEvent())).rejects.toThrow(
          'Unauthorized HHC authentication access'
        )
      }
    }
  )

  it('forwards main-window calls and session events without exposing completion', async () => {
    const service = fakeService()
    let sessionListener: ((session: HhcSession | null) => void) | undefined
    vi.mocked(service.subscribe).mockImplementation((listener) => {
      sessionListener = listener
      return () => undefined
    })
    const sendToMain = vi.fn()
    const wm = {
      getMainWindow: vi.fn(() => mainWindow),
      sendToMain
    } as unknown as WindowManager
    registerHhcAuthIpc(wm, service)

    await expect(handlers.get('hhc-auth:begin')!(makeEvent())).resolves.toEqual({
      expiresAt: now + 300_000
    })
    await expect(handlers.get('hhc-auth:cancel')!(makeEvent())).resolves.toBeUndefined()
    await expect(handlers.get('hhc-auth:get-access-token')!(makeEvent())).resolves.toBe(
      'access-token'
    )
    await expect(handlers.get('hhc-auth:refresh-access-token')!(makeEvent())).resolves.toBe(
      'refreshed-access-token'
    )
    expect(handlers.has('hhc-auth:complete')).toBe(false)

    sessionListener?.({ userId: 'user-1', displayName: 'Alice', roles: [] })
    expect(sendToMain).toHaveBeenCalledWith('hhc-auth:session-changed', {
      userId: 'user-1',
      displayName: 'Alice',
      roles: []
    })
  })
})
