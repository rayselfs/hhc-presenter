/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript benchmark. */
// Experimental complete-reference grammar, independent from product navigation.
import { readFileSync, writeFileSync } from 'node:fs'
import { pinyin } from 'pinyin-pro'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const [root, input, output] = process.argv.slice(2)
const books = JSON.parse(readFileSync(`${root}/books.json`, 'utf8'))
const scripture = JSON.parse(
  readFileSync(`${root}/sources/zh_cuv.json`, 'utf8').replace(/^\uFEFF/, '')
)
const phonetic = (s) => pinyin(s, { toneType: 'none', type: 'array' }).join(' ')
const key = (s) =>
  s
    .toLowerCase()
    .replace(/[一二三]/g, (c) => String('一二三'.indexOf(c) + 1))
    .replace(/[\s《》「」"'.,，。]/g, '')
const syllables = (s) =>
  phonetic(s.replace(/[123]/g, (c) => '一二三'[Number(c) - 1])).replace(/\s/g, '')
const distance = (a, b) => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + Number(a[i] !== b[j])))
    previous = next
  }
  return previous[b.length]
}
const names = books.map((b, i) => ({
  id: i + 1,
  keys: [key(b.zh), key(b.zhCN), key(b.en)],
  sound: syllables(key(b.zh))
}))
const inhibited = (s) =>
  /(?:不要|別|勿|不必|不需要).{0,5}(?:翻|跳|切換|定位)|(?:只是|僅是|這是).{0,4}(?:範例|例子)|\b(?:do not|don't|never)\s+(?:turn|navigate|jump|switch)|\b(?:just an? example|example only)\b/i.test(
    s
  )
const locate = (text) => {
  if (inhibited(text)) return null
  const clean = text
    .replace(/\b([123])(?:st|nd|rd)\b/gi, '$1')
    .replace(/[《》「」"']/g, '')
    .replace(/^\s*(?:請翻到|請翻開|請看|翻到|please turn to|turn to|please read)\s*/i, '')
    .trim()
  const m = clean.match(
    /^(.+?)\s*(?:(?:chapter\s*|第?\s*)(\d+)\s*(?:章|張|篇)\s*(?:verse\s*|第?\s*)(\d+)\s*(?:節|节)?|chapter\s*(\d+)\s*verse\s*(\d+)|(\d+)\s*[:：]\s*(\d+))[.。!！\s]*$/i
  )
  if (!m) return null
  const chapter = Number(m[2] ?? m[4] ?? m[6])
  const verse = Number(m[3] ?? m[5] ?? m[7])
  const book = key(m[1])
  const exact = names.filter((n) => n.keys.includes(book))
  let id = exact.length === 1 ? exact[0].id : null
  if (!id && /^[\p{Script=Han}123]+$/u.test(book)) {
    const sound = syllables(book)
    const candidates = names
      .map((n) => ({
        id: n.id,
        score: 1 - distance(sound, n.sound) / Math.max(sound.length, n.sound.length)
      }))
      .sort((a, b) => b.score - a.score)
    if (candidates[0].score >= 0.75 && candidates[0].score - candidates[1].score >= 0.12)
      id = candidates[0].id
  }
  return id && scripture[id - 1]?.chapters[chapter - 1]?.[verse - 1] ? [id, chapter, verse] : null
}
for (const [text, expected] of [
  ['2nd John chapter 1 verse 3', [63, 1, 3]],
  ['2nd Corinthians chapter 6 verse 3', [47, 6, 3]],
  ['2nd Thessalonians chapter 1 verse 3', [53, 1, 3]],
  ['John is in room 16 on the third floor.', null],
  ['不要翻到約翰福音第3章第16節', null],
  ['Do not turn to John chapter 3 verse 16', null],
  ['John chapter 3 verse 16 is just an example', null],
  ['亞各書第2章第3節', [59, 2, 3]],
  ['約翰福音第99章第1節', null],
  ['John chapter 3', null],
  ['馬太福音第3章 verse 1', [40, 3, 1]]
])
  assert.deepEqual(locate(text), expected, text)
assert.equal(inhibited('不要怕，只要信！'), false)
if (input === '--phonetic-corpus') {
  writeFileSync(
    output,
    JSON.stringify(scripture.map((b) => ({ chapters: b.chapters.map((c) => c.map(phonetic)) })))
  )
} else {
  const rows = JSON.parse(readFileSync(input, 'utf8'))
  for (const row of rows) {
    const start = performance.now()
    row.v2_reference = locate(row.normalized)
    row.v2_inhibited = inhibited(row.normalized)
    row.v2_phonetic = row.language === 'zh' ? phonetic(row.transcript) : ''
    row.v2_prepare_s = (performance.now() - start) / 1000
  }
  writeFileSync(output, JSON.stringify(rows))
}
