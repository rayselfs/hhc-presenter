export const HHC_AUTH_TRANSACTION_TTL_MS = 5 * 60_000
export const HHC_AUTH_CALLBACK_CHANNEL = 'hhc-auth-callback'

export interface HhcSession {
  userId: string
  displayName: string
  avatarUrl?: string
  roles: string[]
  permissions?: string[]
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
  refreshAccessToken(): Promise<string | null>
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

export function hasHhcPermission(
  permissions: readonly string[] | undefined,
  required: string
): boolean {
  return (
    required.length > 0 &&
    (permissions?.includes('*') === true || permissions?.includes(required) === true)
  )
}

const PRESENTER_CLOUD_PERMISSIONS = ['presenter:cloud:manage', 'presenter:cloud:use'] as const

export function hasPresenterCloudAccess(permissions: readonly string[] | undefined): boolean {
  return PRESENTER_CLOUD_PERMISSIONS.some((permission) => hasHhcPermission(permissions, permission))
}

const hhcAdminCapabilities = [
  'cms:pages:read',
  'cms:news:read',
  'cms:bulletins:read',
  'campaigns:read',
  'operations:meetings:read',
  'operations:resources:read',
  'operations:reservations:read',
  'memberships:read',
  'users:read',
  'rbac:read',
  'oauth:read',
  'audit:read',
  'assets:read',
  'presenter:cloud:manage',
  'presenter:line:manage',
  'dsr:read'
] as const

export function canAccessHhcAdmin(permissions: readonly string[] | undefined): boolean {
  return hhcAdminCapabilities.some((capability) => hasHhcPermission(permissions, capability))
}
