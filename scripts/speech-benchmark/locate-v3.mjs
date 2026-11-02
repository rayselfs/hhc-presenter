/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript benchmark. */
// Candidate grammar; v2 stays frozen for paired regression evidence.
import { readFileSync, writeFileSync } from 'node:fs'
import { pinyin } from 'pinyin-pro'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'

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
  keys: [key(b.zh), key(b.zhCN), key(b.en), ...(b.en === 'Psalms' ? ['psalm'] : [])],
  sound: syllables(key(b.zh))
}))
const inhibited = (s) =>
  /(?:不要|別|勿|不必|不需要).{0,5}(?:翻|跳|切換|定位)|(?:只是|僅是|這是).{0,4}(?:範例|例子)|\b(?:do not|don't|never)\s+(?:turn|navigate|jump|switch)|\b(?:just an? example|example only)\b/i.test(
    s
  )
const locate = (text) => {
  if (inhibited(text)) return null
  const commanded = /^\s*(?:please turn to|turn to|please read)\s+/i.test(text)
  let clean = text
    .replace(/\b([123])(?:st|nd|rd)\b/gi, '$1')
    .replace(/[《》「」"']/g, '')
    .replace(/^\s*(?:請翻到|請翻開|請看|翻到|please turn to|turn to|please read)\s*/i, '')
    .trim()
  const repeated = clean
    .replace(/[.。!！]+$/, '')
    .split(/。\s*|\.\s+/)
    .map((s) => s.trim())
  if (repeated.length > 1 && repeated.every((s) => s === repeated[0])) clean = repeated[0]
  // Repair noisy structural markers only beside an exact full book name.
  const structural = clean.match(
    /^(.+?)[第記紀集及地的]?(\d+)[章張篇扎紮抓][第記紀集及地的]?(\d+)[節结結][.。!！\s]*$/u
  )
  if (structural && names.some((n) => n.keys.includes(key(structural[1]))))
    clean = `${structural[1]} chapter ${structural[2]} verse ${structural[3]}`
  const abbreviated = clean.match(/^(.+?)\s+(\d+)\s+verses?\s+(\d+)[.。!！\s]*$/i)
  const commandedNumeric =
    commanded && clean.match(/^(.+?)\s+(\d+)(?:\s*\.\s*|\s+)(\d+)[.。!！\s]*$/i)
  const citation = abbreviated || commandedNumeric
  if (citation && names.some((n) => n.keys.includes(key(citation[1]))))
    clean = `${citation[1]} chapter ${citation[2]} verse ${citation[3]}`
  const m = clean.match(
    /^(.+?)\s*(?:(?:chapter\s*|第?\s*)(\d+)\s*(?:章|張|篇)\s*(?:verse\s*|第?\s*)(\d+)\s*(?:節|节)?|chapter\s*(\d+)\s*verse\s*(\d+)|(\d+)\s*[:：]\s*(\d+))[.。!！\s]*$/i
  )
  if (!m) return null
  const chapter = Number(m[2] ?? m[4] ?? m[6])
  const verse = Number(m[3] ?? m[5] ?? m[7])
  const book = key(m[1])
  if (/第[零〇一二兩三四五六七八九十百\d]+[章節]/.test(book)) return null
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
    // Chinese full book names never start with a number; do not fuzzy-map a century/date.
    if (
      process.env.HHC_SPEECH_STRICT_CITATIONS === '1' &&
      /^[零〇一二兩三四五六七八九十百0-9]/u.test(book)
    )
      return null
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
  ['馬太福音第3章 verse 1', [40, 3, 1]],
  ['馬太福音集1章集1節', [40, 1, 1]],
  ['腓立比書第2扎第6節', [50, 2, 6]],
  ['雅各地2張地8節', null],
  ['第七節書第48章第5節', null],
  ['以西節書第41章第21節', [26, 41, 21]],
  ['Psalm 77 verse 20', [19, 77, 20]],
  ['Psalm is in room 77 on floor 20', null],
  ['Do not read Psalm 77 verse 20', null],
  ['哈該書第1章第1節。哈該書第1章第1節。', [37, 1, 1]],
  ['約翰福音第3章第16節。不要翻到約翰福音第3章第16節。', null],
  ['約翰福音第3章第16節。約翰福音第3章第17節。', null],
  ['Mark 8 verse 3', [41, 8, 3]],
  ['1 Corinthians 16 verse 5', [46, 16, 5]],
  ['Please read 1 Timothy 3.3', [54, 3, 3]],
  ['Please turn to 3 John 1 3', [64, 1, 3]],
  ['John 3.16 dollars', null],
  ['John 3.16', null],
  ['John 3 16', null],
  ['Please read John 3 16 dollars', null],
  ['Do not read John 3 16', null],
  ['Please read John 3 16, this is just an example', null],
  ['Please read John 99 1', null]
])
  assert.deepEqual(locate(text), expected, text)
assert.equal(inhibited('不要怕，只要信！'), false)
if (input === '--stdio') {
  console.log(JSON.stringify({ ready: true }))
  for await (const line of createInterface({ input: process.stdin })) {
    const row = JSON.parse(line)
    console.log(
      JSON.stringify({
        reference: locate(row.reference_normalized),
        inhibited: inhibited(row.reference_normalized),
        phonetic: phonetic(row.transcript)
      })
    )
  }
} else if (input === '--phonetic-corpus') {
  writeFileSync(
    output,
    JSON.stringify(scripture.map((b) => ({ chapters: b.chapters.map((c) => c.map(phonetic)) })))
  )
} else {
  const rows = JSON.parse(readFileSync(input, 'utf8'))
  for (const row of rows) {
    const start = performance.now()
    row.v2_reference = locate(row.reference_normalized ?? row.normalized)
    row.v2_inhibited = inhibited(row.reference_normalized ?? row.normalized)
    row.v2_phonetic = row.language === 'zh' ? phonetic(row.transcript) : ''
    row.v2_prepare_s = (performance.now() - start) / 1000
  }
  writeFileSync(output, JSON.stringify(rows))
}
