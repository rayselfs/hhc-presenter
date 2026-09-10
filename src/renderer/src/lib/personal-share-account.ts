import { APP_CONFIG } from '@shared/app-config'
import type { PresenterAccountLabel } from '@shared/hhc-auth'
import type { HhcLineCloudAuth } from './cloud-provider'
import { isElectron } from './env'

async function post(auth: HhcLineCloudAuth, path: string, body: unknown): Promise<unknown> {
  const root = `${APP_CONFIG.hhcAccountOrigin}/api/account/v1`
  const csrfResponse = await fetch(`${root}/csrf-token`, {
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' }
  })
  if (!csrfResponse.ok) throw new Error(`HHC account request failed (${csrfResponse.status})`)
  const csrf = (await csrfResponse.json()) as { csrf_token?: unknown }
  if (typeof csrf.csrf_token !== 'string' || !csrf.csrf_token) throw new Error('CSRF token missing')
  const csrfToken = csrf.csrf_token
  const send = async (refresh: boolean): Promise<Response> => {
    const token = await (refresh ? auth.refreshAccessToken() : auth.getAccessToken())
    if (!token) throw new Error('HHC account authentication required')
    return fetch(`${root}${path}`, {
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
  if (!response.ok)
    throw Object.assign(new Error(`HHC account request failed (${response.status})`), {
      status: response.status
    })
  return response.json()
}

function label(value: unknown, email = false): PresenterAccountLabel {
  if (!value || typeof value !== 'object') throw new Error('Invalid HHC account response')
  const item = value as Record<string, unknown>
  if (
    typeof item.userId !== 'string' ||
    typeof item.displayName !== 'string' ||
    (email && typeof item.email !== 'string')
  ) {
    throw new Error('Invalid HHC account response')
  }
  return {
    userId: item.userId,
    displayName: item.displayName,
    ...(email ? { email: item.email as string } : {})
  }
}

export async function resolvePersonalShareTarget(
  auth: HhcLineCloudAuth,
  email: string
): Promise<PresenterAccountLabel> {
  if (isElectron()) return window.api.hhcAuth.resolveShareTarget(email)
  return label(await post(auth, '/presenter/share-targets/resolve', { email }), true)
}

export async function resolvePersonalAccountLabels(
  auth: HhcLineCloudAuth,
  userIds: string[]
): Promise<PresenterAccountLabel[]> {
  if (isElectron()) return window.api.hhcAuth.resolveAccountLabels(userIds)
  const value = await post(auth, '/presenter/account-labels/resolve', { userIds })
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { accounts?: unknown }).accounts)
  ) {
    throw new Error('Invalid HHC account response')
  }
  return (value as { accounts: unknown[] }).accounts.map((item) => label(item))
}
