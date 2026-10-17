import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'

const {
  handleHandlers,
  mockMkdir,
  mockReadFile,
  mockWriteFile,
  mockRename,
  mockRm,
  mockNetFetch,
  mockEncryptString,
  mockDecryptString
} = vi.hoisted(() => ({
  handleHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockMkdir: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockRename: vi.fn(),
  mockRm: vi.fn(),
  mockNetFetch: vi.fn(),
  mockEncryptString: vi.fn(),
  mockDecryptString: vi.fn()
}))

const mockMainWindow = { id: 1, show: vi.fn(), focus: vi.fn() }
const mockProjectionWindow = { id: 2 }
const mockWindowManager = {
  getMainWindow: vi.fn(() => mockMainWindow)
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/hhc-user-data')
  },
  BrowserWindow: {
    fromWebContents: vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleHandlers.set(channel, handler)
    })
  },
  net: {
    fetch: mockNetFetch
  },
  safeStorage: {
    encryptString: mockEncryptString,
    decryptString: mockDecryptString
  }
}))

vi.mock('fs', () => {
  const promises = {
    mkdir: mockMkdir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    rename: mockRename,
    rm: mockRm
  }
  return { default: { promises }, promises }
})

import { BrowserWindow } from 'electron'
import type { WindowManager } from '../../windowManager'
import { registerOneDriveCredentialHandlers } from '../../ipc/onedrive-credentials'
import { createOneDriveService } from '../../onedrive-service'

let service = createOneDriveService()

const wm = mockWindowManager as unknown as WindowManager

function makeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = handleHandlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler
}

