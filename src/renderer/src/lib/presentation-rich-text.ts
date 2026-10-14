import type {
  EditableTextElement,
  EditableTextParagraph,
  EditableTextRun,
  EditableTextStyle
} from './editable-presentation'

type CharacterStylePatch = Partial<Omit<EditableTextRun, 'text'>>
export type TextCase = 'sentence' | 'lower' | 'upper' | 'capitalize' | 'toggle'

function runStyle(element: EditableTextElement, run?: EditableTextRun): EditableTextStyle {
  return {
    fontFamily: run?.fontFamily ?? element.fontFamily,
    fontSize: run?.fontSize ?? element.fontSize,
    bold: run?.bold ?? element.bold,
    italic: run?.italic ?? element.italic,
    underline: run?.underline ?? element.underline,
    color: run?.color ?? element.color,
    strikethrough: run?.strikethrough ?? element.strikethrough ?? false,
    baseline: run?.baseline ?? element.baseline ?? 'normal',
    characterSpacing: run?.characterSpacing ?? element.characterSpacing ?? 0,
    highlightColor:
      run?.highlightColor !== undefined ? run.highlightColor : (element.highlightColor ?? null)
  }
}

function paragraphFor(element: EditableTextElement): EditableTextParagraph {
  return {
    runs: [],
    typingStyle: runStyle(element),
    align: element.align,
    lineSpacing: { kind: 'multiple', value: element.lineHeight },
    list: null,
    marginLeft: 0,
    textIndent: 0
  }
}

function sameStyle(left: EditableTextRun, right: EditableTextRun): boolean {
  return (
    left.fontFamily === right.fontFamily &&
    left.fontSize === right.fontSize &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.color === right.color &&
    left.strikethrough === right.strikethrough &&
    left.baseline === right.baseline &&
    left.characterSpacing === right.characterSpacing &&
    left.highlightColor === right.highlightColor
  )
}

function mergeRuns(runs: EditableTextRun[]): EditableTextRun[] {
  const merged: EditableTextRun[] = []
  for (const run of runs) {
    if (!run.text) continue
    const previous = merged.at(-1)
    if (previous && sameStyle(previous, run)) previous.text += run.text
    else merged.push({ ...run })
  }
  return merged
}

export function normalizeTextParagraphs(element: EditableTextElement): EditableTextParagraph[] {
  if (element.paragraphs?.length) {
    return element.paragraphs.map((paragraph) => ({
      ...paragraph,
      typingStyle: paragraph.typingStyle ?? runStyle(element, paragraph.runs[0]),
      runs: mergeRuns(paragraph.runs.map((run) => ({ ...run, ...runStyle(element, run) })))
    }))
  }

  const paragraphs = [paragraphFor(element)]
  const sourceRuns = element.runs?.length
    ? element.runs
    : [{ text: element.text, ...runStyle(element) }]
  for (const sourceRun of sourceRuns) {
    const parts = sourceRun.text.split('\n')
    for (const [index, text] of parts.entries()) {
      if (index > 0) paragraphs.push(paragraphFor(element))
      if (text) paragraphs.at(-1)?.runs.push({ text, ...runStyle(element, sourceRun) })
    }
  }
  for (const paragraph of paragraphs) paragraph.runs = mergeRuns(paragraph.runs)
  return paragraphs
}

export function resolveParagraphListNumbers(
  paragraphs: readonly EditableTextParagraph[]
): (number | undefined)[] {
  const sequences = new Map<string, { start: number; count: number }>()
  return paragraphs.map((paragraph, index) => {
    const list = paragraph.list
    if (list?.kind !== 'number') return undefined
    if (!list.sequenceId) return (list.startAt ?? 1) + index
    const key = JSON.stringify([list.sequenceId, list.level])
    const sequence = sequences.get(key) ?? { start: list.startAt ?? 1, count: 0 }
    const value = sequence.start + sequence.count++
    sequences.set(key, sequence)
    return value
  })
}

