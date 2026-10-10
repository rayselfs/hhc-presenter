import i18n from '@renderer/i18n'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import PresentationWorkspacePage from '../PresentationWorkspacePage'
import PresentationWorkspaceHeader from '@renderer/components/Control/Header/PresentationWorkspaceHeader'
import PresentationNavigationGuard from '@renderer/components/Control/PresentationNavigationGuard'
import PresentationElectronCloseBridge from '@renderer/contexts/PresentationElectronCloseBridge'
import {
  PresentationSessionRegistryProvider,
  usePresentationSessionRegistry,
  type PresentationSessionRegistry
} from '@renderer/contexts/PresentationSessionRegistryContext'
import type { PresentationEditorSession } from '@renderer/lib/presentation-editor-session'
import { ShortcutScopeProvider } from '@renderer/contexts/ShortcutScopeContext'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement,
  insertBlankEditableSlide,
  removeEditableSlides
} from '@renderer/lib/editable-presentation'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '@renderer/lib/presentation-media'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import { openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import type { FileItemRecord } from '@shared/types/folder'

const mocks = vi.hoisted(() => ({
  loadEditablePresentationSnapshot: vi.fn(),
  persistEditablePresentationRevision: vi.fn(),
  refreshEditablePresentationThumbnail: vi.fn(),
  queryLocalFontFamiliesOnce: vi.fn(),
  supportsLocalFontAccess: vi.fn(),
  showMenu: vi.fn(),
  toastWarning: vi.fn(),
  toastDanger: vi.fn(),
  startMediaProjection: vi.fn(),
  requestCloseDecision: vi.fn()
}))

interface ResizeObserverRecord {
  callback: ResizeObserverCallback
  targets: Set<Element>
}

let resizeObserverRecords: ResizeObserverRecord[] = []

function resizeElement(element: Element, width: number, height: number): void {
  const record = resizeObserverRecords.find(({ targets }) => targets.has(element))
  expect(record).toBeDefined()
  act(() =>
    record!.callback(
      [
        {
          target: element,
          contentRect: new DOMRect(0, 0, width, height)
        } as ResizeObserverEntry
      ],
      {} as ResizeObserver
    )
  )
}

function mockAnimationFrame(): () => void {
  let nextFrameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const frameId = ++nextFrameId
    frames.set(frameId, callback)
    return frameId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
    frames.delete(frameId)
  })

  return () => {
    const pendingFrames = [...frames.values()]
    frames.clear()
    pendingFrames.forEach((callback) => callback(0))
  }
}

function mockAutoTextMeasurement(): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return Math.max(20, (this.textContent?.length ?? 0) * 12) + 16
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(82)
}

function deferImageDecode(): { resolve: () => Promise<void>; restore: () => void } {
  const OriginalFileReader = window.FileReader
  const OriginalImage = window.Image
  let resolveReader: (() => void) | null = null
  let resolveImage: (() => void) | null = null

  class DeferredFileReader {
    result = 'data:image/png;base64,AA=='
    error = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    readAsDataURL(): void {
      resolveReader = () => this.onload?.()
    }
  }

  class DeferredImage {
    naturalWidth = 100
    naturalHeight = 60
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    set src(_value: string) {
      resolveImage = () => this.onload?.()
    }
  }

  Object.defineProperty(window, 'FileReader', { configurable: true, value: DeferredFileReader })
  Object.defineProperty(window, 'Image', { configurable: true, value: DeferredImage })

  return {
    resolve: async () => {
      resolveReader?.()
      await Promise.resolve()
      resolveImage?.()
      await Promise.resolve()
    },
    restore: () => {
      Object.defineProperty(window, 'FileReader', { configurable: true, value: OriginalFileReader })
      Object.defineProperty(window, 'Image', { configurable: true, value: OriginalImage })
    }
  }
}

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next')
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: string | Record<string, unknown>) =>
        typeof options === 'string' ? options : i18n.t(key, { ...options, defaultValue: key })
    })
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({})
  }
})

vi.mock('@renderer/contexts/ContextMenuContext', () => ({
  useContextMenu: () => ({ showMenu: mocks.showMenu })
}))

vi.mock('@renderer/contexts/PresentationCloseDecisionContext', () => ({
  usePresentationCloseDecision: () => mocks.requestCloseDecision
}))

vi.mock('@renderer/contexts/ProjectionContext', () => ({
  useProjection: () => ({
    isProjectionOpen: false,
    ensureProjectionOpen: vi.fn(() => Promise.resolve()),
    stopProjection: vi.fn()
  })
}))

vi.mock('@renderer/lib/projection-actions', () => ({
  startMediaProjection: mocks.startMediaProjection,
  stopProjectionSession: vi.fn()
}))

vi.mock('@renderer/lib/editable-presentation', async () => {
  const actual = await vi.importActual<typeof import('@renderer/lib/editable-presentation')>(
    '@renderer/lib/editable-presentation'
  )
  return {
    ...actual,
    loadEditablePresentationSnapshot: mocks.loadEditablePresentationSnapshot
  }
})

vi.mock('@renderer/lib/editable-presentation-persistence', () => ({
  persistEditablePresentationRevision: mocks.persistEditablePresentationRevision,
  refreshEditablePresentationThumbnail: mocks.refreshEditablePresentationThumbnail
}))

vi.mock('@renderer/lib/local-fonts', async () => {
  const actual = await vi.importActual<typeof import('@renderer/lib/local-fonts')>(
    '@renderer/lib/local-fonts'
  )
  return {
    ...actual,
    queryLocalFontFamiliesOnce: mocks.queryLocalFontFamiliesOnce,
    supportsLocalFontAccess: mocks.supportsLocalFontAccess
  }
})

vi.mock('@heroui/react/toast', () => ({
  toast: { warning: mocks.toastWarning, danger: mocks.toastDanger }
}))

function makeEditableItem(id = 'deck-1', name = 'Sunday.lpdeck'): FileItemRecord {
  return {
    id,
    parentId: 'file-root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name,
    url: `blob:${id}`,
    size: 1024,
    mimeType: EDITABLE_PRESENTATION_MIME_TYPE
  }
}

function HeaderWorkspace(): React.JSX.Element {
  return (
    <ShortcutScopeProvider>
      <PresentationWorkspaceHeader />
      <PresentationWorkspacePage />
    </ShortcutScopeProvider>
  )
}

function HeaderWorkspaceWithSession({
  onSession
}: {
  onSession: (session: PresentationSessionRegistry) => void
}): React.JSX.Element {
  onSession(usePresentationSessionRegistry())
  return <HeaderWorkspace />
}

function GuardedWorkspace({
  onSession
}: {
  onSession: (session: PresentationSessionRegistry) => void
}): React.JSX.Element {
  onSession(usePresentationSessionRegistry())
  return (
    <>
      <PresentationNavigationGuard />
      <PresentationWorkspacePage />
    </>
  )
}

function Workspace({
  showPage,
  onSession
}: {
  showPage: boolean
  onSession: (session: PresentationSessionRegistry) => void
}): React.JSX.Element {
  onSession(usePresentationSessionRegistry())
  return showPage ? <PresentationWorkspacePage /> : <div>other route</div>
}

function renderEditableWorkspaceWithText(): void {
  const document = createBlankEditablePresentationDocument('Sunday')
  const slideId = document.slideOrder[0]
  mocks.loadEditablePresentationSnapshot.mockResolvedValue({
    document: addElementToSlide(document, slideId, createTextElement({ text: 'Font target' })),
    revision: 0
  })
  render(
    <PresentationSessionRegistryProvider>
      <PresentationWorkspacePage />
    </PresentationSessionRegistryProvider>
  )
}

async function renderWorkspaceSession(): Promise<PresentationEditorSession> {
  let registry: PresentationSessionRegistry | null = null
  render(
    <PresentationSessionRegistryProvider>
      <Workspace showPage onSession={(next) => (registry = next)} />
    </PresentationSessionRegistryProvider>
  )
  await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
  return registry!.get('deck-1')!
}

