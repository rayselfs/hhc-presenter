import { describe, expect, it } from 'vitest'
import { loadFlexSearchCache, openBibleDB, saveFlexSearchCache } from '../bible-db'

describe('Bible index cache format', () => {
  it('ignores legacy indexes while preserving Bible content and rebuilding a reusable cache', async () => {
    const db = await openBibleDB()
    const books = [{ number: 1, code: '1', name: 'Genesis', abbreviation: 'Gen', chapters: [] }]
    await db.put('content', books, 901)
    await db.put(
      'flexsearch',
      { chunks: [{ key: 'old', data: 'possibly contaminated' }], updatedAt: 7 },
      901
    )
    expect(await loadFlexSearchCache(901, 7)).toBeUndefined()
    expect(await db.get('content', 901)).toEqual(books)
    const chunks = [{ key: 'new', data: 'rebuilt' }]
    await saveFlexSearchCache(901, 7, chunks)
    expect(await loadFlexSearchCache(901, 7)).toEqual(chunks)
    expect(await loadFlexSearchCache(901, 8)).toBeUndefined()
  })
})
