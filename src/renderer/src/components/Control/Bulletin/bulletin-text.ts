import type { BulletinFragment, BulletinHighlight, BulletinPosition } from '@shared/bulletin-reader'

const fragmentSelector = '[data-bulletin-sentence]'

type HighlightRun = { start: number; text: string; marked: boolean }

export function highlightRuns(
  fragment: BulletinFragment,
  highlights: BulletinHighlight[]
): HighlightRun[] {
  const text = Array.from(fragment.text)
  const intervals = highlights
    .filter((range) => range.sentenceId === fragment.sentenceId)
    .map((range) => ({
      start: Math.max(0, range.start - fragment.start),
      end: Math.min(text.length, range.end - fragment.start)
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start)

  const runs: HighlightRun[] = []
  const append = (from: number, to: number, marked: boolean): void => {
    if (to > from) runs.push({ start: from, text: text.slice(from, to).join(''), marked })
  }
  let cursor = 0
  for (const { start, end } of intervals) {
    append(cursor, start, false)
    append(Math.max(cursor, start), end, true)
    cursor = Math.max(cursor, end)
  }
  append(cursor, text.length, false)
  return runs
}

export function selectedHighlights(root: HTMLElement, selection: Selection): BulletinHighlight[] {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return []
  const selected = selection.getRangeAt(0)
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return []
  const result: BulletinHighlight[] = []
  for (const element of root.querySelectorAll<HTMLElement>(fragmentSelector)) {
    if (!selected.intersectsNode(element)) continue
    const intersection = root.ownerDocument.createRange()
    intersection.selectNodeContents(element)
    if (selected.compareBoundaryPoints(Range.START_TO_START, intersection) > 0)
      intersection.setStart(selected.startContainer, selected.startOffset)
    if (selected.compareBoundaryPoints(Range.END_TO_END, intersection) < 0)
      intersection.setEnd(selected.endContainer, selected.endOffset)
    const content = intersection.toString()
    if (!content) continue
    const prefix = root.ownerDocument.createRange()
    prefix.selectNodeContents(element)
    prefix.setEnd(intersection.startContainer, intersection.startOffset)
    const start = Number(element.dataset.start) + Array.from(prefix.toString()).length
    result.push({
      sentenceId: element.dataset.bulletinSentence!,
      start,
      end: start + Array.from(content).length
    })
  }
  return result
}

/** Locate a character after highlights split a fragment into multiple text nodes. */
function characterRect(element: HTMLElement, offset: number): DOMRect | undefined {
  const doc = element.ownerDocument
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let remaining = offset
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const points = Array.from(node.textContent ?? '')
    if (remaining < points.length) {
      const range = doc.createRange()
      const from = points.slice(0, remaining).join('').length
      range.setStart(node, from)
      range.setEnd(node, from + points[remaining].length)
      return range.getBoundingClientRect()
    }
    remaining -= points.length
  }
  return undefined
}

export function readPosition(root: HTMLElement): BulletinPosition | undefined {
  const { top, bottom } = root.getBoundingClientRect()
  if (!root.clientHeight) return
  const extent = Math.max(0, root.scrollHeight - root.clientHeight)
  if (extent > 0 && root.scrollTop >= extent - 0.5) return { scrollRatio: 1 }
  for (const element of root.querySelectorAll<HTMLElement>(fragmentSelector)) {
    const box = element.getBoundingClientRect()
    if (box.bottom <= top || box.top >= bottom) continue
    // Wrapped paragraphs can span the viewport. Pick the first visible line.
    let low = 0
    let high = Array.from(element.textContent ?? '').length - 1
    if (high < 0) continue
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if ((characterRect(element, middle)?.bottom ?? top) <= top) low = middle + 1
      else high = middle
    }
    return {
      sentenceId: element.dataset.bulletinSentence!,
      offset: Number(element.dataset.start) + low,
      within: ((characterRect(element, low)?.top ?? box.top) - top) / root.clientHeight
    }
  }
  return { scrollRatio: extent ? Math.max(0, Math.min(1, root.scrollTop / extent)) : 0 }
}

export function followPosition(root: HTMLElement, position: BulletinPosition): void {
  if (!root.clientHeight) return
  if ('scrollRatio' in position) {
    root.scrollTop = position.scrollRatio * Math.max(0, root.scrollHeight - root.clientHeight)
    return
  }
  for (const element of root.querySelectorAll<HTMLElement>(fragmentSelector)) {
    if (element.dataset.bulletinSentence !== position.sentenceId) continue
    const offset = position.offset - Number(element.dataset.start)
    if (offset < 0 || offset >= Array.from(element.textContent ?? '').length) continue
    const rect = characterRect(element, offset)
    if (rect) {
      root.scrollTop +=
        rect.top - root.getBoundingClientRect().top - position.within * root.clientHeight
    }
    return
  }
}
