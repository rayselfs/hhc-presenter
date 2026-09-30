import { hasPermission } from '@hallelujahhomechurch/account-client'
import { canAccessAdmin } from '@hallelujahhomechurch/account-client/admin-access'

const presenterCloudPermissions = ['presenter:cloud:manage', 'presenter:cloud:use'] as const

export function hasPresenterCloudAccess(permissions: readonly string[] | undefined): boolean {
  return presenterCloudPermissions.some((permission) =>
    hasPermission(permissions ?? [], permission)
  )
}

export function canAccessHhcAdmin(permissions: readonly string[] | undefined): boolean {
  return canAccessAdmin(permissions ?? [])
}
