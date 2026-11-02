import { expect, it } from 'vitest'
import type { BibleBook } from '@shared/types/bible'
import { locateSpokenReference, inhibitedSpeech } from './spoken-reference'
import { normalizeScripture, normalizeCitation } from './scripture-normalize'
const books: BibleBook[] = [1, 19, 43, 47, 62, 63, 64].map((number) => ({
  number,
  code: '',
  name: '',
  abbreviation: '',
  chapters: [1, 3, 6, 101].map((chapter) => ({
    number: chapter,
    verses: [1, 3, 5, 16].map((verse) => ({
      id: number * 10000 + chapter * 100 + verse,
      number: verse,
      text: ''
    }))
  }))
}))
it.each([
  ['2 John 1:5', [63, 1, 5]],
  ['2nd Corinthians chapter six verse three', [47, 6, 3]],
  ['詩篇一百零一篇一節', [19, 101, 1]],
  ['创世纪第一章第一节', [1, 1, 1]],
  ['Please turn to 3 John 1 3', [64, 1, 3]],
  ['John chapter three verse sixteen', [43, 3, 16]],
  ['不要翻到約翰福音三章十六節', null],
  ['John chapter 3 verse 16 is just an example', null],
  ['John is in room 16 on the third floor', null],
  ['約翰福音第99章第1節', null],
  ['約翰福音三章', null],
  ['John 3.16 dollars', null],
  ['約翰福音三章十六節，請不要切換', null]
])('safely locates %s', (text, expected) => {
  expect(locateSpokenReference(text, books)).toEqual(expected)
})
it('uses the same traditional normalization for indexing and queries without altering canonical text', () => {
  expect(normalizeScripture('神爱世人，John’s')).toBe(normalizeScripture('神愛世人 John s'))
  expect(normalizeCitation('約翰一書第一章第三節')).toBe('約翰一書第1章第3節')
  expect(inhibitedSpeech('不要怕，只要信！')).toBe(false)
})
it('offers ranges and chapters for explicit confirmation without inventing missing verse numbers', async () => {
  const { suggestSpokenReference } = await import('./spoken-reference')
  expect(
    suggestSpokenReference('John chapter three verses one to sixteen', books)?.reference
  ).toEqual([43, 3, 1])
  expect(suggestSpokenReference('約翰福音第三章第一至十六節', books)?.reference).toEqual([43, 3, 1])
  expect(suggestSpokenReference('John 3:16-99', books)).toBeNull()
  expect(suggestSpokenReference('John chapter 3', books)?.label).toBe(' 3')
  expect(suggestSpokenReference('不是三章，是四章', books)).toBeNull()
})
it('expires relative suggestions after thirty seconds and requires same-session explicit context', async () => {
  const { suggestSpokenReference } = await import('./spoken-reference')
  const context = { reference: [43, 3, 1] as [number, number, number], acceptedAt: 100 }
  expect(suggestSpokenReference('接下來十六節', books, context, 1000)?.reference).toEqual([
    43, 3, 16
  ])
  expect(suggestSpokenReference('next verse sixteen', books, context, 1000)?.reference).toEqual([
    43, 3, 16
  ])
  expect(suggestSpokenReference('接下來十六節', books, undefined, 1000)).toBeNull()
  expect(suggestSpokenReference('接下來十六節', books, context, 30101)).toBeNull()
})
