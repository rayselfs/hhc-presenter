import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PresentationWorkspacePage, { PptxDocumentView } from '../PresentationWorkspacePage'
import i18n from '@renderer/i18n'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement,
  insertBlankEditableSlide
} from '@renderer/lib/editable-presentation'
import { EDITABLE_PRESENTATION_MIME_TYPE, PPTX_MIME_TYPE } from '@renderer/lib/presentation-media'
import { PresentationSessionRegistryProvider } from '@renderer/contexts/PresentationSessionRegistryContext'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import type { FileItemRecord } from '@shared/types/folder'

const mocks = vi.hoisted(() => ({
  convertPptxToEditablePresentation: vi.fn(),
  loadEditablePresentationSnapshot: vi.fn(),
  persistEditablePresentationRevision: vi.fn(),
  refreshEditablePresentationThumbnail: vi.fn(),
  navigate: vi.fn(),
  toastDanger: vi.fn(),
  toastWarning: vi.fn(),
  readPresentationArrayBuffer: vi.fn(),
  openPptxViewer: vi.fn(),
  prepareHhcLinePresentationSource: vi.fn(),
  session: null as { userId: string; displayName: string; roles: string[] } | null
}))

vi.mock('@renderer/contexts/HhcAuthContext', () => ({
  useHhcAuth: () => ({
    session: mocks.session,
    getAuthGeneration: vi.fn(() => 0),
    getAccessToken: vi.fn(async () => null),
    refreshAfterUnauthorized: vi.fn(async () => null),
    endSession: vi.fn(async () => undefined)
  })
}))

vi.mock('@renderer/lib/hhc-line-connect', () => ({
  prepareHhcLinePresentationSource: mocks.prepareHhcLinePresentationSource
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mocks.navigate }
})

vi.mock('@heroui/react/toast', () => ({
  toast: { danger: mocks.toastDanger, warning: mocks.toastWarning }
}))

vi.mock('@renderer/contexts/ContextMenuContext', () => ({
  useContextMenu: () => ({ showMenu: vi.fn() })
}))

vi.mock('@renderer/lib/presentation-source', () => ({
  readPresentationArrayBuffer: mocks.readPresentationArrayBuffer
}))

vi.mock('@renderer/lib/pptx-renderer-service', () => ({
  openPptxViewer: mocks.openPptxViewer
}))

vi.mock('@renderer/lib/editable-presentation', async () => {
  const actual = await vi.importActual<typeof import('@renderer/lib/editable-presentation')>(
    '@renderer/lib/editable-presentation'
  )
  return {
    ...actual,
    convertPptxToEditablePresentation: mocks.convertPptxToEditablePresentation,
    loadEditablePresentationSnapshot: mocks.loadEditablePresentationSnapshot
  }
})

vi.mock('@renderer/lib/editable-presentation-persistence', () => ({
  persistEditablePresentationRevision: mocks.persistEditablePresentationRevision,
  refreshEditablePresentationThumbnail: mocks.refreshEditablePresentationThumbnail
}))

function makeFile(overrides: Partial<FileItemRecord> = {}): FileItemRecord {
  return {
    id: 'deck-1',
    parentId: 'file-root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name: 'Deck.pptx',
    url: 'blob:deck-1',
    size: 100,
    mimeType: PPTX_MIME_TYPE,
    ...overrides
  }
}

function renderReadOnlyDeck(sourceItem: FileItemRecord): void {
  useFileExplorerStore.setState({
    folders: {},
    items: { [sourceItem.id]: sourceItem },
    _foldersArray: [],
    _itemsArray: [sourceItem],
    _childFoldersByParent: {},
    _itemsByParent: { [sourceItem.parentId]: [sourceItem] },
    loadedParents: new Set([sourceItem.parentId]),
    currentFolderId: sourceItem.parentId,
    isLoading: false,
    isInitialized: true
  })
  usePresentationWorkspaceStore.getState().openDocument(sourceItem)
  const deck = usePresentationWorkspaceStore.getState().documents[0]
  if (!deck) throw new Error('workspace deck was not opened')
  render(<PptxDocumentView deck={deck} />)
}

function renderEditableDeck(sourceItem: FileItemRecord): void {
  useFileExplorerStore.setState({
    folders: {},
    items: { [sourceItem.id]: sourceItem },
    _foldersArray: [],
    _itemsArray: [sourceItem],
    _childFoldersByParent: {},
    _itemsByParent: { [sourceItem.parentId]: [sourceItem] },
    loadedParents: new Set([sourceItem.parentId]),
    currentFolderId: sourceItem.parentId,
    isLoading: false,
    isInitialized: true
  })
  usePresentationWorkspaceStore.getState().openDocument(sourceItem)
  render(
    <PresentationSessionRegistryProvider>
      <PresentationWorkspacePage />
    </PresentationSessionRegistryProvider>
  )
}

