import type {
  EditableTextParagraph,
  EditableTextRun,
  EditableTextStyle
} from './editable-presentation'
import { resolveTypingStyle, type normalizeTextParagraphs } from './presentation-rich-text'

export function readTextSelection(content: HTMLElement): { anchor: number; focus: number } | null {
  const selection = window.getSelection()
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !content.contains(selection.anchorNode) ||
    !content.contains(selection.focusNode)
  )
    return null
  return {
    anchor: getTextOffset(content, selection.anchorNode, selection.anchorOffset),
    focus: getTextOffset(content, selection.focusNode, selection.focusOffset)
  }
}

export function getTextSelectionPoints(
  content: HTMLElement,
  selection: { anchor: number; focus: number }
): { anchor: { node: Node; offset: number }; focus: { node: Node; offset: number } } {
  const locate = (position: number): { node: Node; offset: number } => {
    let remaining = Math.max(0, position)
    const paragraphs = Array.from(content.children)
    for (const [index, paragraph] of paragraphs.entries()) {
      const length = getEditableNodeText(paragraph).length
      if (remaining <= length || index === paragraphs.length - 1) {
        const walker = window.document.createTreeWalker(
          paragraph,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
        )
        let node: Node | null
        while ((node = walker.nextNode())) {
          if (node instanceof Text) {
            if (remaining <= node.length) return { node, offset: remaining }
            remaining -= node.length
          } else if (node instanceof HTMLBRElement) {
            if (remaining === 0)
              return { node: paragraph, offset: Array.from(paragraph.childNodes).indexOf(node) }
            remaining--
          }
        }
        return { node: paragraph, offset: paragraph.childNodes.length }
      }
      remaining -= length + 1
    }
    return { node: content, offset: 0 }
  }
  return { anchor: locate(selection.anchor), focus: locate(selection.focus) }
}

export function restoreTextSelection(
  content: HTMLElement,
  selection: { anchor: number; focus: number }
): void {
  const { anchor, focus } = getTextSelectionPoints(content, selection)
  window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
}

export function getTextOffset(content: HTMLElement, node: Node, nodeOffset: number): number {
  const paragraph =
    node instanceof Element
      ? node.closest<HTMLElement>('[data-text-paragraph]')
      : node.parentElement?.closest<HTMLElement>('[data-text-paragraph]')
  if (!paragraph || !content.contains(paragraph)) {
    const range = window.document.createRange()
    range.selectNodeContents(content)
    range.setEnd(node, nodeOffset)
    return range.toString().length
  }

  const paragraphs = Array.from(
    content.querySelectorAll<HTMLElement>(':scope > [data-text-paragraph]')
  )
  const paragraphIndex = paragraphs.indexOf(paragraph)
  const offsetBefore = paragraphs
    .slice(0, paragraphIndex)
    .reduce((length, item) => length + (item.textContent?.length ?? 0) + 1, 0)
  const range = window.document.createRange()
  range.selectNodeContents(paragraph)
  range.setEnd(node, nodeOffset)
  return offsetBefore + range.toString().length
}

