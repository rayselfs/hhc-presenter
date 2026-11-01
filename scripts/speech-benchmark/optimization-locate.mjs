// Offline experiment only: current reference parser versus conservative normalized grammar.
import { readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === '@shared/types/bible'
        ? new URL('../../src/shared/types/bible.ts', import.meta.url).href
        : specifier,
      context
    )
  }
})
const { parseVerseReference } = await import('../../src/renderer/src/lib/verse-parser.ts')
const { matchBookName } = await import('../../src/renderer/src/lib/bible-book-matcher.ts')
const [input, output, scriptureFile] = process.argv.slice(2)
const scriptures = JSON.parse(readFileSync(scriptureFile, 'utf8').replace(/^\uFEFF/, ''))
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Standalone JavaScript experiment.
function locate(text, normalized, optimized) {
  let parsed = parseVerseReference(text)
  if (optimized) {
    const match = normalized.match(
      /^\s*(?:please turn to\s+|請翻到\s*)?(.+?)\s*(?:chapter\s*|第\s*)(\d+)\s*(?:章\s*)?(?:verse\s*|第\s*)(\d+)\s*(?:節)?[.。!！\s]*$/i
    )
    if (match && (!parsed || /chapter|verse/i.test(normalized))) {
      parsed = { book: match[1], chapter: Number(match[2]), verse: Number(match[3]) }
    }
  }
  if (!parsed) return null
  const book = matchBookName(parsed.book)
  if (!book) return null
  const target = [book.bookNumber, parsed.chapter, parsed.verse]
  if (
    optimized &&
    (book.score < 0.85 || !scriptures[target[0] - 1]?.chapters[target[1] - 1]?.[target[2] - 1])
  )
    return null
  return target
}
assert.deepEqual(
  locate('John chapter three verse sixteen', 'john chapter 3 verse 16', true),
  [43, 3, 16]
)
assert.equal(locate('John chapter ninety nine verse one', 'john chapter 99 verse 1', true), null)
assert.equal(
  locate('The meeting begins at three sixteen.', 'the meeting begins at 3 16.', true),
  null
)
assert.deepEqual(
  locate('約翰福音第三章 verse sixteen', '約翰福音第3章 verse 16', true),
  [43, 3, 16]
)
const rows = JSON.parse(readFileSync(input, 'utf8'))
for (const row of rows) {
  for (const optimized of [false, true]) {
    const start = performance.now()
    const result = locate(row.transcript, row.normalized, optimized)
    row[optimized ? 'optimized_reference' : 'baseline_reference'] = result
    row[optimized ? 'optimized_reference_s' : 'baseline_reference_s'] =
      (performance.now() - start) / 1000
  }
}
writeFileSync(output, JSON.stringify(rows))
