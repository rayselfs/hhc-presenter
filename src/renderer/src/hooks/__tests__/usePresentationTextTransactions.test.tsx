import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement
} from '@renderer/lib/editable-presentation'
import {
  createPresentationEditorSession,
  type PresentationEditorSession
} from '@renderer/lib/presentation-editor-session'
import type { PresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import type { TextEditFinalizer } from '@renderer/types/presentation-text'
import { usePresentationTextTransactions } from '../usePresentationTextTransactions'

let session: PresentationEditorSession
const document = createBlankEditablePresentationDocument('Text transactions')
const slideId = document.slideOrder[0]
const element = createTextElement({ text: 'Original' })
const initialDocument = addElementToSlide(document, slideId, element)

beforeEach(() => {
  vi.useFakeTimers()
  session = createPresentationEditorSession({
    initialDocument,
    persist: async (request) => ({ revision: request.revision, mirrorWarnings: [] }),
    refreshThumbnail: async () => undefined
  })
})

afterEach(() => {
  cleanup()
  session.dispose()
  vi.useRealTimers()
})

function setup(): ReturnType<
  typeof renderHook<ReturnType<typeof usePresentationTextTransactions>, unknown>
> {
  return renderHook(() => usePresentationTextTransactions('deck', session, {}))
}

function renderedText(): string | undefined {
  const current = session.getSnapshot().renderedDocument.slides[slideId].elements[element.id]
  return current.type === 'text' ? current.text : undefined
}

it('previews typing immediately and commits one undo transaction after the 750 ms idle period', () => {
  const { result } = setup()
  act(() => result.current.previewTextElement(slideId, element.id, { text: 'First' }))
  expect(renderedText()).toBe('First')
  expect(session.getSnapshot().history.past).toHaveLength(0)
  act(() => vi.advanceTimersByTime(500))
  act(() => result.current.previewTextElement(slideId, element.id, { text: 'Final' }))
  act(() => vi.advanceTimersByTime(749))
  expect(session.getSnapshot().draftKind).toBe('text')
  act(() => vi.advanceTimersByTime(1))
  expect(session.getSnapshot().draftKind).toBeNull()
  expect(session.getSnapshot().history.past).toHaveLength(1)
  session.undo()
  expect(renderedText()).toBe('Original')
})

it('commits continuous input at the four-second deadline', () => {
  const { result } = setup()
  act(() => result.current.previewTextElement(slideId, element.id, { text: '0' }))
  for (let index = 1; index <= 8; index++) {
    act(() => vi.advanceTimersByTime(500))
    act(() => result.current.previewTextElement(slideId, element.id, { text: String(index) }))
  }
  expect(session.getSnapshot().draftKind).toBeNull()
  expect(session.getSnapshot().history.past).toHaveLength(1)
  expect(renderedText()).toBe('8')
})

it('defers both deadline and debounce commits while IME composition is active', () => {
  const { result } = setup()
  let composing = true
  const finalizer: TextEditFinalizer = Object.assign(() => !composing, {
    isComposing: () => composing
  })
  act(() => result.current.setTextEditorFinalizer(finalizer))
  act(() => result.current.previewTextElement(slideId, element.id, { text: '0' }))
  for (let index = 1; index <= 8; index++) {
    act(() => vi.advanceTimersByTime(500))
    act(() => result.current.previewTextElement(slideId, element.id, { text: String(index) }))
  }
  act(() => vi.advanceTimersByTime(1500))
  expect(session.getSnapshot().draftKind).toBe('text')
  expect(session.getSnapshot().history.past).toHaveLength(0)
  composing = false
  act(() => vi.advanceTimersByTime(750))
  expect(session.getSnapshot().draftKind).toBeNull()
  expect(session.getSnapshot().history.past).toHaveLength(1)
})

it('cancels an untouched new text element without a save or undo entry', () => {
  const { result } = setup()
  const empty = createTextElement({ text: '' })
  act(() =>
    result.current.beginEmptyTextDraft(empty.id, addElementToSlide(initialDocument, slideId, empty))
  )
  act(() => result.current.previewTextElement(slideId, empty.id, { text: '\u200b', bold: true }))
  act(() => result.current.commitTextDraft())
  act(() => vi.advanceTimersByTime(5000))
  expect(result.current.isEmptyTextDraft(empty.id)).toBe(true)
  expect(session.getSnapshot().history.past).toHaveLength(0)
  act(() => expect(result.current.cancelEmptyTextDraft()).toBe(true))
  expect(session.getSnapshot().renderedDocument).toEqual(initialDocument)
  expect(session.getSnapshot().history.past).toHaveLength(0)
  expect(result.current.cancelEmptyTextDraft()).toBe(false)
})

it('commits a new text element as one transaction after actual content arrives', () => {
  const { result } = setup()
  const empty = createTextElement({ text: '' })
  act(() =>
    result.current.beginEmptyTextDraft(empty.id, addElementToSlide(initialDocument, slideId, empty))
  )
  act(() => result.current.previewTextElement(slideId, empty.id, { text: 'Content' }))
  expect(result.current.isEmptyTextDraft(empty.id)).toBe(false)
  act(() => vi.advanceTimersByTime(750))
  expect(session.getSnapshot().history.past).toHaveLength(1)
  session.undo()
  expect(session.getSnapshot().renderedDocument).toEqual(initialDocument)
})

it('blocks document mutations when the editor cannot finalize', () => {
  const { result } = setup()
  const update = vi.fn((current: typeof initialDocument) => ({ ...current, name: 'Changed' }))
  act(() => result.current.setTextEditorFinalizer(() => false))
  expect(result.current.finalizeDocumentMutation()).toBeNull()
  expect(result.current.commitDocument(update)).toBe(false)
  expect(update).not.toHaveBeenCalled()
  act(() => result.current.setTextEditorFinalizer(() => true))
  act(() => expect(result.current.commitDocument(update)).toBe(true))
  expect(session.getSnapshot().history.past).toHaveLength(1)
})

it('registers only one live finalizer through root StrictMode and reads its current lifecycle', () => {
  const unregister = vi.fn()
  const registry = {
    registerEditorFinalizer: vi.fn<
      NonNullable<PresentationSessionRegistry['registerEditorFinalizer']>
    >(() => unregister),
    notifyEditorLifecycle: vi.fn()
  }
  const { result, unmount } = renderHook(
    () => usePresentationTextTransactions('deck', session, registry),
    {
      wrapper: StrictMode
    }
  )
  expect(registry.registerEditorFinalizer).toHaveBeenCalledTimes(2)
  expect(unregister).toHaveBeenCalledTimes(1)
  const finalizer: TextEditFinalizer = Object.assign(() => false, {
    hasUnsafeWork: () => true,
    isComposing: () => true
  })
  act(() => result.current.setTextEditorFinalizer(finalizer))
  expect(registry.notifyEditorLifecycle).toHaveBeenLastCalledWith('deck')
  expect(result.current.getTextEditorFinalizer()).toBe(finalizer)
  const registration = registry.registerEditorFinalizer.mock.calls.at(-1)
  expect(registration).toBeDefined()
  const [, finalize, hasUnsafeWork, hasLiveEditor, hasComposing] = registration!
  expect([finalize(), hasUnsafeWork?.(), hasLiveEditor?.(), hasComposing?.()]).toEqual([
    false,
    true,
    true,
    true
  ])
  unmount()
  expect(unregister).toHaveBeenCalledTimes(2)
})

it('removes pending debounce work on unmount without committing the draft', () => {
  const { result, unmount } = setup()
  act(() => result.current.previewTextElement(slideId, element.id, { text: 'Pending' }))
  unmount()
  act(() => vi.advanceTimersByTime(5000))
  expect(session.getSnapshot().draftKind).toBe('text')
  expect(session.getSnapshot().history.past).toHaveLength(0)
})
