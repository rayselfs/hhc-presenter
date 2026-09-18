import { hasPermission } from '@hallelujahhomechurch/account-client'

const presenterCloudPermissions = ['presenter:cloud:manage', 'presenter:cloud:use'] as const

export function hasPresenterCloudAccess(permissions: readonly string[] | undefined): boolean {
  return presenterCloudPermissions.some((permission) =>
    hasPermission(permissions ?? [], permission)
  )
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
  return hhcAdminCapabilities.some((capability) => hasPermission(permissions ?? [], capability))
}
