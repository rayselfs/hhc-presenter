import { describe, expect, it, vi, beforeEach } from 'vitest'

const resetMocks = vi.hoisted(() => ({
  resetBibleDB: vi.fn(),
  resetFileExplorerDB: vi.fn(),
  resetMediaWorkDB: vi.fn(),
  resetSyncDB: vi.fn(),
  resetThumbnailDB: vi.fn(),
  resetWebOneDriveCredentialDB: vi.fn()
}))

vi.mock('../bible-db', () => ({ resetBibleDB: resetMocks.resetBibleDB }))
vi.mock('../file-explorer-db', () => ({ resetFileExplorerDB: resetMocks.resetFileExplorerDB }))
vi.mock('../media-work-db', () => ({ resetMediaWorkDB: resetMocks.resetMediaWorkDB }))
vi.mock('../sync-db', () => ({ resetSyncDB: resetMocks.resetSyncDB }))
vi.mock('../thumbnail-db', () => ({ resetThumbnailDB: resetMocks.resetThumbnailDB }))
vi.mock('../onedrive-web-credentials', () => ({
  resetWebOneDriveCredentialDB: resetMocks.resetWebOneDriveCredentialDB
}))

import { clearAllSiteData } from '../site-data'

beforeEach(() => {
  vi.clearAllMocks()
  for (const reset of Object.values(resetMocks)) {
    reset.mockResolvedValue(undefined)
  }
})

describe('clearAllSiteData', () => {
  it('explicitly clears dormant legacy Service and Soundboard settings', async () => {
    localStorage.setItem('hhc-service-playlist', '{"state":{"cues":[]},"version":0}')
    localStorage.setItem('hhc-soundboard', '{"state":{"boards":{}},"version":0}')

    await clearAllSiteData()

    expect(localStorage.getItem('hhc-service-playlist')).toBeNull()
    expect(localStorage.getItem('hhc-soundboard')).toBeNull()
  })

  it('continues when an IndexedDB deletion is blocked by an open connection', async () => {
    resetMocks.resetBibleDB.mockRejectedValueOnce(new Error('Bible database deletion blocked'))

    await expect(clearAllSiteData()).resolves.toBeUndefined()
  })
})
