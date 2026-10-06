import { StrictMode } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FileItemRecord } from '@shared/types/folder'
import { presentMediaItem } from '@renderer/lib/projection-actions'
import PdfPreview from '../PdfPreview'

const { getPageMock, mockGetDocument, mockGetFileSource, mockSendCommand } = vi.hoisted(() => {
  const getPageMock = vi.fn().mockResolvedValue({
    getViewport: vi.fn().mockReturnValue({ width: 100, height: 140 }),
    render: vi.fn().mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() })
  })
  const mockGetDocument = vi.fn().mockReturnValue({
    promise: Promise.resolve({
      numPages: 20,
      getPage: getPageMock,
      loadingTask: { destroy: vi.fn() }
    })
  })
  return { getPageMock, mockGetDocument, mockGetFileSource: vi.fn(), mockSendCommand: vi.fn() }
})

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: vi.fn().mockResolvedValue({}),
  getFileSource: mockGetFileSource
}))

vi.mock('@heroui/react/toast', () => ({
  toast: { warning: vi.fn() }
}))

vi.mock('@renderer/contexts/PresenterCommandContext', () => ({
  usePresenterCommands: () => ({ sendCommand: mockSendCommand })
}))

vi.mock('@renderer/lib/pdfjs-loader', () => ({
  loadPdfjsLib: vi.fn().mockResolvedValue({
    getDocument: mockGetDocument
  })
}))

const mockStoreState = {
  typeStates: {
    pdf: {
      viewMode: 'scroll' as 'scroll' | 'slide',
      itemId: undefined as string | undefined,
      currentPage: undefined as number | undefined
    }
  },
  zoomLevel: 1,
  pan: { x: 0, y: 0 },
  snapshot: null as null | {
    entries: Array<{
      itemId: string
      sourceUrl: string
      remoteSource?: { etag: string }
      remoteItem?: { remoteItemId: string }
    }>
  },
  setTypeState: vi.fn(),
  canNext: vi.fn().mockReturnValue(false),
  next: vi.fn(),
  exit: vi.fn(),
  getState: vi.fn()
}

vi.mock('@renderer/stores/media-projection', () => ({
  useMediaProjectionStore: Object.assign(
    vi.fn((selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState)),
    { getState: () => mockStoreState }
  )
}))

type IOCallback = (entries: IntersectionObserverEntry[]) => void

let capturedIOCallback: IOCallback | null = null
let capturedObservedElements: Element[] = []

function setupIntersectionObserverMock(): void {
  capturedIOCallback = null
  capturedObservedElements = []

  class MockIntersectionObserver {
    constructor(callback: IOCallback) {
      capturedIOCallback = callback
    }
    observe(el: Element): void {
      capturedObservedElements.push(el)
    }
    unobserve = vi.fn()
    disconnect = vi.fn()
  }

  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
}

function makeItem(overrides: Partial<FileItemRecord> = {}): FileItemRecord {
  return {
    id: 'pdf-item-1',
    parentId: 'folder-1',
    type: 'file',
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null,
    name: 'test.pdf',
    url: 'blob:original-pdf-id',
    size: 5000,
    mimeType: 'application/pdf',
    ...overrides
  }
}

async function presentRemotePdf(item: FileItemRecord, sourceUrl: string): Promise<void> {
  const navigate = vi.fn()
  await expect(
    presentMediaItem({
      item,
      playlist: [item],
      start: async () => {
        mockStoreState.snapshot = {
          entries: [
            {
              itemId: item.id,
              sourceUrl,
              remoteSource: { etag: 'etag-1' },
              remoteItem: { remoteItemId: 'asset-1' }
            }
          ]
        }
        return {
          summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
          items: [
            {
              itemId: item.id,
              blobId: 'original-pdf-id',
              status: 'ready',
              reason: 'ready-remote',
              support: 'native'
            }
          ]
        }
      },
      navigate
    })
  ).resolves.toBeNull()
  expect(navigate).toHaveBeenCalledWith('/media')
}