export function serializeTextContent(
  content: HTMLDivElement,
  sourceParagraphs: ReturnType<typeof normalizeTextParagraphs>
): ReturnType<typeof normalizeTextParagraphs> {
  const paragraphNodes = Array.from(content.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement
  )
  if (paragraphNodes.length === 0) {
    const style = resolveTypingStyle(sourceParagraphs, 0)
    return [
      {
        ...sourceParagraphs[0],
        runs: style && content.textContent ? [{ text: content.textContent, ...style }] : [],
        typingStyle: style
      }
    ]
  }
  let previousSourceParagraph = sourceParagraphs[0]
  const resolvedSourceParagraphs = paragraphNodes.map((paragraphNode) => {
    const sourceParagraphIndex = Number(paragraphNode.dataset.textParagraph)
    const sourceParagraph =
      (Number.isInteger(sourceParagraphIndex) && sourceParagraphIndex >= 0
        ? sourceParagraphs[sourceParagraphIndex]
        : undefined) ??
      previousSourceParagraph ??
      sourceParagraphs.at(-1)!
    previousSourceParagraph = sourceParagraph
    return sourceParagraph
  })
  const selectionNode = window.getSelection()?.anchorNode
  const activeParagraphNode = selectionNode
    ? paragraphNodes.find((paragraphNode) => paragraphNode.contains(selectionNode))
    : undefined
  const typingStyleOwners = new Map<EditableTextParagraph, HTMLElement>()
  for (const sourceParagraph of new Set(resolvedSourceParagraphs)) {
    if (sourceParagraph.typingStyleCaret === undefined) continue
    const candidates = paragraphNodes.filter(
      (_, index) => resolvedSourceParagraphs[index] === sourceParagraph
    )
    typingStyleOwners.set(
      sourceParagraph,
      (activeParagraphNode && candidates.includes(activeParagraphNode)
        ? activeParagraphNode
        : candidates.at(-1))!
    )
  }
  return paragraphNodes.map((paragraphNode, paragraphIndex) => {
    const sourceParagraph = resolvedSourceParagraphs[paragraphIndex]
    const runs: EditableTextRun[] = []
    const nodes: Array<HTMLElement | Text> = []
    const collectNodes = (parent: Node): void => {
      parent.childNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.matches('[data-text-run]')) nodes.push(node)
        else if (
          node instanceof HTMLBRElement &&
          !(parent === paragraphNode && parent.childNodes.length === 1)
        ) {
          nodes.push(node)
        } else if (node instanceof Text) nodes.push(node)
        else collectNodes(node)
      })
    }
    collectNodes(paragraphNode)
    let typingStyleCaret =
      typingStyleOwners.get(sourceParagraph) === paragraphNode
        ? sourceParagraph.typingStyleCaret
        : undefined
    let offset = 0
    let nextSourceRunIndex = 0
    const removeMissingSourceRuns = (endIndex: number): void => {
      while (nextSourceRunIndex < Math.min(endIndex, sourceParagraph.runs.length)) {
        const edited = serializeEditedRun(
          sourceParagraph.runs[nextSourceRunIndex],
          '',
          offset,
          typingStyleCaret,
          sourceParagraph.typingStyle
        )
        typingStyleCaret = edited.typingStyleCaret
        nextSourceRunIndex++
      }
    }
    for (const [nodeIndex, node] of nodes.entries()) {
      if (node instanceof HTMLBRElement) {
        const previousNode = nodes[nodeIndex - 1]
        if (
          nodeIndex === nodes.length - 1 &&
          previousNode &&
          getEditableNodeText(previousNode).endsWith('\n')
        ) {
          continue
        }
        const style =
          typingStyleCaret === offset
            ? sourceParagraph.typingStyle
            : resolveTypingStyle([sourceParagraph], offset)
        if (style) runs.push({ text: '\n', ...style })
        if (typingStyleCaret !== undefined && typingStyleCaret >= offset) typingStyleCaret++
        offset++
        continue
      }
      if (node instanceof HTMLElement) {
        const text = getEditableNodeText(node)
        const runIndex = Number(node.dataset.textRun)
        const runSourceParagraphIndex = Number(node.dataset.sourceParagraph)
        const runSourceParagraph =
          (Number.isInteger(runSourceParagraphIndex) && runSourceParagraphIndex >= 0
            ? sourceParagraphs[runSourceParagraphIndex]
            : undefined) ?? sourceParagraph
        const usesCurrentSourceParagraph = runSourceParagraph === sourceParagraph
        if (
          usesCurrentSourceParagraph &&
          Number.isInteger(runIndex) &&
          runIndex >= nextSourceRunIndex
        ) {
          removeMissingSourceRuns(runIndex)
        }
        const sourceRun = runSourceParagraph.runs[runIndex] ?? runSourceParagraph.runs.at(-1)
        if (sourceRun) {
          const edited = serializeEditedRun(
            sourceRun,
            text,
            offset,
            usesCurrentSourceParagraph ? typingStyleCaret : undefined,
            usesCurrentSourceParagraph ? sourceParagraph.typingStyle : undefined
          )
          runs.push(...edited.runs)
          if (usesCurrentSourceParagraph) typingStyleCaret = edited.typingStyleCaret
        }
        if (usesCurrentSourceParagraph && Number.isInteger(runIndex) && runIndex >= 0) {
          nextSourceRunIndex = Math.max(nextSourceRunIndex, runIndex + 1)
        }
        offset += text.length
      } else {
        const text = node.textContent ?? ''
        const style =
          typingStyleCaret === offset
            ? sourceParagraph.typingStyle
            : resolveTypingStyle([sourceParagraph], offset)
        if (text && style) runs.push({ text, ...style })
        if (text && typingStyleCaret !== undefined && typingStyleCaret >= offset) {
          typingStyleCaret += text.length
        }
        offset += text.length
      }
    }
    removeMissingSourceRuns(sourceParagraph.runs.length)
    return {
      ...sourceParagraph,
      list: runs.length === 0 ? null : sourceParagraph.list,
      typingStyleCaret,
      runs
    }
  })
}

function getEditableNodeText(node: Node): string {
  if (node instanceof HTMLBRElement) return '\n'
  if (node instanceof Text) return node.textContent ?? ''
  const text = Array.from(node.childNodes, getEditableNodeText).join('')
  return node instanceof HTMLElement && text.endsWith('\n\n') ? text.slice(0, -1) : text
}

function serializeEditedRun(
  source: EditableTextRun,
  text: string,
  runStart: number,
  typingStyleCaret: number | undefined,
  typingStyle: EditableTextStyle | undefined
): { runs: EditableTextRun[]; typingStyleCaret: number | undefined } {
  if (text === source.text) return { runs: [{ ...source }], typingStyleCaret }

  let prefixLength = 0
  while (prefixLength < source.text.length && source.text[prefixLength] === text[prefixLength]) {
    prefixLength++
  }
  let suffixLength = 0
  while (
    suffixLength < source.text.length - prefixLength &&
    suffixLength < text.length - prefixLength &&
    source.text[source.text.length - 1 - suffixLength] === text[text.length - 1 - suffixLength]
  ) {
    suffixLength++
  }

  const insertedEnd = text.length - suffixLength
  const insertedLength = insertedEnd - prefixLength
  const editStart = runStart + prefixLength
  const editEnd = editStart + source.text.length - prefixLength - suffixLength
  let nextCaret = typingStyleCaret
  if (typingStyleCaret !== undefined) {
    if (typingStyleCaret > editEnd) {
      nextCaret = typingStyleCaret + insertedLength - (editEnd - editStart)
    } else if (typingStyleCaret >= editStart) nextCaret = editStart + insertedLength
  }
  if (!text) return { runs: [], typingStyleCaret: nextCaret }
  if (!typingStyle || typingStyleCaret !== editStart || insertedLength <= 0) {
    return { runs: [{ ...source, text }], typingStyleCaret: nextCaret }
  }

  const runs: EditableTextRun[] = []
  if (prefixLength > 0) runs.push({ ...source, text: text.slice(0, prefixLength) })
  if (insertedEnd > prefixLength) {
    runs.push({ text: text.slice(prefixLength, insertedEnd), ...typingStyle })
  }
  if (suffixLength > 0) runs.push({ ...source, text: text.slice(insertedEnd) })
  return { runs, typingStyleCaret: nextCaret }
}
