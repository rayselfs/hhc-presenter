import { ConverterFactory } from 'opencc-js/core'
import { from } from 'opencc-js/preset/cn2t'
const traditional = ConverterFactory(...from.cn)
export const SCRIPTURE_NORMALIZER_VERSION = 2
export function traditionalTranscript(text: string): string {
  return traditional(text.normalize('NFKC'))
}
export function normalizeScripture(text: string): string {
  return traditionalTranscript(text)
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(englishPattern, (value) => englishNumbers.get(value.toLowerCase()) ?? value)
    .replace(/[零〇一二兩三四五六七八九十百]+/gu, (value) => String(chineseNumber(value)))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
export function chineseNumber(text: string): number {
  const digits = '零一二三四五六七八九'
  let result = 0
  let current = 0
  for (const ch of text.replace(/〇/g, '零').replace(/兩/g, '二')) {
    if (ch === '十' || ch === '百') {
      result += (current || 1) * (ch === '十' ? 10 : 100)
      current = 0
    } else current = current * 10 + digits.indexOf(ch)
  }
  return result + current
}
const units = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen'
]
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
function numberWords(n: number): string {
  if (n < 20) return units[n]
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + units[n % 10] : '')
  return 'one hundred' + (n % 100 ? ' and ' + numberWords(n % 100) : '')
}
const englishNumbers = new Map(
  Array.from({ length: 176 }, (_, i) => [numberWords(i + 1), String(i + 1)])
)
englishNumbers.set('first', '1')
englishNumbers.set('second', '2')
englishNumbers.set('third', '3')
const englishPattern = new RegExp(
  '\\b(' + [...englishNumbers.keys()].sort((a, b) => b.length - a.length).join('|') + ')\\b',
  'gi'
)
export function normalizeCitation(text: string): string {
  const source = traditionalTranscript(text)
    .replace(/-/g, ' ')
    .replace(englishPattern, (value) => englishNumbers.get(value.toLowerCase()) ?? value)
  // Keep numbered book names intact; convert only chapter/verse numeral fields.
  const chapter = source.search(/[零〇一二兩三四五六七八九十百\d]+\s*[章張篇扎紮抓]/u)
  if (chapter < 0) return source
  return (
    source.slice(0, chapter) +
    source
      .slice(chapter)
      .replace(/[零〇一二兩三四五六七八九十百]+/gu, (value) => String(chineseNumber(value)))
  )
}