function paragraphBounds(
  paragraphs: readonly EditableTextParagraph[],
  index: number
): { start: number; end: number } {
  let start = 0
  for (let current = 0; current < index; current++) {
    start += paragraphs[current].runs.reduce((length, run) => length + run.text.length, 0) + 1
  }
  return {
    start,
    end: start + paragraphs[index].runs.reduce((length, run) => length + run.text.length, 0)
  }
}

export function applyParagraphStyle(
  paragraphs: readonly EditableTextParagraph[],
  start: number,
  end: number,
  patch: Partial<Omit<EditableTextParagraph, 'runs' | 'typingStyle'>>
): EditableTextParagraph[] {
  return mapSelectedParagraphs(paragraphs, start, end, (paragraph) => ({ ...paragraph, ...patch }))
}

export function mapSelectedParagraphs(
  paragraphs: readonly EditableTextParagraph[],
  start: number,
  end: number,
  update: (paragraph: EditableTextParagraph) => EditableTextParagraph
): EditableTextParagraph[] {
  const from = Math.max(0, Math.min(start, end))
  const to = Math.max(from, Math.max(start, end))
  return paragraphs.map((paragraph, index) => {
    const bounds = paragraphBounds(paragraphs, index)
    const selected =
      from === to
        ? from >= bounds.start && from <= bounds.end
        : to > bounds.start && from <= bounds.end
    return selected ? update(paragraph) : { ...paragraph }
  })
}

export function resolveTypingStyle(
  paragraphs: readonly EditableTextParagraph[],
  caret: number
): EditableTextStyle | undefined {
  let offset = 0
  for (const paragraph of paragraphs) {
    if (paragraph.typingStyleCaret === caret - offset && paragraph.typingStyle) {
      return paragraph.typingStyle
    }
    for (const run of paragraph.runs) {
      const end = offset + run.text.length
      if (caret <= end) return { ...runStyleFromRun(run) }
      offset = end
    }
    if (caret === offset) return paragraph.typingStyle
    offset++
  }
  const paragraph = paragraphs.at(-1)
  const run = paragraph?.runs.at(-1)
  return run ? runStyleFromRun(run) : paragraph?.typingStyle
}

function runStyleFromRun(run: EditableTextRun): EditableTextStyle {
  return {
    fontFamily: run.fontFamily,
    fontSize: run.fontSize,
    bold: run.bold,
    italic: run.italic,
    underline: run.underline,
    strikethrough: run.strikethrough ?? false,
    baseline: run.baseline ?? 'normal',
    characterSpacing: run.characterSpacing ?? 0,
    color: run.color,
    highlightColor: run.highlightColor ?? null
  }
}

export function getCharacterStyleValue<K extends keyof EditableTextStyle>(
  paragraphs: readonly EditableTextParagraph[],
  start: number,
  end: number,
  key: K
): EditableTextStyle[K] | 'mixed' | undefined {
  const from = Math.max(0, Math.min(start, end))
  const to = Math.max(from, Math.max(start, end))
  if (from === to) return resolveTypingStyle(paragraphs, from)?.[key]
  let offset = 0
  let value: EditableTextStyle[K] | undefined
  for (const paragraph of paragraphs) {
    for (const run of paragraph.runs) {
      const runEnd = offset + run.text.length
      if (Math.max(offset, from) < Math.min(runEnd, to)) {
        const next = runStyleFromRun(run)[key]
        if (value !== undefined && value !== next) return 'mixed'
        value = next
      }
      offset = runEnd
    }
    offset++
  }
  return value
}

export function getPlainText(paragraphs: readonly EditableTextParagraph[]): string {
  return paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join('')).join('\n')
}

