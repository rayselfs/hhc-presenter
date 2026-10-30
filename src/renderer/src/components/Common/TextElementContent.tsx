import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadPresentationFont } from '@renderer/lib/font-loader'
import type {
  EditablePresentationElement,
  EditableTextParagraph
} from '@renderer/lib/editable-presentation'
import {
  CONTENT_HEIGHT_TEXT_PADDING_X,
  CONTENT_HEIGHT_TEXT_PADDING_Y,
  INSERTED_TEXT_CLICK_SIZE,
  hasContentHeight
} from '@renderer/lib/editable-presentation'
import {
  getPlainText,
  normalizeTextParagraphs,
  resolveParagraphListNumbers
} from '@renderer/lib/presentation-rich-text'
import {
  readTextSelection,
  getTextSelectionPoints,
  restoreTextSelection,
  getTextOffset,
  serializeTextContent
} from '@renderer/lib/presentation-text-dom'
import type { EditableTextSelection, TextEditFinalizer } from '@renderer/types/presentation-text'

const TEXT_AUTO_MIN_WIDTH = INSERTED_TEXT_CLICK_SIZE.width

function isContentAutoSizedText(
  element: Extract<EditablePresentationElement, { type: 'text' }>
): boolean {
  return hasContentHeight(element)
}

function measureAutoSizedTextElement(
  source: HTMLDivElement | null,
  element: Extract<EditablePresentationElement, { type: 'text' }>,
  text: string
): Partial<EditablePresentationElement> {
  if (!source || !window.document.body) return {}
  const measure = source.cloneNode(true) as HTMLDivElement
  if (!measure.childNodes.length) measure.textContent = text || ' '
  Object.assign(measure.style, {
    position: 'absolute',
    left: '-10000px',
    top: '-10000px',
    width: 'auto',
    height: 'auto',
    minWidth: '0',
    maxWidth: 'none',
    overflow: 'visible',
    pointerEvents: 'none',
    visibility: 'hidden',
    whiteSpace: 'pre'
  })
  window.document.body.appendChild(measure)

  const width =
    element.autoWidth === true
      ? Math.max(TEXT_AUTO_MIN_WIDTH, Math.ceil(measure.scrollWidth))
      : element.width
  measure.style.width = `${width}px`
  measure.style.whiteSpace = 'pre-wrap'
  measure.style.overflowWrap = 'break-word'
  const height = Math.max(
    Math.ceil(element.fontSize * element.lineHeight),
    Math.ceil(measure.scrollHeight)
  )
  measure.remove()

  const updates: Partial<EditablePresentationElement> = {}
  if (element.autoWidth === true && Math.abs(width - element.width) >= 1) updates.width = width
  if (hasContentHeight(element) && Math.abs(height - element.height) >= 1) {
    updates.height = height
  }
  return updates
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

function createCaretRangeFromPoint(x: number, y: number, content: HTMLElement): Range | null {
  const ownerDocument = window.document as CaretDocument
  const position = ownerDocument.caretPositionFromPoint?.(x, y)
  if (position && content.contains(position.offsetNode)) {
    const range = ownerDocument.createRange()
    range.setStart(position.offsetNode, position.offset)
    range.collapse(true)
    return range
  }

  const range = ownerDocument.caretRangeFromPoint?.(x, y) ?? null
  return range && content.contains(range.startContainer) ? range : null
}

export default function TextElementContent({
  element,
  slideId,
  editable,
  editing,
  onUpdateElement,
  onStartTextEdit,
  onFinishTextEdit,
  onTextEditFinalizerChange,
  onTextSelectionChange,
  onTextLayoutChange,
  onTextIndent
}: {
  element: Extract<EditablePresentationElement, { type: 'text' }>
  slideId: string
  editable: boolean
  editing: boolean
  onUpdateElement?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void
  onStartTextEdit?: () => void
  onFinishTextEdit?: () => void
  onTextEditFinalizerChange?: (finalize: TextEditFinalizer | null) => void
  onTextSelectionChange?: (selection: EditableTextSelection | null) => void
  onTextLayoutChange?: (
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ) => void
  onTextIndent?: (direction: -1 | 1) => void
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const editingRef = useRef(editing)
  const finalizeTextEditRef = useRef<() => boolean>(() => true)
  const flushTextRef = useRef<() => boolean>(() => true)
  const initializedEditingElementRef = useRef<string | null>(null)
  const blurFrameRef = useRef<number | null>(null)
  const textFrameRef = useRef<number | null>(null)
  const pendingBlurTextRef = useRef<string | null>(null)
  const hasPendingTextRef = useRef(false)
  const pendingCaretPointRef = useRef<{ x: number; y: number } | null>(null)
  const registeredFinalizerRef = useRef<TextEditFinalizer | null>(null)
  const measuredLayoutRef = useRef<unknown[]>([])
  const contentHeight = hasContentHeight(element)
  const paragraphs = useMemo(() => normalizeTextParagraphs(element), [element])
  const listNumbers = useMemo(() => resolveParagraphListNumbers(paragraphs), [paragraphs])
  const hasRichText = Boolean(element.paragraphs?.length || element.runs?.length)
  const [template] = useState(() => window.document.createElement('div'))
  const domParagraphsRef = useRef(paragraphs)
  const domModelRef = useRef<string | null>(null)
  const retainedSelectionRef = useRef<{ anchor: number; focus: number } | null>(null)

  const fontKey = JSON.stringify([
    ...new Set([
      element.fontFamily,
      ...paragraphs.flatMap((paragraph) => paragraph.runs.map((run) => run.fontFamily))
    ])
  ])
  const [loadedFontKey, setLoadedFontKey] = useState('')
  useEffect(() => {
    let active = true
    const families: string[] = JSON.parse(fontKey)
    void Promise.allSettled(families.map(loadPresentationFont)).then(() => {
      if (active) setLoadedFontKey(fontKey)
    })
    return () => {
      active = false
    }
  }, [fontKey])

  const notifyTextEditLifecycle = useCallback((): void => {
    onTextEditFinalizerChange?.(registeredFinalizerRef.current)
  }, [onTextEditFinalizerChange])

  const settlePendingText = (): void => {
    if (isComposingRef.current || !hasPendingTextRef.current) return
    scheduleTextCommit()
  }

  const cancelPendingBlur = (): void => {
    if (blurFrameRef.current == null) return
    window.cancelAnimationFrame(blurFrameRef.current)
    blurFrameRef.current = null
    pendingBlurTextRef.current = null
    settlePendingText()
  }

  const commitText = (): void => {
    const content = contentRef.current
    if (!content) return
    if (!hasPendingTextRef.current) {
      notifyTextEditLifecycle()
      return
    }
    const nextParagraphs = serializeTextContent(content, domParagraphsRef.current)
    const text = getPlainText(nextParagraphs)
    if (text === element.text && JSON.stringify(nextParagraphs) === JSON.stringify(paragraphs)) {
      hasPendingTextRef.current = false
      notifyTextEditLifecycle()
      return
    }
    if (
      nextParagraphs.length === domParagraphsRef.current.length &&
      !domParagraphsRef.current.some((paragraph) => paragraph.typingStyleCaret !== undefined)
    ) {
      domModelRef.current = JSON.stringify(nextParagraphs)
    }
    onUpdateElement?.(slideId, element.id, {
      text,
      runs: nextParagraphs.flatMap((paragraph, index) =>
        paragraph.runs.map((run, runIndex) => ({
          ...run,
          text: `${index > 0 && runIndex === 0 ? '\n' : ''}${run.text}`
        }))
      ),
      paragraphs: nextParagraphs,
      ...(isContentAutoSizedText(element)
        ? measureAutoSizedTextElement(contentRef.current, element, text)
        : {})
    } as Partial<EditablePresentationElement>)
    hasPendingTextRef.current = false
    notifyTextEditLifecycle()
  }

  const cancelPendingTextCommit = (): void => {
    if (textFrameRef.current == null) return
    window.cancelAnimationFrame(textFrameRef.current)
    textFrameRef.current = null
  }

  const scheduleTextCommit = (): void => {
    cancelPendingTextCommit()
    textFrameRef.current = window.requestAnimationFrame(() => {
      textFrameRef.current = null
      if (isComposingRef.current) return
      const content = contentRef.current
      if (content) commitText()
    })
  }

  const scheduleBlurCommit = (): void => {
    if (blurFrameRef.current != null) window.cancelAnimationFrame(blurFrameRef.current)
    blurFrameRef.current = window.requestAnimationFrame(() => {
      blurFrameRef.current = null
      const content = contentRef.current
      if (!editingRef.current || !content) return
      const active = window.document.activeElement
      if (
        active === content ||
        active?.closest('[data-ribbon-surface], [data-presentation-text-tool]')
      ) {
        pendingBlurTextRef.current = null
        settlePendingText()
        return
      }
      if (isComposingRef.current) return
      pendingBlurTextRef.current = null
      commitText()
      onFinishTextEdit?.()
    })
  }

  const focusEditableContent = (
    content: HTMLDivElement,
    point: { x: number; y: number } | null = null
  ): void => {
    content.focus()
    const range = point ? createCaretRangeFromPoint(point.x, point.y, content) : null
    const selection = window.getSelection()
    if (!selection) return
    const nextRange = range ?? window.document.createRange()
    if (!range) {
      nextRange.selectNodeContents(content)
      nextRange.collapse(false)
    }
    selection.removeAllRanges()
    selection.addRange(nextRange)
  }

  useLayoutEffect(() => {
    editingRef.current = editing
  }, [editing])

  useLayoutEffect(() => {
    flushTextRef.current = (): boolean => {
      if (isComposingRef.current) return false
      cancelPendingTextCommit()
      commitText()
      return true
    }
    finalizeTextEditRef.current = (): boolean => {
      if (!editingRef.current) return true
      if (isComposingRef.current) return false
      const content = contentRef.current
      if (!content) {
        hasPendingTextRef.current = false
        return true
      }
      cancelPendingBlur()
      cancelPendingTextCommit()
      registeredFinalizerRef.current = null
      notifyTextEditLifecycle()
      commitText()
      onFinishTextEdit?.()
      return true
    }
  })

  useLayoutEffect(() => {
    if (!editing) return
    const finalize: TextEditFinalizer = () => finalizeTextEditRef.current()
    finalize.getSelection = () => {
      const content = contentRef.current
      const selection =
        content && window.document.activeElement === content
          ? (readTextSelection(content) ?? retainedSelectionRef.current)
          : retainedSelectionRef.current
      return selection
        ? {
            elementId: element.id,
            start: Math.min(selection.anchor, selection.focus),
            end: Math.max(selection.anchor, selection.focus)
          }
        : null
    }
    finalize.restoreSelection = () => {
      const content = contentRef.current
      if (!content || !editingRef.current) return
      content.focus({ preventScroll: true })
      if (retainedSelectionRef.current) restoreTextSelection(content, retainedSelectionRef.current)
    }
    finalize.flush = () => flushTextRef.current()
    finalize.hasUnsafeWork = () => hasPendingTextRef.current
    finalize.isComposing = () => isComposingRef.current
    registeredFinalizerRef.current = finalize
    notifyTextEditLifecycle()
    return () => {
      if (registeredFinalizerRef.current === finalize) {
        registeredFinalizerRef.current = null
        notifyTextEditLifecycle()
      }
    }
  }, [editing, element.id, notifyTextEditLifecycle])

  useLayoutEffect(() => {
    if (!editing) {
      domModelRef.current = null
      retainedSelectionRef.current = null
      return
    }
    const content = contentRef.current
    if (!content || isComposingRef.current) return
    const model = JSON.stringify(paragraphs)
    if (domModelRef.current === model) return
    const selection =
      window.document.activeElement === content
        ? (readTextSelection(content) ?? retainedSelectionRef.current)
        : retainedSelectionRef.current
    // React owns the detached template; only this owner writes the browser-editable subtree.
    content.replaceChildren(...Array.from(template.childNodes, (node) => node.cloneNode(true)))
    domParagraphsRef.current = paragraphs
    domModelRef.current = model
    if (selection) {
      const focused = window.document.activeElement
      restoreTextSelection(content, selection)
      if (focused instanceof HTMLElement && focused !== content)
        focused.focus({ preventScroll: true })
    }
  }, [editing, paragraphs, template])

  useLayoutEffect(() => {
    if (
      !editable ||
      !hasContentHeight(element) ||
      loadedFontKey !== fontKey ||
      isComposingRef.current
    )
      return
    const layout = [
      element.id,
      element.text,
      element.runs,
      element.paragraphs,
      element.width,
      element.height,
      element.autoSize,
      element.autoWidth,
      element.fontFamily,
      element.fontSize,
      element.bold,
      element.italic,
      element.baseline,
      element.characterSpacing,
      element.align,
      element.lineHeight,
      loadedFontKey,
      slideId
    ]
    if (layout.every((value, index) => value === measuredLayoutRef.current[index])) return
    measuredLayoutRef.current = layout
    const updates = measureAutoSizedTextElement(contentRef.current, element, element.text)
    if (Object.keys(updates).length) onTextLayoutChange?.(slideId, element.id, updates)
  }, [editable, element, fontKey, loadedFontKey, onTextLayoutChange, slideId])

  useLayoutEffect(() => {
    if (!editing || element.locked) return
    const content = contentRef.current
    if (!content) return
    if (initializedEditingElementRef.current === element.id) return
    initializedEditingElementRef.current = element.id
    focusEditableContent(content, pendingCaretPointRef.current)
    pendingCaretPointRef.current = null
  }, [editing, element.id, element.locked, element.text])

  useLayoutEffect(() => {
    if (editing) return
    initializedEditingElementRef.current = null
    cancelPendingTextCommit()
    hasPendingTextRef.current = false
  }, [editing])

  useEffect(() => {
    return () => {
      if (blurFrameRef.current != null) window.cancelAnimationFrame(blurFrameRef.current)
      if (textFrameRef.current != null) window.cancelAnimationFrame(textFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (!editing) return
    const reportSelection = (): void => {
      const content = contentRef.current
      const selection = window.getSelection()
      if (
        !content ||
        window.document.activeElement !== content ||
        !selection ||
        selection.rangeCount === 0
      )
        return
      const range = selection.getRangeAt(0)
      if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return
      retainedSelectionRef.current = readTextSelection(content)
      onTextSelectionChange?.({
        elementId: element.id,
        start: getTextOffset(content, range.startContainer, range.startOffset),
        end: getTextOffset(content, range.endContainer, range.endOffset)
      })
    }
    window.document.addEventListener('selectionchange', reportSelection)
    reportSelection()
    return () => window.document.removeEventListener('selectionchange', reportSelection)
  }, [editing, element.id, onTextSelectionChange])

  useEffect(() => {
    if (!editing || typeof Highlight === 'undefined' || !CSS.highlights) return
    const updateHighlight = (): void => {
      const content = contentRef.current
      const selected = retainedSelectionRef.current
      CSS.highlights.delete('presenter-text-selection')
      if (
        !content ||
        !selected ||
        window.document.activeElement === content ||
        selected.anchor === selected.focus
      )
        return
      const points = getTextSelectionPoints(content, selected)
      const range = window.document.createRange()
      const [start, end] =
        selected.anchor < selected.focus
          ? [points.anchor, points.focus]
          : [points.focus, points.anchor]
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      CSS.highlights.set('presenter-text-selection', new Highlight(range))
    }
    window.document.addEventListener('focusin', updateHighlight)
    window.document.addEventListener('selectionchange', updateHighlight)
    updateHighlight()
    return () => {
      window.document.removeEventListener('focusin', updateHighlight)
      window.document.removeEventListener('selectionchange', updateHighlight)
      CSS.highlights.delete('presenter-text-selection')
    }
  }, [editing, paragraphs])

  const renderedText =
    !hasRichText && !editing
      ? element.text
      : paragraphs.map((paragraph, paragraphIndex) => (
          <div
            key={paragraphIndex}
            data-text-paragraph={paragraphIndex}
            data-list-marker={getListMarker(paragraph, listNumbers[paragraphIndex])}
            className={
              paragraph.list ? 'before:mr-2 before:content-[attr(data-list-marker)]' : undefined
            }
            style={{
              minHeight: '1em',
              flexShrink: 0,
              textAlign: paragraph.align,
              lineHeight:
                paragraph.lineSpacing.kind === 'multiple'
                  ? paragraph.lineSpacing.value
                  : `${paragraph.lineSpacing.points}pt`,
              marginLeft: paragraph.marginLeft,
              textIndent: paragraph.textIndent
            }}
          >
            {paragraph.runs.map((run, runIndex) => (
              <span
                key={runIndex}
                data-text-run={runIndex}
                data-source-paragraph={paragraphIndex}
                style={{
                  color: run.color,
                  backgroundColor: run.highlightColor ?? undefined,
                  fontFamily: run.fontFamily,
                  fontSize: `${run.fontSize}px`,
                  fontWeight: run.bold ? 700 : 400,
                  fontStyle: run.italic ? 'italic' : 'normal',
                  textDecoration:
                    [run.underline && 'underline', run.strikethrough && 'line-through']
                      .filter(Boolean)
                      .join(' ') || 'none',
                  verticalAlign:
                    run.baseline === 'superscript'
                      ? 'super'
                      : run.baseline === 'subscript'
                        ? 'sub'
                        : 'baseline',
                  letterSpacing: run.characterSpacing ? `${run.characterSpacing}px` : undefined
                }}
              >
                {run.text}
              </span>
            ))}
            {paragraph.runs.length === 0 ? <br /> : null}
          </div>
        ))

  return (
    <>
      {editing ? createPortal(renderedText, template) : null}
      <div
        key={editing ? 'editing' : 'preview'}
        data-text-content
        ref={contentRef}
        role="textbox"
        className={`h-full w-full whitespace-pre-wrap break-words outline-none ${
          editable ? 'cursor-text' : ''
        }`}
        contentEditable={editing && !element.locked}
        suppressContentEditableWarning
        style={{
          color: element.color,
          fontFamily: element.fontFamily,
          fontSize: `${element.fontSize}px`,
          fontWeight: element.bold ? 700 : 400,
          fontStyle: element.italic ? 'italic' : 'normal',
          textDecoration: element.underline ? 'underline' : 'none',
          textAlign: element.align,
          lineHeight: element.lineHeight,
          display: element.verticalAlign ? 'flex' : undefined,
          flexDirection: element.verticalAlign ? 'column' : undefined,
          justifyContent:
            element.verticalAlign === 'center'
              ? 'center'
              : element.verticalAlign === 'bottom'
                ? 'flex-end'
                : undefined,
          boxSizing: contentHeight || element.textInsets ? 'border-box' : undefined,
          padding: element.textInsets
            ? `${element.textInsets.top}px ${element.textInsets.right}px ${element.textInsets.bottom}px ${element.textInsets.left}px`
            : contentHeight
              ? `${CONTENT_HEIGHT_TEXT_PADDING_Y}px ${CONTENT_HEIGHT_TEXT_PADDING_X}px`
              : undefined,
          width: editing && element.autoWidth === true ? 'max-content' : undefined,
          minWidth: editing && element.autoWidth === true ? '100%' : undefined,
          height: editing && element.autoWidth === true ? 'auto' : undefined,
          whiteSpace: editing && element.autoWidth === true ? 'pre' : 'pre-wrap',
          overflowWrap: editing && element.autoWidth === true ? 'normal' : 'break-word'
        }}
        onInput={() => {
          if (!editing) return
          hasPendingTextRef.current = true
          notifyTextEditLifecycle()
          if (isComposingRef.current) return
          scheduleTextCommit()
        }}
        onCompositionStart={() => {
          isComposingRef.current = true
          hasPendingTextRef.current = true
          notifyTextEditLifecycle()
          cancelPendingTextCommit()
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false
          notifyTextEditLifecycle()
          if (!editing) return
          if (pendingBlurTextRef.current !== null) scheduleBlurCommit()
          else scheduleTextCommit()
        }}
        onKeyDown={(event) => {
          if (!editing || isComposingRef.current || event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && !event.shiftKey) {
            const content = contentRef.current
            const selection = window.getSelection()
            if (content && selection?.isCollapsed && selection.anchorNode) {
              const index = Array.from(content.children).findIndex((node) =>
                node.contains(selection.anchorNode)
              )
              const currentParagraphs = serializeTextContent(content, domParagraphsRef.current)
              const paragraph = currentParagraphs[index]
              if (
                paragraph?.list &&
                !getPlainText([paragraph])
                  .replace(/[\u200b\ufeff]/g, '')
                  .trim()
              ) {
                event.preventDefault()
                cancelPendingTextCommit()
                hasPendingTextRef.current = false
                const nextParagraphs = currentParagraphs.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, list: null, marginLeft: 0, textIndent: 0 } : item
                )
                onUpdateElement?.(slideId, element.id, {
                  text: getPlainText(nextParagraphs),
                  paragraphs: nextParagraphs
                })
                return
              }
            }
          }
          if (event.key !== 'Tab' || !onTextIndent) return
          event.preventDefault()
          event.stopPropagation()
          onTextIndent(event.shiftKey ? -1 : 1)
        }}
        onPointerDown={(event) => {
          if (!editable) return
          cancelPendingBlur()
          event.stopPropagation()
          if (!editing && !element.locked) {
            // The preview is replaced below; do not let the browser focus that detached target.
            event.preventDefault()
            pendingCaretPointRef.current = { x: event.clientX, y: event.clientY }
            onStartTextEdit?.()
          }
        }}
        onClick={(event) => {
          if (!editable) return
          event.stopPropagation()
          if (element.locked) return
          cancelPendingBlur()
          if (!editing) {
            pendingCaretPointRef.current = { x: event.clientX, y: event.clientY }
            onStartTextEdit?.()
          }
        }}
        onBlur={(event) => {
          retainedSelectionRef.current =
            readTextSelection(event.currentTarget) ?? retainedSelectionRef.current
          cancelPendingTextCommit()
          pendingBlurTextRef.current = event.currentTarget.textContent ?? ''
          scheduleBlurCommit()
        }}
      >
        {editing ? null : renderedText}
      </div>
    </>
  )
}

function getListMarker(
  paragraph: EditableTextParagraph,
  listNumber: number | undefined
): string | undefined {
  if (!paragraph.list) return undefined
  if (paragraph.list.kind === 'bullet') return paragraph.list.char || '•'
  return `${listNumber}.`
}
