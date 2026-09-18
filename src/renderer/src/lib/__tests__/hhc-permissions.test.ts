import { describe, expect, it } from 'vitest'
import { canAccessHhcAdmin, hasPresenterCloudAccess } from '../hhc-permissions'

describe('canAccessHhcAdmin', () => {
  it.each([
    '*',
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
  ])('allows %s', (permission) => {
    expect(canAccessHhcAdmin([permission])).toBe(true)
  })

  it.each([
    { permissions: [] },
    { permissions: ['presenter:cloud:use'] },
    { permissions: ['cms:pages:write'] },
    { permissions: ['media-sync:manage'] }
  ])('denies $permissions', ({ permissions }) => {
    expect(canAccessHhcAdmin(permissions)).toBe(false)
  })
})

describe('hasPresenterCloudAccess', () => {
  it.each(['*', 'presenter:cloud:manage', 'presenter:cloud:use'])('allows %s', (permission) => {
    expect(hasPresenterCloudAccess([permission])).toBe(true)
  })

  it.each([undefined, [], ['presenter:line:manage']])('denies %j', (permissions) => {
    expect(hasPresenterCloudAccess(permissions)).toBe(false)
  })
})
