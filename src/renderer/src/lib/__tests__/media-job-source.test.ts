import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as files from '../file-explorer-db'
import { loadMediaJobFile } from '../media-job-source'

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  await files.resetFileExplorerDBForTests()
  const db = await files.openFileExplorerDB()
  await db.put('folder-items', {
    id: 'item',
    parentId: 'file-root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name: 'slides.pdf',
    url: 'blob:source',
    size: 3,
    mimeType: 'application/pdf'
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reads stored bytes and resolves a surviving copy by blob identity', async () => {
  const db = await files.openFileExplorerDB()
  await db.put('file-blobs', { id: 'source', blob: new Blob(['pdf']), refCount: 1 })
  for (const itemId of ['item', 'deleted-item']) {
    const file = await loadMediaJobFile('source', itemId, 'PDF')
    expect(file).toMatchObject({ name: 'slides.pdf', type: 'application/pdf', size: 3 })
    expect(await file?.text()).toBe('pdf')
  }
})

it('returns null when neither requested item nor shared source exists', async () => {
  expect(await loadMediaJobFile('missing', 'missing', 'thumbnail')).toBeNull()
})

it.each(['success', 'http-error', 'network-error'] as const)(
  'releases a native source on %s',
  async (outcome) => {
    const revoke = vi.fn()
    vi.spyOn(files, 'getFileSource').mockResolvedValue({ url: 'native:test', revoke })
    const fetchSource = vi.fn()
    vi.stubGlobal('fetch', fetchSource)
    if (outcome === 'network-error') fetchSource.mockRejectedValue(new Error('Offline'))
    else
      fetchSource.mockResolvedValue(
        new Response('pdf', { status: outcome === 'success' ? 200 : 503 })
      )
    const result = loadMediaJobFile('source', 'item', 'thumbnail')
    if (outcome === 'success')
      expect(await result).toMatchObject({ name: 'slides.pdf', type: 'application/pdf' })
    else
      await expect(result).rejects.toThrow(
        outcome === 'http-error' ? 'Failed to read thumbnail source: 503' : 'Offline'
      )
    expect(revoke).toHaveBeenCalledOnce()
  }
)