describe('PresentationWorkspacePage session integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    resizeObserverRecords = []
    globalThis.ResizeObserver = class {
      private readonly record: ResizeObserverRecord

      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: new Set() }
        resizeObserverRecords.push(this.record)
      }

      observe = (target: Element): void => {
        this.record.targets.add(target)
      }

      unobserve = (target: Element): void => {
        this.record.targets.delete(target)
      }

      disconnect = (): void => {
        this.record.targets.clear()
      }
    }
    const item = makeEditableItem()
    const document = createBlankEditablePresentationDocument('Sunday')
    mocks.loadEditablePresentationSnapshot.mockReset()
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })
    mocks.persistEditablePresentationRevision.mockReset()
    mocks.persistEditablePresentationRevision.mockImplementation(async (request) => ({
      revision: request.revision,
      mirrorWarnings: []
    }))
    mocks.refreshEditablePresentationThumbnail.mockReset()
    mocks.refreshEditablePresentationThumbnail.mockResolvedValue(undefined)
    mocks.queryLocalFontFamiliesOnce.mockReset()
    mocks.queryLocalFontFamiliesOnce.mockResolvedValue([])
    mocks.supportsLocalFontAccess.mockReset()
    mocks.supportsLocalFontAccess.mockReturnValue(true)
    mocks.showMenu.mockReset()
    mocks.toastWarning.mockReset()
    mocks.toastDanger.mockReset()
    mocks.startMediaProjection.mockReset()
    mocks.startMediaProjection.mockResolvedValue({
      summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
      items: [
        { itemId: item.id, blobId: item.id, status: 'ready', reason: 'ready', support: 'native' }
      ]
    })
    mocks.requestCloseDecision.mockReset()
    mocks.requestCloseDecision.mockResolvedValue('keep-editing')
    useFileExplorerStore.setState({
      items: { [item.id]: item },
      _itemsArray: [item]
    })
    usePresentationWorkspaceStore.setState({
      documents: [],
      activeItemId: null,
      activeSlideIdByItemId: {}
    })
    usePresentationWorkspaceStore.getState().openDocument(item)
  })

  it('orders Home around supported commands without captions or geometry fields', async () => {
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const homeRibbon = await screen.findByTestId('presentation-ribbon-frame')
    const homeGroups = within(homeRibbon).getAllByRole('group')

    expect(homeGroups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Slides',
      'Text formatting',
      'Insert',
      'Arrange'
    ])
    expect(within(homeRibbon).queryByRole('button', { name: 'Paste' })).not.toBeInTheDocument()
    expect(within(homeRibbon).getByRole('button', { name: 'New Slide' })).toBeEnabled()
    expect(within(homeRibbon).getByRole('button', { name: 'Picture' })).toBeEnabled()
    expect(within(homeRibbon).getByRole('button', { name: 'Shapes' })).toBeEnabled()
    expect(within(homeRibbon).getByRole('button', { name: 'Text' })).toBeEnabled()
    expect(within(homeRibbon).queryAllByRole('spinbutton')).toHaveLength(0)
  })

  it('keeps the Home ribbon visible without the old tab strip', async () => {
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    expect(await screen.findByRole('toolbar', { name: 'Home' })).toBeVisible()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Text formatting' })).toBeInTheDocument()
  })

  it('uses the native slide and divider context-menu command sets', async () => {
    const source = createBlankEditablePresentationDocument('Sunday')
    const second = insertBlankEditableSlide(source, 1)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: second.document,
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const slideItems = document.querySelectorAll<HTMLElement>('[data-slide-option]')

    fireEvent.contextMenu(slideItems[1])
    const itemMenu = mocks.showMenu.mock.calls.at(-1)?.[0] as Array<
      { id?: string; disabled?: boolean; onAction?: () => void } | string
    >
    expect(itemMenu.map((item) => (typeof item === 'string' ? item : item.id))).toEqual([
      'new-slide',
      'separator',
      'copy-slide',
      'cut-slide',
      'delete-slide',
      'paste-slide'
    ])
    const copy = itemMenu.find((item) => typeof item !== 'string' && item.id === 'copy-slide') as {
      onAction?: () => void
    }
    act(() => copy.onAction?.())

    const divider = document.querySelector<HTMLElement>(
      '[data-slide-divider][data-slide-index="1"]'
    )
    expect(divider).not.toBeNull()
    fireEvent.contextMenu(divider!)
    const dividerMenu = mocks.showMenu.mock.calls.at(-1)?.[0] as Array<
      { id?: string; disabled?: boolean; onAction?: () => void } | string
    >
    expect(dividerMenu.map((item) => (typeof item === 'string' ? item : item.id))).toEqual([
      'new-slide',
      'separator',
      'paste-slide'
    ])
    const paste = dividerMenu.find(
      (item) => typeof item !== 'string' && item.id === 'paste-slide'
    ) as { disabled?: boolean; onAction?: () => void }
    expect(paste.disabled).toBe(false)
    act(() => paste.onAction?.())

    expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(3)
  })

  it('routes slide clipboard shortcuts while a sidebar item has focus', async () => {
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const text = createTextElement({ text: 'Element clipboard' })
    const second = insertBlankEditableSlide(addElementToSlide(source, slideId, text), 1)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: second.document,
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const frame = (await screen.findAllByText('Element clipboard'))
      .at(-1)!
      .closest('[data-slide-element]')!
    const slide = document.querySelectorAll<HTMLElement>('[data-slide-option]')[1]

    fireEvent.click(frame)
    fireEvent.keyDown(document, { key: 'c', code: 'KeyC', ctrlKey: true })
    fireEvent.click(slide)
    slide.focus()
    fireEvent.keyDown(slide, { key: 'c', code: 'KeyC', ctrlKey: true })
    fireEvent.keyDown(slide, { key: 'v', code: 'KeyV', ctrlKey: true })

    expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(3)
  })

  it('keeps the slide clipboard while switching between open presentation tabs', async () => {
    const user = userEvent.setup()
    const firstItem = makeEditableItem()
    const secondItem = makeEditableItem('deck-2', 'Sermon.lpdeck')
    useFileExplorerStore.setState({
      items: { [firstItem.id]: firstItem, [secondItem.id]: secondItem },
      _itemsArray: [firstItem, secondItem]
    })
    usePresentationWorkspaceStore.getState().openDocument(secondItem)
    usePresentationWorkspaceStore.getState().setActiveDocument(firstItem.id)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <HeaderWorkspaceWithSession onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get(firstItem.id)).toBeDefined())
    fireEvent.keyDown(document.querySelector('[data-slide-sidebar]')!, {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true
    })

    await user.click(screen.getByText(secondItem.name))
    await waitFor(() => expect(registry?.get(secondItem.id)).toBeDefined())
    fireEvent.keyDown(document.querySelector('[data-slide-sidebar]')!, {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true
    })

    expect(registry!.get(secondItem.id)!.getSnapshot().renderedDocument.slideOrder).toHaveLength(2)
    expect(registry!.get(firstItem.id)!.getSnapshot().renderedDocument.slideOrder).toHaveLength(1)
  })

  it('dispatches Windows and macOS editor commands through the active session', async () => {
    const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const text = createTextElement({ text: 'Keyboard target' })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()

    fireEvent.keyDown(document, { code: 'KeyM', key: 'm', ctrlKey: true })
    expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(2)

    platform.mockReturnValue('MacIntel')
    fireEvent.keyDown(document, { code: 'KeyN', key: 'N', metaKey: true, shiftKey: true })
    expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(3)

    fireEvent.click(screen.getByRole('option', { name: '1Keyboard target' }))
    const textFrame = (await screen.findAllByText('Keyboard target'))
      .at(-1)
      ?.closest('[data-slide-element]')
    expect(textFrame).not.toBeNull()
    fireEvent.click(textFrame!)

    platform.mockReturnValue('Win32')
    fireEvent.keyDown(document, { code: 'KeyB', key: 'b', ctrlKey: true })
    platform.mockReturnValue('MacIntel')
    fireEvent.keyDown(document, { code: 'KeyI', key: 'i', metaKey: true })
    fireEvent.keyDown(document, { code: 'KeyU', key: 'u', metaKey: true })

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      bold: true,
      italic: true,
      underline: true
    })
  })

  it('duplicates only an applicable selected object in one history transaction', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const text = createTextElement({ text: 'Duplicate target' })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initialHistoryLength = session.getSnapshot().history.past.length

    fireEvent.keyDown(document, { code: 'KeyD', key: 'd', metaKey: true })
    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength)
    expect(session.getSnapshot().renderedDocument.slides[slideId].elementOrder).toHaveLength(1)

    const textFrame = (await screen.findAllByText('Duplicate target'))
      .at(-1)
      ?.closest('[data-slide-element]')
    expect(textFrame).not.toBeNull()
    fireEvent.click(textFrame!)
    fireEvent.keyDown(document, { code: 'KeyD', key: 'd', metaKey: true })

    const snapshot = session.getSnapshot()
    expect(snapshot.history.past).toHaveLength(initialHistoryLength + 1)
    expect(snapshot.renderedDocument.slides[slideId].elementOrder).toHaveLength(2)
  })

  it('supports plus/equal zoom-in variants, zoom-out, and fit on both platforms', async () => {
    const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')
    await renderWorkspaceSession()
    const viewport = await screen.findByTestId('presentation-canvas-viewport')
    resizeElement(viewport, 1050, 486)
    const zoom = screen.getByRole('slider', { name: 'Zoom' })

    fireEvent.keyDown(document, {
      code: 'Equal',
      key: '+',
      ctrlKey: true,
      shiftKey: true
    })
    expect(zoom).toHaveValue('98')
    fireEvent.keyDown(document, { code: 'Equal', key: '=', ctrlKey: true })
    expect(zoom).toHaveValue('123')
    fireEvent.keyDown(document, { code: 'Minus', key: '-', ctrlKey: true })
    expect(zoom).toHaveValue('98')

    platform.mockReturnValue('MacIntel')
    fireEvent.keyDown(document, { code: 'Equal', key: '=', metaKey: true })
    expect(zoom).toHaveValue('123')
    fireEvent.keyDown(document, { code: 'KeyO', key: 'o', metaKey: true, altKey: true })
    await waitFor(() => expect(zoom).toHaveValue('73'))
  })

  it('uses the default Windows resolver after platform-scoped shortcut tests', async () => {
    const session = await renderWorkspaceSession()

    fireEvent.keyDown(document, { code: 'KeyM', key: 'm', ctrlKey: true })

    expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(2)
  })

  it('navigates slides and progresses Enter/Escape editor state without stealing caret keys', async () => {
    const source = createBlankEditablePresentationDocument('Sunday')
    const firstSlideId = source.slideOrder[0]
    const text = createTextElement({ text: 'Editable target' })
    const withText = addElementToSlide(source, firstSlideId, text)
    const second = insertBlankEditableSlide(withText, 1)
    const third = insertBlankEditableSlide(second.document, 2)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: third.document,
      revision: 0
    })
    const session = await renderWorkspaceSession()

    fireEvent.keyDown(document, { code: 'PageDown', key: 'PageDown' })
    expect(usePresentationWorkspaceStore.getState().getActiveSlideId('deck-1')).toBe(second.slideId)
    fireEvent.keyDown(document, { code: 'PageUp', key: 'PageUp' })
    expect(usePresentationWorkspaceStore.getState().getActiveSlideId('deck-1')).toBe(firstSlideId)

    const textFrame = (await screen.findAllByText('Editable target'))
      .at(-1)
      ?.closest('[data-slide-element]')
    expect(textFrame).not.toBeNull()
    fireEvent.click(textFrame!)
    fireEvent.keyDown(document, { code: 'Enter', key: 'Enter' })
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!
    expect(content).toHaveAttribute('contenteditable', 'true')
    expect(content).toHaveFocus()

    const historyLength = session.getSnapshot().history.past.length
    fireEvent.keyDown(content, { code: 'PageDown', key: 'PageDown' })
    expect(usePresentationWorkspaceStore.getState().getActiveSlideId('deck-1')).toBe(firstSlideId)
    expect(session.getSnapshot().history.past).toHaveLength(historyLength)
    fireEvent.keyDown(content, { code: 'KeyB', key: 'b', ctrlKey: true })
    expect(session.getSnapshot().history.past).toHaveLength(historyLength + 1)
    fireEvent.keyDown(content, { code: 'Escape', key: 'Escape' })
    content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!
    expect(content).toHaveAttribute('contenteditable', 'false')
    expect(screen.getByRole('button', { name: 'Bold' })).toBeEnabled()
    expect(
      session.getSnapshot().renderedDocument.slides[firstSlideId].elements[text.id]
    ).toMatchObject({ bold: true })
    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled()

    const textInsert = screen.getByRole('button', { name: 'Text' })
    fireEvent.click(textInsert)
    expect(textInsert).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    expect(textInsert).toHaveAttribute('aria-pressed', 'false')
  })

  it('formats the whole text box after its character selection leaves edit mode', async () => {
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const text = createTextElement({ text: 'Whole text' })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const frame = (await screen.findAllByText('Whole text'))
      .at(-1)!
      .closest('[data-slide-element]')!

    fireEvent.click(frame)
    fireEvent.keyDown(document, { key: 'Enter', code: 'Enter' })
    const content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!
    const textNode = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode()!
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.setEnd(textNode, 4)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    fireEvent.keyDown(content, { key: 'Escape', code: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))

    const updated = session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    expect(updated.type === 'text' && updated.paragraphs?.[0].runs.every((run) => run.bold)).toBe(
      true
    )
  })

  it('finalizes pending text on Escape instead of discarding its active edit transaction', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const historyLength = session.getSnapshot().history.past.length
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Keep me'
    fireEvent.input(content)
    fireEvent.keyDown(content, { key: 'Escape', code: 'Escape' })

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Keep me'
    })
    expect(session.getSnapshot().history.past).toHaveLength(historyLength + 1)
    act(() => flushAnimationFrame())
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Keep me'
    })
  })

  it('keeps composition active on Escape and exposes pending DOM text as unsafe work', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(content)
    content.textContent = 'Provisional'
    fireEvent.input(content)
    expect(registry!.hasUnsafeWork()).toBe(true)
    fireEvent.keyDown(content, { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true })

    expect(content).toHaveAttribute('contenteditable', 'true')
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
    fireEvent.compositionEnd(content)
    act(() => flushAnimationFrame())
    fireEvent.keyDown(content, { key: 'Escape', code: 'Escape' })

    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Provisional' })
  })

  it('reports regular pending editor input as unsafe before its animation frame', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Pending navigation text'
    fireEvent.input(content)

    expect(registry!.hasUnsafeWork()).toBe(true)
    act(() => flushAnimationFrame())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Pending navigation text' })
  })

  it('commits continuous text within four seconds but never during composition', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const initial = createBlankEditablePresentationDocument('Continuous typing')
    const slideId = initial.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(initial, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(
        document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
        { clientX: 40, clientY: 20, pointerId: 1 }
      )
      const content = document.querySelector<HTMLElement>(
        '.presentation-stage [data-text-content][contenteditable="true"]'
      )!
      act(() => session.beginDraft('text'))
      for (let index = 0; index < 10; index++) {
        content.textContent = `Continuous ${index}`
        fireEvent.input(content)
        act(() => flushAnimationFrame())
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500)
        })
      }
      expect(session.getSnapshot().history.present.slides[slideId].elements[text.id]).toMatchObject(
        { text: 'Continuous 8' }
      )
      expect(session.getSnapshot().save.persistedRevision).toBeGreaterThan(0)
      fireEvent.compositionStart(content)
      const committed = session.getSnapshot().history.present
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(session.getSnapshot().history.present).toBe(committed)
      content.textContent = '完成輸入'
      fireEvent.compositionEnd(content)
      act(() => flushAnimationFrame())
      expect(session.getSnapshot().history.present.slides[slideId].elements[text.id]).toMatchObject(
        { text: '完成輸入' }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes autosaving a pending draft after composition is canceled without changes', async () => {
    const initial = createBlankEditablePresentationDocument('Canceled composition')
    const slideId = initial.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(initial, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    vi.useFakeTimers()
    const flushAnimationFrame = mockAnimationFrame()
    try {
      fireEvent.pointerDown(
        document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
        { clientX: 40, clientY: 20, pointerId: 1 }
      )
      const content = document.querySelector<HTMLElement>(
        '.presentation-stage [data-text-content][contenteditable="true"]'
      )!
      content.textContent = 'Pending text'
      fireEvent.input(content)
      act(() => flushAnimationFrame())
      expect(session.getSnapshot().draftKind).toBe('text')
      fireEvent.compositionStart(content)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(session.getSnapshot().draftKind).toBe('text')
      fireEvent.compositionEnd(content)
      act(() => flushAnimationFrame())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(session.getSnapshot().draftKind).toBeNull()
      expect(session.getSnapshot().save.status).toBe('saved')
      expect(session.getSnapshot().history.present.slides[slideId].elements[text.id]).toMatchObject(
        {
          text: 'Pending text'
        }
      )
      expect(session.getSnapshot().save.persistedRevision).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a refocused pending blur through text commit without leaving edit mode unsafe', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    await act(async () => {
      await registry!.get('deck-1')!.flush()
    })
    vi.useFakeTimers()
    try {
      let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
      if (!content) throw new Error('presentation text box not found')
      fireEvent.pointerDown(
        document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
        { clientX: 40, clientY: 20, pointerId: 1 }
      )
      content = document.querySelector<HTMLElement>(
        '.presentation-stage [data-text-content][contenteditable="true"]'
      )!
      content.textContent = 'Refocused text'
      fireEvent.input(content)
      fireEvent.blur(content)
      fireEvent.pointerDown(
        document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
        { clientX: 40, clientY: 20, pointerId: 2 }
      )
      content = document.querySelector<HTMLElement>(
        '.presentation-stage [data-text-content][contenteditable="true"]'
      )!
      act(() => flushAnimationFrame())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1750)
      })

      expect(
        registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
      ).toMatchObject({ text: 'Refocused text' })
      expect(registry!.get('deck-1')!.getSnapshot().draftKind).toBeNull()
      expect(registry!.hasPendingEditorWork?.('deck-1')).toBe(false)
      await act(async () => {
        await registry!.get('deck-1')!.flush()
      })
      expect(registry!.hasUnsafeWork()).toBe(false)
      expect(content).toHaveAttribute('contenteditable', 'true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks real navigation and browser unload until live pending text finalizes', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <PresentationSessionRegistryProvider>
              <GuardedWorkspace onSession={(next) => (registry = next)} />
            </PresentationSessionRegistryProvider>
          )
        }
      ],
      { initialEntries: ['/presentations/deck-1'] }
    )
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Navigate safely'
    fireEvent.input(content)
    Object.defineProperty(HTMLElement.prototype, 'focus', {
      configurable: true,
      writable: true,
      value: HTMLElement.prototype.focus
    })
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    await act(() => router.navigate('/files'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/files'))
    act(() => flushAnimationFrame())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Navigate safely' })
  })

  it('keeps real navigation blocked through composition until compositionend', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <PresentationSessionRegistryProvider>
              <GuardedWorkspace onSession={(next) => (registry = next)} />
            </PresentationSessionRegistryProvider>
          )
        }
      ],
      { initialEntries: ['/presentations/deck-1'] }
    )
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(content)
    content.textContent = 'Composed navigation text'
    fireEvent.input(content)

    await act(() => router.navigate('/files'))
    expect(router.state.location.pathname).toBe('/presentations/deck-1')
    fireEvent.compositionEnd(content)
    act(() => flushAnimationFrame())
    await act(() => router.navigate('/files'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/files'))
  })

  it('finalizes live text before header Undo and does not reapply its queued frame', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Before',
      width: 120,
      height: 40,
      autoSize: 'fixed',
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <HeaderWorkspaceWithSession onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    act(() => content!.blur())
    act(() => flushAnimationFrame())
    expect(registry!.get('deck-1')!.getSnapshot().draftKind).toBeNull()
    expect(registry!.get('deck-1')!.getSnapshot().history.past).toHaveLength(0)
    expect(registry!.hasPendingEditorWork?.('deck-1')).toBe(false)
    expect(usePresentationWorkspaceStore.getState().getActiveDocument()?.canUndo).toBe(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled())
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Undo target'
    fireEvent.input(content)
    const undo = screen.getByRole('button', { name: 'Undo' })
    expect(undo).toBeEnabled()
    fireEvent.click(undo)

    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
    act(() => flushAnimationFrame())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Undo target' })
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
  })

  it('blocks header Undo while text composition is active', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <HeaderWorkspaceWithSession onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(content)
    content.textContent = 'Provisional'
    fireEvent.input(content)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()

    expect(content).toHaveAttribute('contenteditable', 'true')
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
  })

  it('finalizes pending DOM text before Header starts projection and blocks composition', async () => {
    const user = userEvent.setup()
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    await (
      await openFileExplorerDB()
    ).put('folder-items', useFileExplorerStore.getState().items['deck-1']!)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <HeaderWorkspaceWithSession onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Projected text'
    fireEvent.input(content)
    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(1))
    expect(
      registry!.get('deck-1')!.getSnapshot().history.present.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Projected text' })
    act(() => flushAnimationFrame())
    expect(
      registry!.get('deck-1')!.getSnapshot().history.present.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Projected text' })

    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(content)
    content.textContent = 'Provisional'
    fireEvent.input(content)
    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    await waitFor(() =>
      expect(mocks.toastDanger).toHaveBeenCalledWith('Unable to save presentation')
    )
    expect(mocks.startMediaProjection).toHaveBeenCalledTimes(1)
    fireEvent.compositionEnd(content)
    content.textContent = 'Final composition'
    fireEvent.input(content)
    await user.click(screen.getByRole('button', { name: 'Start projection' }))
    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(2))
    expect(
      registry!.get('deck-1')!.getSnapshot().history.present.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Final composition' })
  })

  it('lets Enter activate Shapes while a text frame is selected', async () => {
    const user = userEvent.setup()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const text = createTextElement({ text: 'Selected target' })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, text),
      revision: 0
    })
    await renderWorkspaceSession()

    const textFrame = (await screen.findAllByText('Selected target'))
      .at(-1)
      ?.closest('[data-slide-element]')
    expect(textFrame).not.toBeNull()
    fireEvent.click(textFrame!)
    const shapes = screen.getByRole('button', { name: 'Shapes' })

    shapes.focus()
    await user.keyboard('{Enter}')

    expect(mocks.showMenu).toHaveBeenCalledOnce()
    expect(shapes).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Bold' })).toBeEnabled()
    expect(document.querySelector('.presentation-stage [data-text-content]')).toHaveAttribute(
      'contenteditable',
      'false'
    )

    const svg = shapes.querySelector('svg')
    expect(svg).not.toBeNull()
    const label = document.createElement('span')
    shapes.appendChild(label)
    for (const target of [svg!, label]) {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Enter',
        key: 'Enter'
      })
      act(() => target.dispatchEvent(event))

      expect(event.defaultPrevented).toBe(false)
      expect(document.querySelector('.presentation-stage [data-text-content]')).toHaveAttribute(
        'contenteditable',
        'false'
      )
    }
  })

  it.each(['menu', 'dialog'] as const)(
    'does not dispatch editor shortcuts from an active %s',
    async (role) => {
      const session = await renderWorkspaceSession()
      const overlay = document.createElement('div')
      overlay.setAttribute('role', role)
      const button = document.createElement('button')
      overlay.appendChild(button)
      document.body.appendChild(overlay)

      fireEvent.keyDown(button, { code: 'KeyM', key: 'm', ctrlKey: true })

      expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(1)
      overlay.remove()
    }
  )

  it('does not dispatch an already-prevented editor shortcut', async () => {
    const session = await renderWorkspaceSession()
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyM',
      key: 'm',
      ctrlKey: true
    })
    event.preventDefault()
    document.dispatchEvent(event)

    expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(1)
  })

  it('loads each installed font once from the font selector first gesture', async () => {
    let resolveFonts!: (families: string[]) => void
    mocks.queryLocalFontFamiliesOnce.mockReturnValue(
      new Promise((resolve) => {
        resolveFonts = resolve
      })
    )
    renderEditableWorkspaceWithText()
    fireEvent.click((await screen.findAllByRole('textbox')).at(-1)!)
    const fontSelector = screen.getByRole('button', { name: 'Font family' })

    fireEvent.click(fontSelector)

    expect(mocks.queryLocalFontFamiliesOnce).toHaveBeenCalledOnce()
    await act(async () => resolveFonts(['PMingLiU', 'MingLiU', 'DFKai-SB', 'PMingLiU', 'DFKai-SB']))

    expect(screen.getAllByRole('option', { name: 'PMingLiU' })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: 'MingLiU' })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: 'DFKai-SB' })).toHaveLength(1)
  })

  it('warns after font access is rejected and retries from the next selector gesture', async () => {
    mocks.queryLocalFontFamiliesOnce
      .mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
      .mockResolvedValueOnce(['Songti TC'])
    renderEditableWorkspaceWithText()
    fireEvent.click((await screen.findAllByRole('textbox')).at(-1)!)

    fireEvent.click(screen.getByRole('button', { name: 'Font family' }))

    await waitFor(() =>
      expect(mocks.toastWarning).toHaveBeenCalledWith(
        'Unable to load local fonts. Check the font access permission.'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry local fonts' }))

    expect(await screen.findByRole('option', { name: 'Songti TC' })).toBeInTheDocument()
    expect(mocks.queryLocalFontFamiliesOnce).toHaveBeenCalledTimes(2)
  })

  it('renders the same registry session after the routed view remounts', async () => {
    let registry: PresentationSessionRegistry | null = null
    const { rerender } = render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const document = session.getSnapshot().renderedDocument
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Unsaved local text' })
    act(() => session.commit(addElementToSlide(document, slideId, text)))

    expect(await screen.findAllByText('Unsaved local text')).not.toHaveLength(0)

    rerender(
      <PresentationSessionRegistryProvider>
        <Workspace showPage={false} onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    rerender(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )

    expect(await screen.findAllByText('Unsaved local text')).not.toHaveLength(0)
    expect(mocks.loadEditablePresentationSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not carry Format Background to another editable deck through the workspace header', async () => {
    const user = userEvent.setup()
    const firstItem = makeEditableItem()
    const secondItem = makeEditableItem('deck-2', 'Sermon.lpdeck')
    useFileExplorerStore.setState({
      items: { [firstItem.id]: firstItem, [secondItem.id]: secondItem },
      _itemsArray: [firstItem, secondItem]
    })
    usePresentationWorkspaceStore.getState().openDocument(secondItem)
    usePresentationWorkspaceStore.getState().setActiveDocument(firstItem.id)

    render(
      <PresentationSessionRegistryProvider>
        <HeaderWorkspace />
      </PresentationSessionRegistryProvider>
    )

    await screen.findByTestId('presentation-ribbon-frame')
    const surface = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-slide-surface]'
    )
    expect(surface).not.toBeNull()
    fireEvent.contextMenu(surface!)
    const menuItems = mocks.showMenu.mock.calls.at(-1)?.[0] as Array<
      { id?: string; onAction?: () => void } | string
    >
    const formatBackground = menuItems.find(
      (item) => typeof item !== 'string' && item.id === 'format-background'
    ) as { onAction?: () => void } | undefined
    act(() => formatBackground?.onAction?.())
    expect(window.document.querySelector('.workspace-inspector-slot')).not.toBeNull()

    await user.click(screen.getByText('Sermon.lpdeck'))
    await waitFor(() =>
      expect(usePresentationWorkspaceStore.getState().activeItemId).toBe(secondItem.id)
    )
    expect(window.document.querySelector('.workspace-inspector-slot')).toBeNull()

    await user.click(screen.getByText('Sunday.lpdeck'))
    await waitFor(() =>
      expect(usePresentationWorkspaceStore.getState().activeItemId).toBe(firstItem.id)
    )
    expect(window.document.querySelector('.workspace-inspector-slot')).toBeNull()
  })

  it('stores Ribbon font sizes as canvas pixels derived from PowerPoint points', async () => {
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const document = session.getSnapshot().renderedDocument
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Scale me', fontSize: 88 })

    act(() => session.commit(addElementToSlide(document, slideId, text)))
    const textElement = (await screen.findAllByText('Scale me'))
      .at(-1)
      ?.closest('[data-slide-element]')
    expect(textElement).not.toBeNull()
    fireEvent.pointerDown(textElement!, { clientX: 10, clientY: 10 })
    const fontSizeInput = screen.getByRole('textbox', { name: 'Font size' })
    fireEvent.change(fontSizeInput, { target: { value: '72' } })
    fireEvent.keyDown(fontSizeInput, { key: 'Enter' })

    await waitFor(() => {
      const updated = session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
      expect(updated.type === 'text' ? updated.fontSize : null).toBe(144)
    })
  })

  it.each([1920, 1280])(
    'inserts 24 point text with line-height and vertical inset at %i px document width',
    async (documentWidth) => {
      const sourceDocument = createBlankEditablePresentationDocument('Sunday')
      sourceDocument.width = documentWidth
      sourceDocument.height = (documentWidth * 9) / 16
      mocks.loadEditablePresentationSnapshot.mockResolvedValue({
        document: sourceDocument,
        revision: 0
      })
      let registry: PresentationSessionRegistry | null = null
      render(
        <PresentationSessionRegistryProvider>
          <Workspace showPage onSession={(next) => (registry = next)} />
        </PresentationSessionRegistryProvider>
      )
      await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())

      const surface = window.document.querySelector<HTMLElement>(
        '.presentation-stage [data-slide-surface]'
      )
      expect(surface).not.toBeNull()
      vi.spyOn(surface!, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: documentWidth / 2,
        bottom: sourceDocument.height / 2,
        width: documentWidth / 2,
        height: sourceDocument.height / 2,
        toJSON: () => undefined
      })

      fireEvent.doubleClick(surface!, { clientX: 100, clientY: 100 })

      await waitFor(() => {
        const document = registry!.get('deck-1')!.getSnapshot().renderedDocument
        const slide = document.slides[document.slideOrder[0]]
        expect(slide.elementOrder).toHaveLength(1)
        const element = slide.elements[slide.elementOrder[0]]
        expect(element.type).toBe('text')
        if (element.type !== 'text') return
        expect((element.fontSize * 960) / documentWidth).toBe(24)
        expect(element.height).toBe(
          Math.max(32, Math.ceil(element.fontSize * element.lineHeight) + 8)
        )
        expect(element.autoSize).toBe('content')
        expect(element.autoWidth).toBe(true)
      })

      const firstContent = window.document.querySelector<HTMLElement>(
        '.presentation-stage [contenteditable="true"]'
      )!
      firstContent.textContent = 'First text'
      fireEvent.input(firstContent)
      fireEvent.click(screen.getByRole('button', { name: 'Text' }))
      fireEvent.pointerDown(surface!, { clientX: 100, clientY: 100, pointerId: 1 })
      fireEvent.pointerUp(surface!, { clientX: 140, clientY: 120, pointerId: 1 })

      await waitFor(() => {
        const slide = registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[
          sourceDocument.slideOrder[0]
        ]
        const dragged = slide.elements[slide.elementOrder[1]]
        expect(dragged.type).toBe('text')
        if (dragged.type !== 'text') return
        expect(dragged.height).toBe(
          Math.max(40, Math.ceil(dragged.fontSize * dragged.lineHeight) + 8)
        )
        expect(dragged.autoSize).toBe('content')
        expect(dragged.autoWidth).toBe(false)
      })

      const secondContent = window.document.querySelector<HTMLElement>(
        '.presentation-stage [contenteditable="true"]'
      )!
      secondContent.textContent = 'Second text'
      fireEvent.input(secondContent)
      const rightHandle = screen.getByLabelText('Resize text box right')
      fireEvent.pointerDown(rightHandle, { clientX: 0, clientY: 0, pointerId: 2 })
      fireEvent.pointerMove(rightHandle, { clientX: 12, clientY: 0, pointerId: 2 })
      fireEvent.pointerUp(rightHandle, { clientX: 12, clientY: 0, pointerId: 2 })

      await waitFor(() => {
        const slide = registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[
          sourceDocument.slideOrder[0]
        ]
        const resized = slide.elements[slide.elementOrder[1]]
        expect(resized.type === 'text' ? resized.width : null).toBe(104)
        expect(resized.type === 'text' ? resized.autoSize : null).toBe('content')
      })

      act(() => registry!.get('deck-1')!.undo())
      const afterUndo = registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[
        sourceDocument.slideOrder[0]
      ].elements[
        registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[sourceDocument.slideOrder[0]]
          .elementOrder[1]
      ]
      expect(afterUndo.type === 'text' ? afterUndo.width : null).toBe(80)
      expect(afterUndo.type === 'text' ? afterUndo.autoSize : null).toBe('content')
    }
  )

  it('does not let a pending text blur create history after a resize commits', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Original text',
      width: 80,
      height: 40,
      autoSize: 'content',
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())

    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Pending blur text'
    fireEvent.input(textBox)
    const rightHandle = await screen.findByLabelText('Resize text box right')
    rightHandle.focus()
    fireEvent.blur(textBox)

    fireEvent.pointerDown(rightHandle, { clientX: 0, clientY: 0, pointerId: 2 })
    fireEvent.pointerMove(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })
    fireEvent.pointerUp(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })

    act(() => flushAnimationFrame())

    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Pending blur text', width: 104 })
    act(() => registry!.get('deck-1')!.undo())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Pending blur text', width: 80 })
  })

  it('resizes from finalized auto-width text geometry and undoes only the resize', async () => {
    mockAutoTextMeasurement()
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Original',
      width: 80,
      height: 30,
      autoSize: 'content',
      autoWidth: true
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())

    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Final title'
    fireEvent.input(textBox)
    const rightHandle = await screen.findByLabelText('Resize text box right')
    rightHandle.focus()
    fireEvent.blur(textBox)

    fireEvent.pointerDown(rightHandle, { clientX: 0, clientY: 0, pointerId: 2 })
    fireEvent.pointerMove(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })
    fireEvent.pointerUp(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })
    act(() => flushAnimationFrame())

    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Final title', width: 172, height: 82 })
    act(() => registry!.get('deck-1')!.undo())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Final title', width: 148, height: 82 })
  })

  it('does not create a text history entry when editing finishes unchanged before resize', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Unchanged', width: 80, height: 40, autoWidth: false })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initialHistoryLength = session.getSnapshot().history.past.length
    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    const rightHandle = await screen.findByLabelText('Resize text box right')
    fireEvent.pointerDown(rightHandle, { clientX: 0, clientY: 0, pointerId: 2 })
    fireEvent.pointerMove(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })
    fireEvent.pointerUp(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })

    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength + 1)
    act(() => session.undo())
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Unchanged',
      width: 80
    })
  })

  it('commits one history entry for each keyboard resize action', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Keyboard frame',
      x: 100,
      y: 80,
      width: 220,
      height: 40,
      autoSize: 'fixed',
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initialHistoryLength = session.getSnapshot().history.past.length
    const textFrame = (await screen.findAllByText('Keyboard frame'))
      .at(-1)
      ?.closest('[data-slide-element]')
    expect(textFrame).not.toBeNull()
    fireEvent.click(textFrame!)

    const firstHandle = screen.getByLabelText('Resize text box right')
    const firstResize = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    })
    fireEvent(firstHandle, firstResize)

    expect(firstResize.defaultPrevented).toBe(true)
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      x: 100,
      width: 221
    })
    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength + 1)

    const secondHandle = screen.getByLabelText('Resize text box right')
    fireEvent.keyDown(secondHandle, { key: 'ArrowRight', shiftKey: true })
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      x: 100,
      width: 231
    })
    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength + 2)
  })

  it('does not change document, history, revision, or save work for min-clamped resize', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Minimum frame',
      x: 100,
      y: 80,
      width: 60,
      height: 24,
      autoSize: 'fixed',
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initial = session.getSnapshot()
    const textFrame = (await screen.findAllByText('Minimum frame'))
      .at(-1)
      ?.closest('[data-slide-element]')
    fireEvent.click(textFrame!)

    const leftHandle = screen.getByLabelText('Resize text box left')
    fireEvent.keyDown(leftHandle, { key: 'ArrowRight' })
    fireEvent.pointerDown(leftHandle, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(leftHandle, { clientX: 24, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(leftHandle, { clientX: 24, clientY: 0, pointerId: 1 })

    const after = session.getSnapshot()
    expect(after.renderedDocument).toBe(initial.renderedDocument)
    expect(after.history).toBe(initial.history)
    expect(after.save.scheduledRevision).toBe(initial.save.scheduledRevision)
    expect(after.draftKind).toBeNull()
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('does not commit a pointer move whose finalized position snaps to its original', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Snapped origin',
      x: 0,
      y: 100,
      width: 120,
      height: 40,
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initial = session.getSnapshot()
    const frame = (await screen.findAllByText('Snapped origin'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    if (!frame) throw new Error('presentation text frame not found')

    fireEvent.pointerDown(frame, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(frame, { clientX: 14, clientY: 10, pointerId: 1 })

    expect(session.getSnapshot().renderedDocument).toBe(initial.renderedDocument)
    expect(frame).toHaveStyle({ left: '0px' })

    fireEvent.pointerUp(frame, { clientX: 14, clientY: 10, pointerId: 1 })
    const after = session.getSnapshot()
    expect(after.renderedDocument).toBe(initial.renderedDocument)
    expect(after.history).toBe(initial.history)
    expect(after.save.scheduledRevision).toBe(initial.save.scheduledRevision)
    expect(after.draftKind).toBeNull()
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('restores the live base geometry when a pointer move returns exactly to its origin', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Return to origin',
      x: 100,
      y: 100,
      width: 120,
      height: 40,
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initial = session.getSnapshot()
    const frame = (await screen.findAllByText('Return to origin'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    if (!frame) throw new Error('presentation text frame not found')

    fireEvent.pointerDown(frame, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(frame, { clientX: 30, clientY: 10, pointerId: 1 })
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      x: 120,
      y: 100
    })

    const movedFrame = (await screen.findAllByText('Return to origin'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    if (!movedFrame) throw new Error('moved presentation text frame not found')
    fireEvent.pointerMove(movedFrame, { clientX: 10, clientY: 10, pointerId: 1 })

    expect(session.getSnapshot().renderedDocument).toBe(initial.renderedDocument)
    expect(movedFrame).toHaveStyle({ left: '100px', top: '100px' })

    fireEvent.pointerUp(movedFrame, { clientX: 10, clientY: 10, pointerId: 1 })
    const after = session.getSnapshot()
    expect(after.history).toBe(initial.history)
    expect(after.save.scheduledRevision).toBe(initial.save.scheduledRevision)
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('does not commit a selected group move whose finalized delta snaps to zero', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const first = createTextElement({ text: 'Group first', x: 0, y: 100, width: 120, height: 40 })
    const second = createTextElement({
      text: 'Group second',
      x: 200,
      y: 100,
      width: 120,
      height: 40
    })
    const withFirst = addElementToSlide(sourceDocument, slideId, first)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(withFirst, slideId, second),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const firstFrame = (await screen.findAllByText('Group first'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    const secondFrame = (await screen.findAllByText('Group second'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    if (!firstFrame || !secondFrame) throw new Error('presentation group frames not found')
    fireEvent.click(firstFrame)
    fireEvent.click(secondFrame, { ctrlKey: true })
    const initial = session.getSnapshot()

    act(() => {
      fireEvent.pointerDown(firstFrame, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(firstFrame, { clientX: 14, clientY: 10, pointerId: 1 })
    })
    fireEvent.pointerUp(firstFrame, { clientX: 14, clientY: 10, pointerId: 1 })

    const after = session.getSnapshot()
    expect(after.renderedDocument).toBe(initial.renderedDocument)
    expect(after.history).toBe(initial.history)
    expect(after.save.scheduledRevision).toBe(initial.save.scheduledRevision)
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('does not select a generated shape while composition blocks the mutation', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Composing', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(textBox)
    expect(screen.getByLabelText('Resize text box right')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Shapes' }))
    const menuItems = mocks.showMenu.mock.calls.at(-1)?.[0] as Array<
      { id?: string; onAction?: () => void } | string
    >
    const insertRectangle = menuItems.find(
      (item) => typeof item !== 'string' && item.id === 'insert-rectangle'
    ) as { onAction?: () => void } | undefined
    act(() => insertRectangle?.onAction?.())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elementOrder).toEqual([text.id])
    expect(screen.getByLabelText('Resize text box right')).toBeInTheDocument()
  })

  it('rebases pending text before New Slide and keyboard nudge mutations', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', x: 20, y: 20, width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Before New Slide'
    fireEvent.input(textBox)
    const newSlide = screen.getByRole('button', { name: 'New Slide' })
    newSlide.focus()
    fireEvent.blur(textBox)
    fireEvent.click(newSlide)
    act(() => flushAnimationFrame())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Before New Slide'
    })
    expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(2)

    await act(async () => {
      usePresentationWorkspaceStore.getState().setActiveSlideId('deck-1', slideId)
    })
    let returnedTextBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!returnedTextBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(returnedTextBox, { clientX: 40, clientY: 20, pointerId: 2 })
    returnedTextBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    returnedTextBox.textContent = 'Before Nudge'
    fireEvent.input(returnedTextBox)
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    act(() => flushAnimationFrame())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Before Nudge',
      x: 25
    })
  })

  it.each([
    ['activation', 'activate', true],
    ['close save', 'close', true],
    ['close discard', 'discard', false],
    ['flush all', 'flushAll', true]
  ] as const)('finalizes live pending text before %s', async (_label, action, persists) => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Final before boundary'
    fireEvent.input(textBox)

    if (action === 'activate') {
      const secondItem = makeEditableItem('deck-2', 'Second.lpdeck')
      useFileExplorerStore.setState((state) => ({
        items: { ...state.items, [secondItem.id]: secondItem },
        _itemsArray: [...state._itemsArray, secondItem]
      }))
      await act(async () => {
        await registry!.open(secondItem)
        await registry!.activate(secondItem.id)
      })
    } else if (action === 'flushAll') {
      await act(async () => {
        await registry!.flushAll()
      })
    } else {
      await act(async () => {
        await registry!.close('deck-1', action === 'discard' ? 'discard' : undefined)
      })
    }
    const persistedBeforeFrame = mocks.persistEditablePresentationRevision.mock.calls.length
    act(() => flushAnimationFrame())

    if (persists) {
      expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'deck-1',
          document: expect.objectContaining({
            slides: expect.objectContaining({
              [slideId]: expect.objectContaining({
                elements: expect.objectContaining({
                  [text.id]: expect.objectContaining({ text: 'Final before boundary' })
                })
              })
            })
          })
        })
      )
    } else {
      expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
    }
    if (action === 'flushAll') {
      expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledTimes(persistedBeforeFrame)
    }
  })

  it('drops a deferred image decode after its document session closes', async () => {
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    const decode = deferImageDecode()
    try {
      const input = globalThis.document.querySelector<HTMLInputElement>('input[type="file"]')
      if (!input) throw new Error('image file input not found')
      fireEvent.change(input, {
        target: { files: [new File(['image'], 'late.png', { type: 'image/png' })] }
      })

      await act(async () => {
        await registry!.close('deck-1')
      })
      await act(async () => {
        await decode.resolve()
      })

      expect(registry!.get('deck-1')).toBeUndefined()
      expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
    } finally {
      decode.restore()
    }
  })

  it('drops a deferred image decode when its target slide was deleted', async () => {
    const initialDocument = createBlankEditablePresentationDocument('Sunday')
    const { document: sourceDocument } = insertBlankEditableSlide(initialDocument, 1)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: sourceDocument,
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const targetSlideId = session.getSnapshot().renderedDocument.slideOrder[0]
    const decode = deferImageDecode()
    try {
      const input = globalThis.document.querySelector<HTMLInputElement>('input[type="file"]')
      if (!input) throw new Error('image file input not found')
      fireEvent.change(input, {
        target: { files: [new File(['image'], 'late.png', { type: 'image/png' })] }
      })
      act(() => {
        session.commit(
          removeEditableSlides(session.getSnapshot().renderedDocument, [targetSlideId])
        )
      })
      mocks.persistEditablePresentationRevision.mockClear()

      await act(async () => {
        await decode.resolve()
      })

      expect(session.getSnapshot().renderedDocument.slides[targetSlideId]).toBeUndefined()
      expect(session.getSnapshot().renderedDocument.assets).toEqual({})
      expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
    } finally {
      decode.restore()
    }
  })

  it('finalizes pending text before direct slide switching and deletes without a later frame write', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    const withText = addElementToSlide(sourceDocument, slideId, text)
    const { document, slideId: secondSlideId } = insertBlankEditableSlide(withText, 1)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })
    const session = await renderWorkspaceSession()
    let textBox = globalThis.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Before switch'
    fireEvent.input(textBox)
    fireEvent.click(screen.getByRole('option', { name: '2' }))
    act(() => flushAnimationFrame())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Before switch'
    })
    expect(usePresentationWorkspaceStore.getState().getActiveSlideId('deck-1')).toBe(secondSlideId)

    fireEvent.click(screen.getByRole('option', { name: '1Before switch' }))
    let returnedTextBox = globalThis.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!returnedTextBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(returnedTextBox, { clientX: 40, clientY: 20, pointerId: 2 })
    returnedTextBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    returnedTextBox.textContent = 'Delete me'
    fireEvent.input(returnedTextBox)
    fireEvent.keyDown(globalThis.document, { key: 'Delete' })
    act(() => flushAnimationFrame())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toBeUndefined()
  })

  it('does not expose dimensions-only Slide Size controls', async () => {
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )
    await screen.findByTestId('presentation-ribbon-frame')

    expect(screen.queryByText(/Slide Size|投影片大小/)).not.toBeInTheDocument()
  })

  it('starts in Fit mode and recalculates when Notes changes the viewport height', async () => {
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const viewport = await screen.findByTestId('presentation-canvas-viewport')
    resizeElement(viewport, 1050, 486)

    expect(screen.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('73')

    const notesToggle = screen.getByRole('button', { name: 'Toggle Notes' })
    expect(notesToggle).toHaveAttribute('aria-controls', 'presentation-notes-region')
    expect(notesToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(notesToggle)
    resizeElement(viewport, 1050, 400)

    const notesRegion = screen.getByRole('region', { name: 'Notes' })
    expect(notesRegion).toHaveAttribute('id', 'presentation-notes-region')
    expect(notesToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeVisible()
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('58')
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeVisible()

    fireEvent.click(notesToggle)
    expect(notesToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Notes' })).not.toBeInTheDocument()
  })

  it('keeps committed Notes in session history across Undo and Redo', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const { document, slideId: secondSlideId } = insertBlankEditableSlide(sourceDocument, 1)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )

    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Remember the closing prayer' }
    })
    fireEvent.click(screen.getByRole('option', { name: '2' }))

    const session = registry!.get('deck-1')!
    const firstSlideId = document.slideOrder[0]
    expect(session.getSnapshot().renderedDocument.slides[firstSlideId].notes).toBe(
      'Remember the closing prayer'
    )
    expect(usePresentationWorkspaceStore.getState().getActiveSlideId('deck-1')).toBe(secondSlideId)

    fireEvent.click(screen.getByRole('option', { name: '1' }))
    act(() => session.undo())
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('')
    act(() => session.redo())
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue(
      'Remember the closing prayer'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    const historyLength = session.getSnapshot().history.past.length
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    expect(session.getSnapshot().history.past).toHaveLength(historyLength)
  })

  it('cancels a reverted Notes draft before route unmount without undo or save work', async () => {
    let registry: PresentationSessionRegistry | null = null
    const { rerender } = render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const initialHistoryLength = session.getSnapshot().history.past.length
    const initialScheduledRevision = session.getSnapshot().save.scheduledRevision

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    const notes = screen.getByRole('textbox', { name: 'Notes' })
    fireEvent.change(notes, { target: { value: 'Temporary note' } })
    expect(session.getSnapshot().draftKind).toBe('notes')
    fireEvent.change(notes, { target: { value: '' } })

    expect(session.getSnapshot().draftKind).toBeNull()
    rerender(
      <PresentationSessionRegistryProvider>
        <Workspace showPage={false} onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength)
    expect(session.getSnapshot().save.scheduledRevision).toBe(initialScheduledRevision)
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('flushes a focused Notes draft before registry activation and close', async () => {
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const firstSlideId = session.getSnapshot().renderedDocument.slideOrder[0]
    const secondItem = makeEditableItem('deck-2', 'Sermon.lpdeck')
    useFileExplorerStore.setState((state) => ({
      items: { ...state.items, [secondItem.id]: secondItem },
      _itemsArray: [...state._itemsArray, secondItem]
    }))
    await act(async () => {
      await registry!.open(secondItem)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Updated before activation' }
    })
    expect(session.getSnapshot().draftKind).toBe('notes')
    expect(registry!.hasUnsafeWork()).toBe(true)
    await act(async () => {
      await registry!.activate(secondItem.id)
    })

    expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'deck-1',
        document: expect.objectContaining({
          slides: expect.objectContaining({
            [firstSlideId]: expect.objectContaining({ notes: 'Updated before activation' })
          })
        })
      })
    )

    await act(async () => {
      await registry!.activate('deck-1')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Updated before close' }
    })
    await act(async () => {
      await registry!.close('deck-1')
    })
    expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'deck-1',
        document: expect.objectContaining({
          slides: expect.objectContaining({
            [firstSlideId]: expect.objectContaining({ notes: 'Updated before close' })
          })
        })
      })
    )
  })

  it('flushes a focused Notes draft through the Electron app-close bridge', async () => {
    let registry: PresentationSessionRegistry | null = null
    let closeRequested: (() => void) | null = null
    const confirmClose = vi.fn().mockResolvedValue({ closing: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          onCloseRequested: vi.fn((listener: () => void) => {
            closeRequested = listener
            return () => undefined
          }),
          confirmClose
        }
      } as unknown as Window['api']
    })
    render(
      <PresentationSessionRegistryProvider>
        <PresentationElectronCloseBridge />
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const firstSlideId = session.getSnapshot().renderedDocument.slideOrder[0]
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Updated before app close' }
    })

    act(() => closeRequested?.())

    await waitFor(() => expect(confirmClose).toHaveBeenCalledTimes(1))
    expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'deck-1',
        document: expect.objectContaining({
          slides: expect.objectContaining({
            [firstSlideId]: expect.objectContaining({ notes: 'Updated before app close' })
          })
        })
      })
    )
  })

  it('leaves Windows Meta-wheel untouched while Windows Ctrl-wheel zooms', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const viewport = await screen.findByTestId('presentation-canvas-viewport')
    resizeElement(viewport, 1050, 486)
    const zoom = screen.getByRole('slider', { name: 'Zoom' })
    const fit = screen.getByRole('button', { name: 'Fit' })

    const metaWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      deltaY: -100
    })
    fireEvent(viewport, metaWheel)
    expect(metaWheel.defaultPrevented).toBe(false)
    expect(zoom).toHaveValue('73')
    expect(fit).toHaveAttribute('aria-pressed', 'true')

    const ctrlWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100
    })
    fireEvent(viewport, ctrlWheel)
    expect(ctrlWheel.defaultPrevented).toBe(true)
    expect(zoom).toHaveValue('78')
    expect(fit).toHaveAttribute('aria-pressed', 'false')
  })

  it('anchors macOS Ctrl and Meta wheel zoom while leaving ordinary wheel scrolling alone', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const viewport = await screen.findByTestId('presentation-canvas-viewport')
    resizeElement(viewport, 1050, 486)
    Object.defineProperties(viewport, {
      scrollLeft: { value: 200, writable: true },
      scrollTop: { value: 100, writable: true }
    })
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1050,
      bottom: 486,
      width: 1050,
      height: 486,
      toJSON: () => undefined
    })

    const ordinaryWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 })
    fireEvent(viewport, ordinaryWheel)
    expect(ordinaryWheel.defaultPrevented).toBe(false)
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('73')

    const ctrlWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      ctrlKey: true,
      deltaY: -100
    })
    fireEvent(viewport, ctrlWheel)
    expect(ctrlWheel.defaultPrevented).toBe(true)
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('78')
    expect(viewport.scrollLeft).toBeCloseTo(220.55, 1)
    expect(viewport.scrollTop).toBeCloseTo(113.7, 1)

    const metaWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      metaKey: true,
      deltaY: -100
    })
    fireEvent(viewport, metaWheel)
    expect(metaWheel.defaultPrevented).toBe(true)
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('83')
  })

  it('keeps the editable stage and Ribbon inside the shared responsive workspace shell', async () => {
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const ribbon = await screen.findByTestId('presentation-ribbon-frame')
    const group = window.document.querySelector('.workspace-panel-group')
    expect(group).not.toBeNull()
    expect(group!.querySelector('.workspace-navigator-slot [data-slide-sidebar]')).toHaveClass(
      'h-full',
      'overflow-y-auto'
    )
    const stageSlot = group!.querySelector('.workspace-stage-slot')
    expect(stageSlot).toHaveClass('flex')
    expect(stageSlot?.querySelector('.presentation-stage')).toHaveClass('min-h-0', 'flex-1')
    expect(ribbon.querySelector('[data-ribbon-surface]')).toHaveClass(
      'overflow-x-auto',
      'overflow-y-hidden',
      'bg-surface'
    )
  })
})
