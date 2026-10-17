import { makeEditableItem } from '@renderer/test/presentation-fixtures'
import i18n from '@renderer/i18n'
import { act, render, waitFor } from '@testing-library/react'
import { expect, vi } from 'vitest'
import PresentationWorkspacePage from '@renderer/pages/PresentationWorkspacePage'
import PresentationWorkspaceHeader from '@renderer/components/Control/Header/PresentationWorkspaceHeader'
import PresentationNavigationGuard from '@renderer/components/Control/PresentationNavigationGuard'
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
  createTextElement
} from '@renderer/lib/editable-presentation'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'

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

export function resizeElement(element: Element, width: number, height: number): void {
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

export function mockAutoTextMeasurement(): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return Math.max(20, (this.textContent?.length ?? 0) * 12) + 16
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(82)
}

export function deferImageDecode(): { resolve: () => Promise<void>; restore: () => void } {
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

export function HeaderWorkspace(): React.JSX.Element {
  return (
    <ShortcutScopeProvider>
      <PresentationWorkspaceHeader />
      <PresentationWorkspacePage />
    </ShortcutScopeProvider>
  )
}

export function HeaderWorkspaceWithSession({
  onSession
}: {
  onSession: (session: PresentationSessionRegistry) => void
}): React.JSX.Element {
  onSession(usePresentationSessionRegistry())
  return <HeaderWorkspace />
}

export function GuardedWorkspace({
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

export function Workspace({
  showPage,
  onSession
}: {
  showPage: boolean
  onSession: (session: PresentationSessionRegistry) => void
}): React.JSX.Element {
  onSession(usePresentationSessionRegistry())
  return showPage ? <PresentationWorkspacePage /> : <div>other route</div>
}

export function renderEditableWorkspaceWithText(): void {
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

export async function renderWorkspaceSession(): Promise<PresentationEditorSession> {
  let registry: PresentationSessionRegistry | null = null
  render(
    <PresentationSessionRegistryProvider>
      <Workspace showPage onSession={(next) => (registry = next)} />
    </PresentationSessionRegistryProvider>
  )
  await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
  return registry!.get('deck-1')!
}

export function setupWorkspaceSessionTest(): void {
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
}

export function cleanupWorkspaceSessionTest(): void {
  vi.restoreAllMocks()
}

export { mocks }
