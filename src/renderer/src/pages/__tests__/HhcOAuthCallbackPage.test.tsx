import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HhcAuthAdapter } from '@shared/hhc-auth'

const auth = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('@renderer/lib/hhc-auth', () => ({ createHhcAuthAdapter: auth.create }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import HhcOAuthCallbackPage from '../HhcOAuthCallbackPage'

function adapter(session: Awaited<ReturnType<HhcAuthAdapter['getSession']>>): HhcAuthAdapter {
  return {
    getSession: vi.fn(async () => session),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(),
    getAccessToken: vi.fn(),
    refreshAfterUnauthorized: vi.fn(),
    signOut: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn()
  }
}

describe('HhcOAuthCallbackPage', () => {
  beforeEach(() => auth.create.mockReset())

  it('completes through the shared auth adapter', async () => {
    auth.create.mockResolvedValue(
      adapter({ userId: 'user-1', displayName: 'Ada', roles: [], permissions: [] })
    )
    render(<HhcOAuthCallbackPage />)

    await waitFor(() => expect(screen.getByText('authCallback.completeTitle')).toBeInTheDocument())
  })

  it('fails closed when the callback session cannot be restored', async () => {
    const failed = adapter(null)
    vi.mocked(failed.getSession).mockRejectedValue(new Error('callback failed'))
    auth.create.mockResolvedValue(failed)
    render(<HhcOAuthCallbackPage />)

    await waitFor(() => expect(screen.getByText('authCallback.failedTitle')).toBeInTheDocument())
  })
})
