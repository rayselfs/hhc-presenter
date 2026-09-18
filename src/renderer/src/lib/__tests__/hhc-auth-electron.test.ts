import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HhcSession } from '@shared/hhc-auth'
import { createElectronHhcAuthAdapter } from '../hhc-auth-electron'

const session: HhcSession = {
  userId: 'user-1',
  displayName: 'Alice Chen',
  avatarUrl: 'https://account.example/avatar.png',
  roles: ['media_sync_user']
}

describe('ElectronHhcAuthAdapter', () => {
  beforeEach(() => {
    window.api = {
      hhcAuth: {
        begin: vi.fn().mockResolvedValue({ expiresAt: 301_000 }),
        cancel: vi.fn().mockResolvedValue(undefined),
        getAccessToken: vi.fn().mockResolvedValue('access-token'),
        refreshAfterUnauthorized: vi.fn().mockResolvedValue('refreshed-access-token'),
        getSession: vi.fn().mockResolvedValue(session),
        signOut: vi.fn().mockResolvedValue(undefined),
        onSessionChanged: vi.fn(() => vi.fn())
      }
    } as unknown as typeof window.api
  })

  it('maps the shared auth contract to the narrow preload API', async () => {
    const adapter = createElectronHhcAuthAdapter()

    await expect(adapter.getSession()).resolves.toEqual(session)
    await expect(adapter.getAccessToken()).resolves.toBe('access-token')
    await expect(adapter.refreshAfterUnauthorized('rejected-token')).resolves.toBe(
      'refreshed-access-token'
    )
    await expect(adapter.signIn()).resolves.toEqual({
      expiresAt: 301_000
    })
    await expect(adapter.cancelSignIn()).resolves.toBeUndefined()
    await expect(adapter.signOut()).resolves.toBeUndefined()

    expect(window.api.hhcAuth.getSession).toHaveBeenCalledOnce()
    expect(window.api.hhcAuth.getAccessToken).toHaveBeenCalledOnce()
    expect(window.api.hhcAuth.begin).toHaveBeenCalledOnce()
    expect(window.api.hhcAuth.cancel).toHaveBeenCalledOnce()
    expect(window.api.hhcAuth.signOut).toHaveBeenCalledOnce()
    expect(Object.keys(window.api.hhcAuth).sort()).toEqual([
      'begin',
      'cancel',
      'getAccessToken',
      'getSession',
      'onSessionChanged',
      'refreshAfterUnauthorized',
      'signOut'
    ])
  })

  it('cleans each session subscription once and disposes remaining subscriptions', () => {
    const firstCleanup = vi.fn()
    const secondCleanup = vi.fn()
    vi.mocked(window.api.hhcAuth.onSessionChanged)
      .mockReturnValueOnce(firstCleanup)
      .mockReturnValueOnce(secondCleanup)
    const adapter = createElectronHhcAuthAdapter()
    const firstListener = vi.fn()
    const secondListener = vi.fn()

    const unsubscribeFirst = adapter.subscribe(firstListener)
    const unsubscribeSecond = adapter.subscribe(secondListener)
    vi.mocked(window.api.hhcAuth.onSessionChanged).mock.calls[0][0](session)
    expect(firstListener).toHaveBeenCalledWith(session)

    unsubscribeFirst()
    unsubscribeFirst()
    adapter.dispose()
    adapter.dispose()
    unsubscribeSecond()

    expect(firstCleanup).toHaveBeenCalledOnce()
    expect(secondCleanup).toHaveBeenCalledOnce()
    expect(window.api.hhcAuth.cancel).not.toHaveBeenCalled()
  })

  it('cancels its owned sign-in when disposed before begin settles', async () => {
    let resolveBegin!: (pending: { expiresAt: number }) => void
    vi.mocked(window.api.hhcAuth.begin).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBegin = resolve
      })
    )
    const adapter = createElectronHhcAuthAdapter()

    const signingIn = adapter.signIn()
    adapter.dispose()
    adapter.dispose()
    resolveBegin({ expiresAt: 301_000 })

    await expect(signingIn).resolves.toEqual({ expiresAt: 301_000 })
    expect(window.api.hhcAuth.cancel).toHaveBeenCalledOnce()
  })

  it('does not cancel a completed sign-in when disposed', async () => {
    let sessionChanged!: (session: HhcSession | null) => void
    vi.mocked(window.api.hhcAuth.onSessionChanged).mockImplementationOnce((listener) => {
      sessionChanged = listener
      return vi.fn()
    })
    const adapter = createElectronHhcAuthAdapter()
    adapter.subscribe(vi.fn())

    await adapter.signIn()
    sessionChanged(session)
    adapter.dispose()

    expect(window.api.hhcAuth.cancel).not.toHaveBeenCalled()
  })
})
