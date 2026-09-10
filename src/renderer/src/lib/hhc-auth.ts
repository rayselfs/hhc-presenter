import { APP_CONFIG } from '@shared/app-config'
import type { HhcAuthAdapter, HhcSession } from '@shared/hhc-auth'
import { isElectron } from './env'

let sessionOwner: (() => HhcSession | null) | undefined

export function registerHhcSessionOwner(owner: () => HhcSession | null): () => void {
  sessionOwner = owner
  return () => {
    if (sessionOwner === owner) sessionOwner = undefined
  }
}

export function getCurrentHhcSession(): HhcSession | null {
  return sessionOwner?.() ?? null
}

export const HHC_AUTH = {
  accountApi: `${APP_CONFIG.hhcAccountOrigin}/api/account/v1`,
  authorize: `${APP_CONFIG.hhcAccountOrigin}/api/account/v1/oauth/authorize`,
  token: `${APP_CONFIG.hhcAccountOrigin}/api/account/v1/oauth/token`,
  callbackUri: 'https://client.alive.org.tw/oauth/callback',
  clientId: 'client-web',
  scope: 'openid profile presenter:cloud:manage'
} as const

export async function createHhcAuthAdapter(): Promise<HhcAuthAdapter> {
  if (isElectron()) {
    const { createElectronHhcAuthAdapter } = await import('./hhc-auth-electron')
    return createElectronHhcAuthAdapter()
  }

  const { createBrowserHhcAuthAdapter } = await import('./hhc-auth-browser')
  return createBrowserHhcAuthAdapter()
}