describe('PdfPreview scroll mode lazy rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendCommand.mockReset()
    mockStoreState.snapshot = null
    mockGetFileSource.mockResolvedValue({
      url: 'blob:fake-pdf',
      revoke: vi.fn()
    })
    setupIntersectionObserverMock()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders only page 1 on initial mount for a 20-page PDF in scroll mode', async () => {
    const item = makeItem()
    render(<PdfPreview item={item} />)

    await waitFor(() => {
      expect(getPageMock).toHaveBeenCalled()
    })

    expect(getPageMock).toHaveBeenCalledTimes(1)
    expect(getPageMock).toHaveBeenCalledWith(1)
    expect(mockGetFileSource).toHaveBeenCalledWith({}, 'original-pdf-id', 'application/pdf')
  })

  it('renders page 2 when IntersectionObserver fires for canvas with data-page-index=1', async () => {
    const item = makeItem()
    render(<PdfPreview item={item} />)

    await waitFor(() => {
      expect(getPageMock).toHaveBeenCalledTimes(1)
    })

    expect(capturedIOCallback).not.toBeNull()

    const fakeCanvas = document.createElement('canvas')
    fakeCanvas.dataset.pageIndex = '1'

    capturedIOCallback!([
      {
        isIntersecting: true,
        target: fakeCanvas
      } as unknown as IntersectionObserverEntry
    ])

    await waitFor(() => {
      expect(getPageMock).toHaveBeenCalledTimes(2)
    })

    expect(getPageMock).toHaveBeenNthCalledWith(2, 2)
  })

  it('does not double-render a page already rendered (page index 0)', async () => {
    const item = makeItem()
    render(<PdfPreview item={item} />)

    await waitFor(() => {
      expect(getPageMock).toHaveBeenCalledTimes(1)
    })

    const fakeCanvas = document.createElement('canvas')
    fakeCanvas.dataset.pageIndex = '0'

    capturedIOCallback!([
      {
        isIntersecting: true,
        target: fakeCanvas
      } as unknown as IntersectionObserverEntry
    ])

    await new Promise((r) => setTimeout(r, 50))

    expect(getPageMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://www.alive.org.tw/api/assets/content?ticket=browser-secret',
    'hhc-media://lease/11111111-1111-4111-8111-111111111111'
  ])('loads the current ephemeral operator PDF source without IndexedDB: %s', async (sourceUrl) => {
    const item = makeItem()
    await presentRemotePdf(item, sourceUrl)

    render(<PdfPreview item={item} />)

    await waitFor(() => expect(mockGetDocument).toHaveBeenCalledWith({ url: sourceUrl }))
    expect(mockGetFileSource).not.toHaveBeenCalled()
  })

  it('does not fall back to IndexedDB while the remote PDF source is preparing', async () => {
    mockStoreState.snapshot = {
      entries: [
        {
          itemId: 'pdf-item-1',
          sourceUrl: 'hhc-line:asset-1',
          remoteItem: { remoteItemId: 'asset-1' }
        }
      ]
    }

    render(<PdfPreview item={makeItem()} />)
    await Promise.resolve()
    await Promise.resolve()

    expect(mockGetFileSource).not.toHaveBeenCalled()
  })
})

describe('PdfPreview slide sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendCommand.mockReset()
    mockStoreState.snapshot = null
    mockStoreState.typeStates.pdf.viewMode = 'slide'
    mockGetFileSource.mockResolvedValue({
      url: 'blob:fake-pdf',
      revoke: vi.fn()
    })
    setupIntersectionObserverMock()
  })

  afterEach(() => {
    cleanup()
    mockStoreState.typeStates.pdf.viewMode = 'scroll'
    vi.unstubAllGlobals()
  })

  it('keeps the thumbnail sidebar at least 190px wide', async () => {
    const { container } = render(<PdfPreview item={makeItem()} />)

    await waitFor(() => {
      expect(getPageMock).toHaveBeenCalled()
    })

    const sidebar = container.querySelector('.pdf-sidebar-bg')?.parentElement
    expect(sidebar).toHaveStyle({ minWidth: '190px' })
    expect(sidebar).toHaveStyle({ width: 'max(25%, 190px)' })
  })

  it('sends one projection command when React checks updater purity', async () => {
    render(
      <StrictMode>
        <PdfPreview item={makeItem()} />
      </StrictMode>
    )
    await waitFor(() => expect(getPageMock).toHaveBeenCalled())
    mockSendCommand.mockClear()

    act(() => window.dispatchEvent(new CustomEvent('media:pdfNextPage')))

    expect(mockSendCommand).toHaveBeenCalledOnce()
    expect(mockSendCommand).toHaveBeenCalledWith({
      action: 'pdfPage',
      itemId: 'pdf-item-1',
      value: 2
    })
  })

  it('restores the same document page when the operator preview remounts', async () => {
    mockStoreState.typeStates.pdf.itemId = 'pdf-item-1'
    mockStoreState.typeStates.pdf.currentPage = 7
    const { unmount } = render(<PdfPreview item={makeItem()} />)
    await waitFor(() => expect(getPageMock).toHaveBeenCalledWith(7))
    unmount()
    mockStoreState.typeStates.pdf.itemId = undefined
    mockStoreState.typeStates.pdf.currentPage = undefined
  })

  it('cancels an unfinished canvas render before rendering the next page', async () => {
    const cancel = vi.fn()
    getPageMock.mockResolvedValueOnce({
      getViewport: () => ({ width: 100, height: 140 }),
      render: () => ({ promise: new Promise(() => {}), cancel })
    })
    render(<PdfPreview item={makeItem()} />)
    await waitFor(() => expect(getPageMock).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    act(() => window.dispatchEvent(new CustomEvent('media:pdfNextPage')))
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it('sends the latest page for rapid next commands', async () => {
    render(<PdfPreview item={makeItem()} />)
    await waitFor(() => expect(getPageMock).toHaveBeenCalled())
    mockSendCommand.mockClear()

    act(() => {
      window.dispatchEvent(new CustomEvent('media:pdfNextPage'))
      window.dispatchEvent(new CustomEvent('media:pdfNextPage'))
    })

    expect(mockSendCommand).toHaveBeenNthCalledWith(1, {
      action: 'pdfPage',
      itemId: 'pdf-item-1',
      value: 2
    })
    expect(mockSendCommand).toHaveBeenNthCalledWith(2, {
      action: 'pdfPage',
      itemId: 'pdf-item-1',
      value: 3
    })
  })
})