beforeEach(() => {
  service.dispose()
  service = createOneDriveService()
  vi.clearAllMocks()
  handleHandlers.clear()
  mockMkdir.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockRename.mockReset()
  mockRm.mockReset()
  mockNetFetch.mockReset()
  mockEncryptString.mockReset()
  mockDecryptString.mockReset()
  mockMkdir.mockResolvedValue(undefined)
  mockWriteFile.mockResolvedValue(undefined)
  mockRename.mockResolvedValue(undefined)
  mockRm.mockResolvedValue(undefined)
  mockNetFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        scope: 'offline_access User.Read Files.Read',
        token_type: 'Bearer'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  )
  mockReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  mockEncryptString.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`))
  mockDecryptString.mockImplementation((value: Buffer) =>
    value.toString('utf8').replace(/^encrypted:/, '')
  )
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
  registerOneDriveCredentialHandlers(wm, service)
})

describe('OneDrive credential IPC', () => {
  it('rejects non-main window access', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)

    await expect(
      getHandler('onedrive:get-credential-status')(makeEvent(), 'onedrive:account-1')
    ).rejects.toThrow('Unauthorized OneDrive credential access')
  })

  it.each(['../escape', 'onedrive:../escape', 'onedrive:bad/slash', 'not-onedrive'])(
    'rejects invalid connection id %s',
    async (connectionId) => {
      await expect(
        getHandler('onedrive:get-credential-status')(makeEvent(), connectionId)
      ).rejects.toThrow('Invalid OneDrive connection id')
    }
  )

  it('reads credential status without returning token material', async () => {
    mockReadFile.mockResolvedValueOnce(
      Buffer.from(
        `encrypted:${JSON.stringify({
          connectionId: 'onedrive:account-1',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: 1000,
          scope: 'offline_access User.Read Files.Read',
          updatedAt: 1
        })}`
      )
    )

    const result = await getHandler('onedrive:get-credential-status')(
      makeEvent(),
      'onedrive:account-1'
    )

    expect(result).toEqual({
      hasRefreshToken: true,
      expiresAt: 1000,
      scope: 'offline_access User.Read Files.Read'
    })
    expect(JSON.stringify(result)).not.toContain('refresh-token')
    expect(JSON.stringify(result)).not.toContain('access-token')
  })

  it('refreshes an access token without returning refresh token material', async () => {
    mockReadFile.mockResolvedValueOnce(
      Buffer.from(
        `encrypted:${JSON.stringify({
          connectionId: 'onedrive:account-1',
          refreshToken: 'old-refresh-token',
          updatedAt: 1
        })}`
      )
    )

    const result = (await getHandler('onedrive:get-access-token')(makeEvent(), {
      connectionId: 'onedrive:account-1',
      clientId: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02'
    })) as { accessToken: string; expiresAt?: number; scope?: string; tokenType?: 'Bearer' }

    expect(result).toMatchObject({
      accessToken: 'new-access-token',
      scope: 'offline_access User.Read Files.Read',
      tokenType: 'Bearer'
    })
    expect(result.expiresAt).toBeGreaterThan(Date.now())
    expect(JSON.stringify(result)).not.toContain('new-refresh-token')
    expect(JSON.stringify(result)).not.toContain('old-refresh-token')

    const [, init] = mockNetFetch.mock.calls[0]
    expect(mockNetFetch.mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token'
    )
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(URLSearchParams)
    expect(init.body.get('grant_type')).toBe('refresh_token')
    expect(init.body.get('client_id')).toBe('4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02')
    expect(init.body.get('refresh_token')).toBe('old-refresh-token')
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('onedrive%3Aaccount-1.enc.'),
      expect.any(Buffer)
    )
  })

  it('returns a cached access token while it is still fresh', async () => {
    const expiresAt = Date.now() + 10 * 60_000
    mockReadFile.mockResolvedValueOnce(
      Buffer.from(
        `encrypted:${JSON.stringify({
          connectionId: 'onedrive:account-1',
          accessToken: 'cached-access-token',
          refreshToken: 'refresh-token',
          expiresAt,
          scope: 'offline_access User.Read Files.Read',
          tokenType: 'Bearer',
          updatedAt: 1
        })}`
      )
    )

    const result = await getHandler('onedrive:get-access-token')(makeEvent(), {
      connectionId: 'onedrive:account-1',
      clientId: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02'
    })

    expect(result).toMatchObject({
      accessToken: 'cached-access-token',
      expiresAt,
      scope: 'offline_access User.Read Files.Read',
      tokenType: 'Bearer'
    })
    expect(mockNetFetch).not.toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('coalesces concurrent token refreshes for the same connection', async () => {
    mockReadFile.mockResolvedValue(
      Buffer.from(
        `encrypted:${JSON.stringify({
          connectionId: 'onedrive:account-1',
          refreshToken: 'old-refresh-token',
          updatedAt: 1
        })}`
      )
    )

    const request = {
      connectionId: 'onedrive:account-1',
      clientId: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02'
    }
    const [first, second] = await Promise.all([
      getHandler('onedrive:get-access-token')(makeEvent(), request),
      getHandler('onedrive:get-access-token')(makeEvent(), request)
    ])

    expect(first).toMatchObject({ accessToken: 'new-access-token' })
    expect(second).toMatchObject({ accessToken: 'new-access-token' })
    expect(mockNetFetch).toHaveBeenCalledTimes(1)
  })

  it('completes auth in main without returning token material', async () => {
    mockNetFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
            scope: 'offline_access User.Read Files.Read',
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'account-1',
            displayName: 'Alice',
            userPrincipalName: 'alice@example.com'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )

    const result = (await getHandler('onedrive:complete-auth')(makeEvent(), {
      clientId: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
      redirectUri: 'hhc-presenter://auth/onedrive',
      code: 'code-1',
      codeVerifier: 'verifier-1'
    })) as {
      id: string
      providerType: 'onedrive'
      displayName: string
      accountLabel?: string
    }

    expect(result).toMatchObject({
      id: 'onedrive:account-1',
      providerType: 'onedrive',
      displayName: 'OneDrive - Alice',
      accountLabel: 'alice@example.com'
    })
    expect(JSON.stringify(result)).not.toContain('new-access-token')
    expect(JSON.stringify(result)).not.toContain('new-refresh-token')

    const [, init] = mockNetFetch.mock.calls[0]
    expect(mockNetFetch.mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token'
    )
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(URLSearchParams)
    expect(init.body.get('grant_type')).toBe('authorization_code')
    expect(init.body.get('redirect_uri')).toBe('hhc-presenter://auth/onedrive')
    expect(init.body.get('code')).toBe('code-1')
    expect(init.body.get('code_verifier')).toBe('verifier-1')
    expect(mockNetFetch.mock.calls[1][0]).toBe('https://graph.microsoft.com/v1.0/me')
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('onedrive%3Aaccount-1.enc.'),
      expect.any(Buffer)
    )
  })

  it('rejects access token refresh when credential is missing', async () => {
    await expect(
      getHandler('onedrive:get-access-token')(makeEvent(), {
        connectionId: 'onedrive:account-1',
        clientId: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02'
      })
    ).rejects.toThrow('OneDrive credentials not found')
  })

  it('returns missing status when credential file does not exist', async () => {
    await expect(
      getHandler('onedrive:get-credential-status')(makeEvent(), 'onedrive:account-1')
    ).resolves.toEqual({ hasRefreshToken: false })
  })

  it('deletes credentials by validated connection id', async () => {
    await expect(
      getHandler('onedrive:delete-credentials')(makeEvent(), 'onedrive:account-1')
    ).resolves.toBeUndefined()

    expect(mockRm).toHaveBeenCalledWith(
      path.join('/tmp/hhc-user-data', 'onedrive-credentials', 'onedrive%3Aaccount-1.enc'),
      { force: true }
    )
  })

  it('returns the custom protocol auth redirect URI', async () => {
    await expect(getHandler('onedrive:get-auth-redirect-uri')(makeEvent())).resolves.toBe(
      'hhc-presenter://auth/onedrive'
    )
  })

  it('resolves auth callback from the custom protocol URL', async () => {
    const waiting = getHandler('onedrive:wait-auth-callback')(makeEvent(), 'state-1') as Promise<
      string | null
    >

    service.handleAuthCallbackUrl('hhc-presenter://auth/onedrive?code=code-1&state=state-1', wm)

    await expect(waiting).resolves.toBe('hhc-presenter://auth/onedrive?code=code-1&state=state-1')
    expect(mockMainWindow.show).toHaveBeenCalled()
    expect(mockMainWindow.focus).toHaveBeenCalled()
  })

  it('ignores stale queued auth callbacks with a different state', async () => {
    service.handleAuthCallbackUrl('hhc-presenter://auth/onedrive?code=old-code&state=old-state', wm)

    const waiting = getHandler('onedrive:wait-auth-callback')(makeEvent(), 'state-1') as Promise<
      string | null
    >

    service.handleAuthCallbackUrl('hhc-presenter://auth/onedrive?code=code-1&state=state-1', wm)

    await expect(waiting).resolves.toBe('hhc-presenter://auth/onedrive?code=code-1&state=state-1')
  })
})

describe('OneDrive credential revocation', () => {
  it('does not restore credentials when a refresh completes after disconnect', async () => {
    const connectionId = 'onedrive:revocation-race'
    mockReadFile.mockResolvedValue(
      Buffer.from(
        `encrypted:${JSON.stringify({ connectionId, refreshToken: 'old', updatedAt: 1 })}`
      )
    )
    let finish!: (value: Response) => void
    mockNetFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      })
    )
    const refreshing = getHandler('onedrive:get-access-token')(makeEvent(), {
      connectionId,
      clientId: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02'
    }) as Promise<unknown>
    const outcome = refreshing.then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledOnce())
    await getHandler('onedrive:delete-credentials')(makeEvent(), connectionId)
    finish(
      new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late-refresh' }), {
        status: 200
      })
    )
    expect(await outcome).toBe('rejected')
    expect(mockRename).not.toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})

describe('OneDrive credential mutation ordering', () => {
  const clientId = '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02'
  const credential = (connectionId: string): Buffer =>
    Buffer.from(`encrypted:${JSON.stringify({ connectionId, refreshToken: 'old', updatedAt: 1 })}`)
  const tokenResponse = (): Response =>
    new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late-refresh' }), {
      status: 200
    })

  it('clear-all revokes a pending refresh and removes the credential directory through the queue', async () => {
    const connectionId = 'onedrive:clear-race'
    mockReadFile.mockResolvedValue(credential(connectionId))
    let finish!: (response: Response) => void
    mockNetFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      })
    )
    const refreshing = getHandler('onedrive:get-access-token')(makeEvent(), {
      connectionId,
      clientId
    }) as Promise<unknown>
    const outcome = refreshing.then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledOnce())
    await service.clearCredentials()
    finish(tokenResponse())
    expect(await outcome).toBe('rejected')
    expect(mockRename).not.toHaveBeenCalled()
    expect(mockRm).toHaveBeenCalledWith(path.join('/tmp/hhc-user-data', 'onedrive-credentials'), {
      recursive: true,
      force: true
    })
  })

  it('waits for an in-flight write, rejects its rename and then deletes', async () => {
    const connectionId = 'onedrive:write-race'
    mockReadFile.mockResolvedValue(credential(connectionId))
    let finishWrite!: () => void
    mockWriteFile.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWrite = resolve
      })
    )
    const refreshing = getHandler('onedrive:get-access-token')(makeEvent(), {
      connectionId,
      clientId
    }) as Promise<unknown>
    const outcome = refreshing.then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(mockWriteFile).toHaveBeenCalledOnce())
    const deleting = getHandler('onedrive:delete-credentials')(makeEvent(), connectionId)
    expect(mockRm).not.toHaveBeenCalled()
    finishWrite()
    await deleting
    expect(await outcome).toBe('rejected')
    expect(mockRename).not.toHaveBeenCalled()
    expect(mockRm.mock.calls.at(-1)?.[0]).toContain('onedrive%3Awrite-race.enc')
  })

  it('deletes after an already dispatched rename and rejects the late token result', async () => {
    const connectionId = 'onedrive:rename-race'
    mockReadFile.mockResolvedValue(credential(connectionId))
    let finishRename!: () => void
    mockRename.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRename = resolve
      })
    )
    const refreshing = getHandler('onedrive:get-access-token')(makeEvent(), {
      connectionId,
      clientId
    }) as Promise<unknown>
    const outcome = refreshing.then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(mockRename).toHaveBeenCalledOnce())
    const deleting = getHandler('onedrive:delete-credentials')(makeEvent(), connectionId)
    expect(mockRm).not.toHaveBeenCalled()
    finishRename()
    await deleting
    expect(await outcome).toBe('rejected')
    expect(mockRm.mock.calls.at(-1)?.[0]).toContain('onedrive%3Arename-race.enc')
  })

  it('does not revoke a different account refresh', async () => {
    const connectionId = 'onedrive:other-account'
    mockReadFile.mockResolvedValue(credential(connectionId))
    let finish!: (response: Response) => void
    mockNetFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      })
    )
    const refreshing = getHandler('onedrive:get-access-token')(makeEvent(), {
      connectionId,
      clientId
    }) as Promise<unknown>
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledOnce())
    await getHandler('onedrive:delete-credentials')(makeEvent(), 'onedrive:unrelated')
    finish(tokenResponse())
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'late' })
    expect(mockRename).toHaveBeenCalledOnce()
  })

  it('rejects a delayed credential read after disconnect before fetching any token', async () => {
    const connectionId = 'onedrive:read-race'
    let finishRead!: (value: Buffer) => void
    mockReadFile.mockReturnValueOnce(
      new Promise<Buffer>((resolve) => {
        finishRead = resolve
      })
    )
    const refreshing = getHandler('onedrive:get-access-token')(makeEvent(), {
      connectionId,
      clientId
    }) as Promise<unknown>
    const outcome = refreshing.then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(mockReadFile).toHaveBeenCalledOnce())
    const deleting = getHandler('onedrive:delete-credentials')(makeEvent(), connectionId)
    finishRead(credential(connectionId))
    await deleting
    expect(await outcome).toBe('rejected')
    expect(mockNetFetch).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'keeps a new login when an older refresh completes (disconnect first: %s)',
    async (disconnectFirst) => {
      const connectionId = `onedrive:reconnect-${disconnectFirst}`
      mockReadFile.mockResolvedValue(credential(connectionId))
      let finishRefresh!: (response: Response) => void
      mockNetFetch.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finishRefresh = resolve
        })
      )
      const refreshing = getHandler('onedrive:get-access-token')(makeEvent(), {
        connectionId,
        clientId
      }) as Promise<unknown>
      const outcome = refreshing.then(
        () => 'resolved',
        () => 'rejected'
      )
      await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledOnce())
      if (disconnectFirst)
        await getHandler('onedrive:delete-credentials')(makeEvent(), connectionId)
      mockNetFetch
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: `reconnect-${disconnectFirst}`, displayName: 'New Login' }),
            { status: 200 }
          )
        )
      await getHandler('onedrive:complete-auth')(makeEvent(), {
        clientId,
        redirectUri: 'hhc-presenter://auth/onedrive',
        code: 'new-code',
        codeVerifier: 'new-verifier'
      })
      expect(mockRename).toHaveBeenCalledOnce()
      finishRefresh(tokenResponse())
      expect(await outcome).toBe('rejected')
      expect(mockRename).toHaveBeenCalledOnce()
    }
  )

  it('does not persist a pending auth exchange after clear-all', async () => {
    let finish!: (response: Response) => void
    mockNetFetch
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finish = resolve
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cleared-auth' }), { status: 200 }))
    const auth = getHandler('onedrive:complete-auth')(makeEvent(), {
      clientId,
      redirectUri: 'hhc-presenter://auth/onedrive',
      code: 'code',
      codeVerifier: 'verifier'
    }) as Promise<unknown>
    const outcome = auth.then(
      () => 'resolved',
      () => 'rejected'
    )
    await service.clearCredentials()
    finish(tokenResponse())
    expect(await outcome).toBe('rejected')
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})

describe('OneDrive service lifecycle', () => {
  it.each(['token', 'profile'])(
    'rejects late completeAuth after disposal during %s',
    async (stage) => {
      let finish!: (response: Response) => void
      const deferred = new Promise<Response>((resolve) => {
        finish = resolve
      })
      const token = () =>
        new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late-refresh' }), {
          status: 200
        })
      const profile = () => new Response(JSON.stringify({ id: 'late-account' }), { status: 200 })
      mockNetFetch
        .mockReturnValueOnce(stage === 'token' ? deferred : Promise.resolve(token()))
        .mockReturnValueOnce(stage === 'profile' ? deferred : Promise.resolve(profile()))
      const pending = service.completeAuth({
        clientId: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
        redirectUri: 'hhc-presenter://auth/onedrive',
        code: 'late-code',
        codeVerifier: 'late-verifier'
      })
      const outcome = pending.then(
        () => 'resolved',
        () => 'rejected'
      )
      await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledTimes(stage === 'token' ? 1 : 2))
      service.dispose()
      finish(stage === 'token' ? token() : profile())
      expect(await outcome).toBe('rejected')
      expect(mockWriteFile).not.toHaveBeenCalled()
      expect(mockRename).not.toHaveBeenCalled()
      expect(mockRm).not.toHaveBeenCalled()
    }
  )

  it('revokes a late refresh without overwriting a new instance login', async () => {
    const clientId = '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02'
    const connectionId = 'onedrive:replacement'
    mockReadFile.mockResolvedValue(
      Buffer.from(
        `encrypted:${JSON.stringify({ connectionId, refreshToken: 'old', updatedAt: 1 })}`
      )
    )
    let finish!: (response: Response) => void
    mockNetFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      })
    )
    const pending = service.getAccessToken({ connectionId, clientId })
    const outcome = pending.then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledOnce())
    service.dispose()
    const next = createOneDriveService()
    try {
      mockNetFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'new', refresh_token: 'new-refresh' }), {
            status: 200
          })
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'replacement' }), { status: 200 }))
      await next.completeAuth({
        clientId,
        redirectUri: 'hhc-presenter://auth/onedrive',
        code: 'new-code',
        codeVerifier: 'new-verifier'
      })
      expect(mockRename).toHaveBeenCalledOnce()
      finish(
        new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late-refresh' }), {
          status: 200
        })
      )
      expect(await outcome).toBe('rejected')
      expect(mockRename).toHaveBeenCalledOnce()
      expect(mockWriteFile).toHaveBeenCalledOnce()
      expect(mockRm).not.toHaveBeenCalled()
    } finally {
      next.dispose()
    }
  })

  it('settles and isolates callback waiters across service instances', async () => {
    const next = createOneDriveService()
    const oldWait = service.waitForAuthCallback('old')
    const nextWait = next.waitForAuthCallback('new')
    service.dispose()
    await expect(oldWait).resolves.toBeNull()
    expect(service.handleAuthCallbackUrl('hhc-presenter://auth/onedrive?code=old&state=old')).toBe(
      false
    )
    next.handleAuthCallbackUrl('hhc-presenter://auth/onedrive?code=new&state=new')
    await expect(nextWait).resolves.toBe('hhc-presenter://auth/onedrive?code=new&state=new')
    expect(mockRm).not.toHaveBeenCalled()
    next.dispose()
  })

  it('clears queued callbacks and pending waiters with clear-data', async () => {
    service.handleAuthCallbackUrl('hhc-presenter://auth/onedrive?code=old&state=old')
    await service.clearCredentials()
    const waiting = service.waitForAuthCallback('old')
    await service.clearCredentials()
    await expect(waiting).resolves.toBeNull()
  })

  it('does not start new credential operations after disposal', async () => {
    service.dispose()
    await expect(service.getCredentialStatus('onedrive:account-1')).rejects.toThrow('disposed')
    await expect(service.waitForAuthCallback('state')).rejects.toThrow('disposed')
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('settles callback waiters on timeout', async () => {
    vi.useFakeTimers()
    try {
      const waiting = service.waitForAuthCallback('timeout')
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await expect(waiting).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
