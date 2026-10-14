import { describe, expect, it } from 'vitest'
import { createTextElement, type EditableTextParagraph } from '../editable-presentation'
import {
  applyCharacterStyle,
  applyParagraphStyle,
  changeTextCase,
  clearCharacterFormatting,
  getCharacterStyleValue,
  getPlainText,
  normalizeTextParagraphs,
  resolveTypingStyle,
  resolveParagraphListNumbers
} from '../presentation-rich-text'

describe('presentation rich text', () => {
  it('keeps legacy numbering while honoring explicit independent sequences and levels', () => {
    const paragraphs = normalizeTextParagraphs(
      createTextElement({ text: 'plain\none\ntwo\nrestart\nnested' })
    )
    paragraphs[1].list = { kind: 'number', level: 0, format: 'arabicPeriod', startAt: 3 }
    paragraphs[2].list = { kind: 'number', level: 0, format: 'arabicPeriod', startAt: 3 }
    expect(resolveParagraphListNumbers(paragraphs)).toEqual([undefined, 4, 5, undefined, undefined])
    paragraphs[1].list.sequenceId = 'first'
    paragraphs[2].list.sequenceId = 'first'
    paragraphs[3].list = {
      kind: 'number',
      level: 0,
      format: 'arabicPeriod',
      startAt: 1,
      sequenceId: 'restart'
    }
    paragraphs[4].list = {
      kind: 'number',
      level: 1,
      format: 'arabicPeriod',
      startAt: 1,
      sequenceId: 'first'
    }
    expect(resolveParagraphListNumbers(paragraphs)).toEqual([undefined, 3, 4, 1, 1])
  })

  it('keeps explicit no-highlight runs clear of the element fallback', () => {
    const element = createTextElement({ text: 'AB', highlightColor: '#FFFF00' })
    const run = {
      text: 'A',
      fontFamily: element.fontFamily,
      fontSize: element.fontSize,
      bold: false,
      italic: false,
      underline: false,
      color: element.color,
      highlightColor: '#FFFF00'
    }
    element.runs = [run, { ...run, text: 'B', highlightColor: null }]
    expect(normalizeTextParagraphs(element)[0].runs.map((value) => value.highlightColor)).toEqual([
      '#FFFF00',
      null
    ])
  })

  it('normalizes legacy runs into paragraphs without flattening styles', () => {
    const element = createTextElement({
      text: 'Bold plain\nSecond',
      runs: [
        {
          text: 'Bold',
          fontFamily: 'Arial',
          fontSize: 40,
          bold: true,
          italic: false,
          underline: false,
          color: '#111111'
        },
        {
          text: ' plain\nSecond',
          fontFamily: 'Arial',
          fontSize: 40,
          bold: false,
          italic: false,
          underline: false,
          color: '#222222'
        }
      ],
      align: 'center',
      lineHeight: 1.5
    })

    const paragraphs = normalizeTextParagraphs(element)

    expect(getPlainText(paragraphs)).toBe('Bold plain\nSecond')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]).toMatchObject({
      align: 'center',
      lineSpacing: { kind: 'multiple', value: 1.5 }
    })
    expect(paragraphs[0].runs.map((run) => [run.text, run.bold, run.color])).toEqual([
      ['Bold', true, '#111111'],
      [' plain', false, '#222222']
    ])
  })

  it('patches only characters inside the selected range', () => {
    const paragraphs = normalizeTextParagraphs(createTextElement({ text: 'Hello world' }))

    const updated = applyCharacterStyle(paragraphs, 6, 11, { bold: true })

    expect(updated[0].runs.map((run) => [run.text, run.bold])).toEqual([
      ['Hello ', false],
      ['world', true]
    ])
  })

  it('keeps a typing style for empty text and merges identical adjacent runs', () => {
    const empty = normalizeTextParagraphs(createTextElement({ text: '', color: '#123456' }))
    const merged = normalizeTextParagraphs(
      createTextElement({
        text: 'Hello',
        runs: [
          { ...createTextElement(), text: 'Hel' },
          { ...createTextElement(), text: 'lo' }
        ]
      })
    )

    expect(resolveTypingStyle(empty, 0)).toMatchObject({ color: '#123456' })
    expect(merged[0].runs).toHaveLength(1)
    expect(merged[0].runs[0].text).toBe('Hello')
    expect(applyCharacterStyle(merged, 3, 3, { bold: true })[0]).toMatchObject({
      typingStyle: { bold: true },
      typingStyleCaret: 3
    })
    expect(
      applyCharacterStyle(applyCharacterStyle(merged, 3, 3, { bold: true }), 3, 3, {
        italic: true
      })[0]
    ).toMatchObject({ typingStyle: { bold: true, italic: true }, typingStyleCaret: 3 })
  })

  it('patches paragraph settings and reports mixed character values', () => {
    const paragraphs = normalizeTextParagraphs(
      createTextElement({
        text: 'Bold\nPlain',
        runs: [
          { ...createTextElement({ bold: true }), text: 'Bold' },
          { ...createTextElement(), text: '\nPlain' }
        ]
      })
    )

    const updated = applyParagraphStyle(paragraphs, 0, 10, {
      align: 'justify',
      list: { kind: 'number', level: 1, format: 'arabicPeriod', startAt: 1 }
    })

    expect(updated.every((paragraph) => paragraph.align === 'justify')).toBe(true)
    expect(updated.every((paragraph) => paragraph.list?.kind === 'number')).toBe(true)
    expect(getCharacterStyleValue(paragraphs, 0, 10, 'bold')).toBe('mixed')
    expect(getCharacterStyleValue(paragraphs, 0, 4, 'bold')).toBe(true)
  })

  it('resolves caret styles and pending typing styles without formatting the next paragraph', () => {
    const paragraphs = normalizeTextParagraphs(createTextElement({ text: 'abcde plain\nnext' }))
    const bold = applyCharacterStyle(paragraphs, 0, 5, { bold: true })
    expect(getCharacterStyleValue(bold, 0, 0, 'bold')).toBe(true)
    expect(getCharacterStyleValue(bold, 5, 5, 'bold')).toBe(true)
    expect(getCharacterStyleValue(bold, 6, 6, 'bold')).toBe(false)
    const pending = applyCharacterStyle(bold, 6, 6, { bold: true, fontFamily: 'Arial' })
    expect(getCharacterStyleValue(pending, 6, 6, 'bold')).toBe(true)
    expect(getCharacterStyleValue(pending, 6, 6, 'fontFamily')).toBe('Arial')
    expect(applyParagraphStyle(bold, 0, 12, { align: 'center' }).map((p) => p.align)).toEqual([
      'center',
      'left'
    ])
  })

  it('clears character formatting while preserving paragraph formatting', () => {
    const paragraph: EditableTextParagraph = {
      runs: [
        {
          text: 'Heading',
          fontFamily: 'Arial',
          fontSize: 72,
          bold: true,
          italic: true,
          underline: true,
          color: '#ff0000',
          strikethrough: true,
          baseline: 'superscript',
          characterSpacing: 3,
          highlightColor: '#ffff00'
        }
      ],
      align: 'justify',
      lineSpacing: { kind: 'exact', points: 30 },
      list: { kind: 'bullet', level: 2, char: '•' },
      marginLeft: 48,
      textIndent: -24
    }

    const [cleared] = clearCharacterFormatting([paragraph], 0, 7, {
      fontFamily: 'Inter Variable',
      fontSize: 48,
      color: '#111827'
    })

    expect(cleared).toMatchObject({
      align: 'justify',
      lineSpacing: { kind: 'exact', points: 30 },
      list: { kind: 'bullet', level: 2, char: '•' },
      marginLeft: 48,
      textIndent: -24
    })
    expect(cleared.runs[0]).toEqual({
      text: 'Heading',
      fontFamily: 'Inter Variable',
      fontSize: 48,
      bold: false,
      italic: false,
      underline: false,
      color: '#111827',
      strikethrough: false,
      baseline: 'normal',
      characterSpacing: 0,
      highlightColor: null
    })
  })

  it('changes only the selected characters without flattening run styles', () => {
    const paragraphs = normalizeTextParagraphs(createTextElement({ text: 'hello WORLD' }))

    expect(getPlainText(changeTextCase(paragraphs, 0, 5, 'upper'))).toBe('HELLO WORLD')
    expect(getPlainText(changeTextCase(paragraphs, 6, 11, 'lower'))).toBe('hello world')
    expect(getPlainText(changeTextCase(paragraphs, 0, 11, 'toggle'))).toBe('HELLO world')
  })
})