export function applyCharacterStyle(
  paragraphs: readonly EditableTextParagraph[],
  start: number,
  end: number,
  patch: CharacterStylePatch
): EditableTextParagraph[] {
  const from = Math.max(0, Math.min(start, end))
  const to = Math.max(from, Math.max(start, end))
  let offset = 0
  return paragraphs.map((paragraph, paragraphIndex) => {
    if (from === to) {
      const bounds = paragraphBounds(paragraphs, paragraphIndex)
      if (from >= bounds.start && from <= bounds.end) {
        const caret = from - bounds.start
        const typingStyle =
          (paragraph.typingStyleCaret === caret
            ? paragraph.typingStyle
            : resolveTypingStyle([paragraph], caret)) ?? paragraph.typingStyle
        if (!typingStyle) return { ...paragraph }
        return {
          ...paragraph,
          typingStyle: {
            ...typingStyle,
            ...patch
          },
          typingStyleCaret: caret
        }
      }
      return { ...paragraph }
    }
    const runs: EditableTextRun[] = []
    for (const run of paragraph.runs) {
      const runStart = offset
      const runEnd = runStart + run.text.length
      const selectedStart = Math.max(runStart, from)
      const selectedEnd = Math.min(runEnd, to)
      if (selectedStart <= runStart && selectedEnd >= runEnd) runs.push({ ...run, ...patch })
      else if (selectedStart < selectedEnd) {
        const localStart = selectedStart - runStart
        const localEnd = selectedEnd - runStart
        runs.push(
          { ...run, text: run.text.slice(0, localStart) },
          { ...run, ...patch, text: run.text.slice(localStart, localEnd) },
          { ...run, text: run.text.slice(localEnd) }
        )
      } else runs.push({ ...run })
      offset = runEnd
    }
    if (paragraphIndex < paragraphs.length - 1) offset++
    return { ...paragraph, runs: mergeRuns(runs), typingStyleCaret: undefined }
  })
}

export function clearCharacterFormatting(
  paragraphs: readonly EditableTextParagraph[],
  start: number,
  end: number,
  defaults: Pick<EditableTextRun, 'fontFamily' | 'fontSize' | 'color'>
): EditableTextParagraph[] {
  return applyCharacterStyle(paragraphs, start, end, {
    ...defaults,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    baseline: 'normal',
    characterSpacing: 0,
    highlightColor: null
  })
}

export function changeTextCase(
  paragraphs: readonly EditableTextParagraph[],
  start: number,
  end: number,
  textCase: TextCase
): EditableTextParagraph[] {
  const from = Math.max(0, Math.min(start, end))
  const to = Math.max(from, Math.max(start, end))
  let offset = 0
  let sentenceStart = true
  return paragraphs.map((paragraph, paragraphIndex) => {
    const runs = paragraph.runs.map((run) => {
      const runStart = offset
      const runEnd = runStart + run.text.length
      const localStart = Math.max(0, from - runStart)
      const localEnd = Math.min(run.text.length, to - runStart)
      offset = runEnd
      if (localStart >= localEnd) return { ...run }
      const selected = run.text.slice(localStart, localEnd)
      const transformed = transformCase(selected, textCase, sentenceStart)
      sentenceStart = /[.!?]\s*$/.test(transformed)
      return {
        ...run,
        text: `${run.text.slice(0, localStart)}${transformed}${run.text.slice(localEnd)}`
      }
    })
    if (paragraphIndex < paragraphs.length - 1) offset++
    return { ...paragraph, runs: mergeRuns(runs) }
  })
}

function transformCase(text: string, textCase: TextCase, sentenceStart: boolean): string {
  if (textCase === 'lower') return text.toLocaleLowerCase()
  if (textCase === 'upper') return text.toLocaleUpperCase()
  if (textCase === 'toggle')
    return [...text]
      .map((character) =>
        character === character.toLocaleUpperCase()
          ? character.toLocaleLowerCase()
          : character.toLocaleUpperCase()
      )
      .join('')
  if (textCase === 'capitalize')
    return text.replace(
      /(^|\s)(\p{L})/gu,
      (_, spacing: string, letter: string) => `${spacing}${letter.toLocaleUpperCase()}`
    )
  const lower = text.toLocaleLowerCase()
  const sentencePattern = sentenceStart ? /(^|[.!?]\s+)(\p{L})/gu : /([.!?]\s+)(\p{L})/gu
  return lower.replace(
    sentencePattern,
    (_, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase()}`
  )
}
