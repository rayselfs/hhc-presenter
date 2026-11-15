import { describe, expect, it, vi } from 'vitest'
import {
  projectHhcAssetChangePage,
  projectHhcAssetCollection,
  projectHhcAssetItem,
  projectHhcSourceControl,
  readHhcAssetFailure
} from '../hhc-assets'
const collection = {
  id: 'collection',
  namespace: 'line.group.media-sync',
  name: 'Group',
  revision: 7,
  createdAt: '2026-11-12T00:00:00Z',
  updatedAt: '2026-11-12T00:00:00Z'
}
const item = {
  id: 'asset-item',
  collectionId: 'collection',
  remoteItemId: 'producer-key',
  displayName: 'Photo',
  sourceRevision: 'same-checksum',
  createdRevision: 5,
  createdAt: '2026-11-12T00:00:00Z'
}
const deadline = '2027-02-10T00:00:00Z'
describe('versioned LINE source contract', () => {
  it('keeps existing IDs and legacy Go zero deadlines, but requires deadlines for new source pages', () => {
    expect(projectHhcAssetItem({ ...item, sourceExpiresAt: '0001-01-01T00:00:00Z' })).toEqual(item)
    const c = { ...collection, sourcePolicyVersion: 1, aclRevision: 3, bindingGeneration: 2 }
    expect(projectHhcAssetCollection(c)).toEqual(c)
    const page = {
      collection: c,
      items: [{ ...item, sourceExpiresAt: deadline }],
      tombstones: [],
      cursor: 'same-cursor',
      hasMore: false,
      reset: false
    }
    expect(projectHhcAssetChangePage(page).items[0]).toEqual({ ...item, sourceExpiresAt: deadline })
    expect(() => projectHhcAssetChangePage({ ...page, items: [item] })).toThrow()
    expect(() => projectHhcAssetCollection({ ...c, sourcePolicyVersion: 2 })).toThrow()
    expect(() => projectHhcAssetItem({ ...item, sourceExpiresAt: 'not-a-date' })).toThrow()
  })
  it('validates the bounded control envelope without treating pause as deletion', () => {
    const c = {
      version: 1,
      collectionId: 'collection',
      state: 'paused',
      policyRevision: 4,
      aclRevision: 2,
      bindingGeneration: 1
    }
    expect(projectHhcSourceControl(c)).toEqual(c)
    expect(() => projectHhcSourceControl({ ...c, state: 'maybe' })).toThrow()
    expect(() => projectHhcSourceControl({ ...c, policyRevision: -1 })).toThrow()
  })
  it.each([
    [410, 'AST_SOURCE_EXPIRED', 'item', 'item-expired'],
    [410, 'AST_SOURCE_REVOKED', 'item', 'item-revoked'],
    [423, 'AST_SOURCE_PAUSED', 'collection', 'collection-paused'],
    [403, 'AST_SOURCE_ACL_REVOKED', 'collection', 'collection-revoked'],
    [503, 'AST_SOURCE_UNAVAILABLE', 'dependency', 'dependency-unavailable'],
    [426, 'AST_SOURCE_CLIENT_UPGRADE', 'collection', 'upgrade-required']
  ])('separates %s %s %s', async (status, code, scope, outcome) => {
    const response = Response.json(
      { error: { version: 1, code, scope, message: 'never expose backend details' } },
      { status: Number(status) }
    )
    expect(await readHhcAssetFailure(response)).toMatchObject({ outcome, status })
  })
  it('keeps unknown protocol versions and malformed source failures recoverable', async () => {
    for (const error of [
      { version: 2, code: 'AST_SOURCE_ACL_REVOKED', scope: 'collection' },
      { version: 1, code: 'AST_SOURCE_EXPIRED', scope: 'collection' }
    ]) {
      expect(await readHhcAssetFailure(Response.json({ error }, { status: 403 }))).toMatchObject({
        classification: 'retryable'
      })
    }
    expect(await readHhcAssetFailure(new Response('legacy', { status: 404 }))).toEqual({
      classification: 'access-revoked',
      status: 404
    })
  })
})

it('expires a protected source locally without extending deadlines beyond timer limits', async () => {
  vi.useFakeTimers()
  try {
    const { watchHhcSourceDeadline } = await import('../hhc-assets')
    const expired = vi.fn()
    const deadline = Date.now() + 90 * 86400_000
    const cancel = watchHhcSourceDeadline(deadline, expired)
    await vi.advanceTimersByTimeAsync(89 * 86400_000)
    expect(expired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(86400_000)
    expect(expired).toHaveBeenCalledOnce()
    cancel()
  } finally {
    vi.useRealTimers()
  }
})