describe('PresentationWorkspacePage read-only PPTX edit copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    mocks.convertPptxToEditablePresentation.mockReset()
    mocks.loadEditablePresentationSnapshot.mockReset()
    mocks.persistEditablePresentationRevision.mockReset()
    mocks.persistEditablePresentationRevision.mockImplementation(async (request) => ({
      revision: request.revision,
      mirrorWarnings: []
    }))
    mocks.refreshEditablePresentationThumbnail.mockReset()
    mocks.refreshEditablePresentationThumbnail.mockResolvedValue(undefined)
    mocks.navigate.mockReset()
    mocks.toastDanger.mockReset()
    mocks.toastWarning.mockReset()
    mocks.readPresentationArrayBuffer.mockResolvedValue(new ArrayBuffer(8))
    mocks.prepareHhcLinePresentationSource.mockReset()
    mocks.prepareHhcLinePresentationSource.mockResolvedValue(null)
    mocks.session = null
    mocks.openPptxViewer.mockResolvedValue({
      slideCount: 1,
      slideWidth: 1280,
      slideHeight: 720,
      destroy: vi.fn(),
      viewer: {
        renderSlide: vi.fn().mockResolvedValue(undefined),
        renderThumbnailToContainer: vi.fn(() => ({ dispose: vi.fn() }))
      }
    })
    usePresentationWorkspaceStore.setState({
      documents: [],
      activeItemId: null,
      activeSlideIdByItemId: {}
    })
  })

  it('opens the created editable item when Edit a copy succeeds', async () => {
    const sourceItem = makeFile()
    const createdItem = makeFile({
      id: 'editable-1',
      name: 'Deck Editable',
      url: 'blob:editable-1',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE
    })
    mocks.convertPptxToEditablePresentation.mockResolvedValue(createdItem)

    renderReadOnlyDeck(sourceItem)
    fireEvent.click(screen.getByRole('button', { name: 'Edit a copy' }))

    await waitFor(() =>
      expect(mocks.convertPptxToEditablePresentation).toHaveBeenCalledWith(sourceItem)
    )
    expect(usePresentationWorkspaceStore.getState().activeItemId).toBe('editable-1')
    expect(usePresentationWorkspaceStore.getState().documents.at(-1)).toMatchObject({
      itemId: 'editable-1',
      mode: 'editable'
    })
    expect(mocks.navigate).toHaveBeenCalledWith('/presentations/editable-1')
    expect(mocks.toastDanger).not.toHaveBeenCalled()
  })

  it('loads an online LINE PPTX through its ephemeral source', async () => {
    const sourceItem = makeFile({ url: 'unsupported:hhc-line-online' })
    mocks.session = { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    mocks.prepareHhcLinePresentationSource.mockResolvedValue({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      rootRemoteFolderId: 'collection-1',
      source: {
        kind: 'ticket',
        url: 'https://www.alive.org.tw/api/assets/content?ticket=pptx-secret',
        expiresAt: Date.now() + 60_000,
        etag: 'etag-1'
      }
    })

    renderReadOnlyDeck(sourceItem)

    await waitFor(() =>
      expect(mocks.readPresentationArrayBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: sourceItem.id,
          url: 'https://www.alive.org.tw/api/assets/content?ticket=pptx-secret'
        })
      )
    )
  })

  it('toasts and keeps the original read-only deck active when Edit a copy fails', async () => {
    const sourceItem = makeFile()
    mocks.convertPptxToEditablePresentation.mockRejectedValue(new Error('conversion failed'))

    renderReadOnlyDeck(sourceItem)
    fireEvent.click(screen.getByRole('button', { name: 'Edit a copy' }))

    await waitFor(() => expect(mocks.toastDanger).toHaveBeenCalledWith('conversion failed'))
    expect(usePresentationWorkspaceStore.getState().activeItemId).toBe('deck-1')
    expect(usePresentationWorkspaceStore.getState().documents).toHaveLength(1)
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Edit a copy' })).toBeEnabled()
  })

  it('uses the shared responsive shell for read-only PPTX', async () => {
    renderReadOnlyDeck(makeFile())

    await screen.findByRole('button', { name: 'Edit a copy' })
    const group = window.document.querySelector('.workspace-panel-group')
    expect(group).not.toBeNull()
    expect(
      group!.querySelector('.workspace-navigator-slot [data-workspace-navigator]')
    ).not.toBeNull()
    expect(group!.querySelector('.workspace-stage-slot main')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Slides' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not mount off-screen editable slide previews', async () => {
    const originalIntersectionObserver = window.IntersectionObserver
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null
      readonly rootMargin = '0px'
      readonly thresholds = [0]
      disconnect = vi.fn()
      observe = vi.fn()
      takeRecords = vi.fn(() => [])
      unobserve = vi.fn()

      constructor(callback: IntersectionObserverCallback) {
        void callback
      }
    }
    window.IntersectionObserver = TestIntersectionObserver

    try {
      let document = createBlankEditablePresentationDocument('Sunday')
      document = insertBlankEditableSlide(document, 1).document
      document = insertBlankEditableSlide(document, 2).document
      const sourceItem = makeFile({
        id: 'editable-deck',
        name: 'Sunday Editable',
        url: 'blob:editable-deck',
        mimeType: EDITABLE_PRESENTATION_MIME_TYPE
      })
      mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })

      renderEditableDeck(sourceItem)

      await screen.findByTestId('presentation-ribbon-frame')
      expect(window.document.querySelectorAll('[data-slide-surface]')).toHaveLength(1)
    } finally {
      if (originalIntersectionObserver) {
        window.IntersectionObserver = originalIntersectionObserver
      } else {
        Reflect.deleteProperty(window, 'IntersectionObserver')
      }
    }
  })

  it('orders Home commands in native Ribbon groups', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const sourceItem = makeFile({
      id: 'editable-deck',
      name: 'Sunday Editable',
      url: 'blob:editable-deck',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })

    renderEditableDeck(sourceItem)

    await screen.findByTestId('presentation-ribbon-frame')
    const groups = screen.getAllByTestId('presentation-ribbon-group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Slides',
      'Text formatting',
      'Insert',
      'Arrange'
    ])
    groups.forEach((group) => expect(group).toHaveClass('shrink-0'))
    const surface = window.document.querySelector('[data-ribbon-surface]')
    expect(surface).toHaveClass('overflow-x-auto', 'overflow-y-hidden')
    const fontGroup = screen.getByRole('group', { name: 'Text formatting' })
    const fontRows = fontGroup.children
    expect(fontRows).toHaveLength(2)
    const firstRow = fontRows?.[0]
    const secondRow = fontRows?.[1]
    const familySelect = screen.getByRole('button', { name: 'Font family' })
    const sizeSelect = screen.getByLabelText('Font size')
    expect(firstRow).toContainElement(familySelect)
    expect(firstRow).toContainElement(sizeSelect!)
    expect(firstRow).toContainElement(screen.getByRole('button', { name: 'Increase font size' }))
    expect(firstRow).toContainElement(screen.getByRole('button', { name: 'Decrease font size' }))
    expect(secondRow).toContainElement(screen.getByRole('button', { name: 'Bold' }))
    expect(secondRow).toContainElement(screen.getByRole('button', { name: 'Italic' }))
    expect(secondRow).toContainElement(screen.getByRole('button', { name: 'Underline' }))
    expect(firstRow).toContainElement(screen.getByRole('button', { name: 'Clear formatting' }))
    expect(screen.queryByRole('button', { name: 'Load local fonts' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Paste' })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Arrange' }).querySelector('.flex-wrap')).toBeNull()
    expect(screen.getByRole('button', { name: 'Arrange' })).toBeVisible()
  })

  it('loads local font families from a user action', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const withText = addElementToSlide(
      document,
      slideId,
      createTextElement({ text: 'Font target' })
    )
    const sourceItem = makeFile({
      id: 'editable-deck',
      name: 'Sunday Editable',
      url: 'blob:editable-deck',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document: withText, revision: 0 })
    const queryLocalFonts = vi
      .fn()
      .mockResolvedValue([
        { family: 'BiauKaiTC' },
        { family: 'Songti TC' },
        { family: 'BiauKaiTC' },
        { family: 'Songti TC' }
      ])
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: queryLocalFonts
    })

    renderEditableDeck(sourceItem)
    expect(queryLocalFonts).not.toHaveBeenCalled()
    fireEvent.click((await screen.findAllByText('Font target')).at(-1)!)
    fireEvent.click(screen.getByRole('button', { name: 'Font family' }))

    expect(await screen.findAllByRole('option', { name: 'BiauKaiTC' })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: 'Songti TC' })).toHaveLength(1)
    expect(queryLocalFonts).toHaveBeenCalledOnce()

    Reflect.deleteProperty(window, 'queryLocalFonts')
  })

  it('keeps an imported font family selectable when local font discovery omits it', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Imported font',
      width: 300,
      height: 80,
      autoWidth: false,
      fontFamily: 'PMingLiU'
    })
    const withText = addElementToSlide(document, slideId, text)
    const sourceItem = makeFile({
      id: 'editable-deck',
      name: 'Sunday Editable',
      url: 'blob:editable-deck',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document: withText, revision: 0 })
    const queryLocalFonts = vi
      .fn()
      .mockResolvedValue([{ family: 'BiauKaiTC' }, { family: 'Songti TC' }])
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: queryLocalFonts
    })

    renderEditableDeck(sourceItem)
    const textBoxes = await screen.findAllByRole('textbox')
    fireEvent.click(textBoxes.at(-1)!)
    fireEvent.click(screen.getByRole('button', { name: 'Font family' }))

    expect(await screen.findByRole('option', { name: /^PMingLiU/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Font family' })).toHaveTextContent('PMingLiU')

    Reflect.deleteProperty(window, 'queryLocalFonts')
  })

  it.each([
    ['zh-TW', '字型大小'],
    ['zh-CN', '字体大小']
  ])('localizes the Font size accessible name in %s', async (language, accessibleName) => {
    await i18n.changeLanguage(language)
    const document = createBlankEditablePresentationDocument('Sunday')
    const sourceItem = makeFile({
      id: 'editable-deck',
      name: 'Sunday Editable',
      url: 'blob:editable-deck',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })

    renderEditableDeck(sourceItem)

    expect(await screen.findByRole('textbox', { name: accessibleName })).toBeInTheDocument()
  })
})
