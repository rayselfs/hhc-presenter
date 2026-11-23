import { expect, it } from 'vitest'
import { VerseCandidates } from './verse-candidates'
const books = ['哥林多前書', '哥林多後書'].map((name, i) => ({
  name,
  number: 46 + i,
  code: '',
  abbreviation: '',
  chapters: [{ number: 4, verses: [{ number: 7, id: 7, text: 'verse seven' }] }]
}))
it.each([
  ['我們來看哥林多前書，抱歉，是後書，四章七節'],
  ['請大家翻到哥林多前書', '對不起，是後書', '第四章', '第七節'],
  ['哥林多後書', '第四章', '第七節']
])('resolves the complete citation after %s', (...parts: string[]) => {
  const resolver = new VerseCandidates()
  for (const part of parts.slice(0, -1)) expect(resolver.accept(part, books, 0)).toBeNull()
  expect(resolver.accept(parts.at(-1)!, books, 1000)).toMatchObject({
    bookNumber: 47,
    chapter: 4,
    verse: 7
  })
})
it('rejects an unqualified correction, expired context and negation', () => {
  const resolver = new VerseCandidates()
  expect(resolver.accept('哥林多前書', books, 0)).toBeNull()
  expect(resolver.accept('抱歉，是後書四章七節', books, 6000)).toBeNull()
  expect(resolver.accept('不要翻到哥林多前書，抱歉，是後書四章七節', books)).toBeNull()
})

it('accepts a spoken Genesis citation ending with transcription punctuation', () => {
  const genesis = {
    name: '創世記',
    number: 1,
    code: 'gen',
    abbreviation: '創',
    chapters: [{ number: 1, verses: [{ number: 1, id: 1, text: '起初' }] }]
  }
  expect(new VerseCandidates().accept('创世纪第一章第一节：', [genesis])).toMatchObject({
    bookNumber: 1,
    chapter: 1,
    verse: 1,
    text: '起初'
  })
})
