import { vi, it, expect } from 'vitest'
import { join } from 'node:path'
vi.mock('electron', () => ({ net: {}, protocol: {} }))
import { lyricsAssetPath } from '../lyrics-protocol'
it('serves only built OCR assets, never arbitrary local files', () => {
  expect(lyricsAssetPath('/app', 'hhc-lyrics://runtime/lyrics-runtime/det.tar')).toBe(
    join('/app', 'lyrics-runtime', 'det.tar')
  )
  expect(lyricsAssetPath('/app', 'hhc-lyrics://runtime/lyrics-runtime/ocr-worker.js')).toBe(
    join('/app', 'lyrics-runtime', 'ocr-worker.js')
  )
  for (const path of [
    'invalid',
    'hhc-lyrics://runtime:123/lyrics-runtime/det.tar',
    'hhc-lyrics://user@runtime/lyrics-runtime/det.tar',
    'hhc-lyrics://other/lyrics-runtime/det.tar',
    'hhc-lyrics://runtime/lyrics-runtime/secret.json',
    'hhc-lyrics://runtime/assets/..%2Fsecret.js',
    'hhc-lyrics://runtime/index.html',
    'hhc-lyrics://runtime/lyrics-runtime/det.tar?path=/secret'
  ])
    expect(lyricsAssetPath('/app', path)).toBeNull()
})
