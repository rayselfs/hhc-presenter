export const HHC_AUTH_TRANSACTION_TTL_MS = 5 * 60_000

export interface HhcSession {
  userId: string
  displayName: string
  avatarUrl?: string
  roles: string[]
  permissions?: string[]
  permissionAvailability?: { status: 'available' | 'unavailable' }
}

export interface HhcPendingSignIn {
  expiresAt: number
}

export interface PresenterAccountLabel {
  userId: string
  displayName: string
  email?: string
}

export interface HhcAuthAdapter {
  getSession(): Promise<HhcSession | null>
  attemptPassiveSignIn?(): Promise<boolean>
  readonly revalidateOnPageActivity?: boolean
  signIn(): Promise<HhcPendingSignIn>
  cancelSignIn(): Promise<void>
  getAccessToken(): Promise<string | null>
  refreshAfterUnauthorized(rejectedToken: string): Promise<string | null>
  signOut(): Promise<void>
  subscribe(listener: (session: HhcSession | null) => void): () => void
  dispose(): void
}

export function readHhcPermissions(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((permission) => typeof permission === 'string' && permission.length > 0)
  ) {
    throw new Error('Invalid HHC account permissions')
  }
  return value
}
