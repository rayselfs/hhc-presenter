import { describe, expect, it } from 'vitest'
import { canAccessHhcAdmin, hasPresenterCloudAccess } from '../hhc-auth'

describe('canAccessHhcAdmin', () => {
  it.each([
    '*',
    'cms:read',
    'campaigns:read',
    'users:read',
    'rbac:read',
    'presenter:line:manage',
    'media-sync:manage',
    'dsr:read',
    'users:manage',
    'rbac:manage',
    'dsr:manage'
  ])('allows %s', (permission) => {
    expect(canAccessHhcAdmin([permission])).toBe(true)
  })

  it.each([
    { permissions: [] },
    { permissions: ['presenter:cloud:manage'] },
    { permissions: ['presenter:cloud:use'] },
    { permissions: ['cms:write'] }
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
