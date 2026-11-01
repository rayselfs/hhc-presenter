// Exercise existing parser/matcher without changing production behavior.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@shared/types/bible') {
      return nextResolve(new URL('../../src/shared/types/bible.ts', import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  }
})
const { parseVerseReference } = await import('../../src/renderer/src/lib/verse-parser.ts')
const { matchBookName } = await import('../../src/renderer/src/lib/bible-book-matcher.ts')

const [root, output, ...files] = process.argv.slice(2)
const corpus = JSON.parse(readFileSync(path.join(root, 'corpus.json'), 'utf8'))
const datasets = [{ name: 'gold-text', rows: corpus }]
for (const file of files) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).slice(1)
  datasets.push({ name: path.basename(file), rows })
}
const results = []
for (const dataset of datasets) {
  const groups = {}
  const failures = []
  for (const row of dataset.rows) {
    if (!['reference', 'mixed'].includes(row.kind)) continue
    const parsed = parseVerseReference(row.transcript ?? row.text)
    const book = parsed ? matchBookName(parsed.book) : null
    const actual = book ? [book.bookNumber, parsed.chapter, parsed.verse] : null
    const key = `${row.language}/${row.kind}`
    groups[key] ??= { n: 0, correct: 0 }
    groups[key].n++
    if (JSON.stringify(actual) === JSON.stringify(row.target)) groups[key].correct++
    else
      failures.push({ id: row.id, input: row.transcript ?? row.text, expected: row.target, actual })
  }
  results.push({ dataset: dataset.name, groups, failures })
}
writeFileSync(output, JSON.stringify(results, null, 2))
console.log(
  JSON.stringify(
    results.map(({ dataset, groups }) => ({ dataset, groups })),
    null,
    2
  )
)
