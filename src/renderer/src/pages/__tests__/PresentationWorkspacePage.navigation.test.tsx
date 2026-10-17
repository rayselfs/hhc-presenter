import {
  mocks,
  Workspace,
  HeaderWorkspaceWithSession,
  renderWorkspaceSession,
  resizeElement,
  HeaderWorkspace,
  renderEditableWorkspaceWithText,
  setupWorkspaceSessionTest,
  cleanupWorkspaceSessionTest
} from '@renderer/test/presentation-workspace-session-harness'
import { makeEditableItem } from '@renderer/test/presentation-fixtures'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  PresentationSessionRegistryProvider,
  type PresentationSessionRegistry
} from '@renderer/contexts/PresentationSessionRegistryContext'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement,
  insertBlankEditableSlide
} from '@renderer/lib/editable-presentation'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'

describe('PresentationWorkspacePage navigation contract', () => {
  beforeEach(setupWorkspaceSessionTest)
  afterEach(cleanupWorkspaceSessionTest)
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

  it('does not expose dimensions-only Slide Size controls', async () => {
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )
    await screen.findByTestId('presentation-ribbon-frame')

    expect(screen.queryByText(/Slide Size|投影片大小/)).not.toBeInTheDocument()
  })
})
