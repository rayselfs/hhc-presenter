import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PresentationPreview from '../PresentationPreview'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createImageElement,
  createTextElement
} from '@renderer/lib/editable-presentation'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '@renderer/lib/presentation-media'
import type { PresentationEditorSession } from '@renderer/lib/presentation-editor-session'
import type { FileItemRecord } from '@shared/types/folder'
import { presentMediaItem } from '@renderer/lib/projection-actions'

const { mockLoadEditablePresentation, mockRegistryGet, mockSetTypeState, mockPptxSource } =
  vi.hoisted(() => ({
    mockLoadEditablePresentation: vi.fn(),
    mockRegistryGet: vi.fn(),
    mockSetTypeState: vi.fn(),
    mockPptxSource: vi.fn()
  }))

vi.mock('@renderer/lib/editable-presentation', async () => {
  const actual = await vi.importActual<typeof import('@renderer/lib/editable-presentation')>(
    '@renderer/lib/editable-presentation'
  )
  return { ...actual, loadEditablePresentation: mockLoadEditablePresentation }
})

vi.mock('@renderer/contexts/PresentationSessionRegistryContext', () => ({
  usePresentationSessionRegistry: () => ({ get: mockRegistryGet })
}))

vi.mock('@renderer/components/Common/PptxSlideSurface', () => ({
  default: ({ source }: { source: FileItemRecord }) => {
    mockPptxSource(source)
    return <div data-testid="pptx-source">{source.url}</div>
  }
}))

const storeState = {
  typeStates: { presentation: { slideIndex: 0 } },
  snapshot: null as null | {
    entries: Array<{
      itemId: string
      sourceUrl: string
      remoteSource?: { etag: string }
      remoteItem?: { remoteItemId: string }
    }>
  },
  setTypeState: mockSetTypeState
}

vi.mock('@renderer/stores/media-projection', () => ({
  useMediaProjectionStore: Object.assign(
    vi.fn((selector: (state: typeof storeState) => unknown) => selector(storeState)),
    { getState: () => storeState }
  )
}))

function makeItem(): FileItemRecord {
  return {
    id: 'editable-deck',
    parentId: 'root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name: 'Editable deck.lpdeck',
    url: 'blob:editable-deck',
    size: 1,
    mimeType: EDITABLE_PRESENTATION_MIME_TYPE
  }
}

function makePptxItem(): FileItemRecord {
  return {
    ...makeItem(),
    id: 'pptx-deck',
    name: 'Sunday.pptx',
    url: 'hhc-line:asset-1',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
}

async function presentRemotePptx(item: FileItemRecord, sourceUrl: string): Promise<void> {
  const navigate = vi.fn()
  await expect(
    presentMediaItem({
      item,
      playlist: [item],
      start: async () => {
        storeState.snapshot = {
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
              blobId: 'asset-1',
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

describe('PresentationPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRegistryGet.mockReturnValue(undefined)
    storeState.typeStates.presentation = { slideIndex: 0 }
    storeState.snapshot = null
  })

  it('shows the first slide for a next preview without changing the current projection state', async () => {
    const document = createBlankEditablePresentationDocument('Next deck')
    const slideId = document.slideOrder[0]
    mockLoadEditablePresentation.mockResolvedValue(
      addElementToSlide(document, slideId, createTextElement({ text: 'First slide of next deck' }))
    )
    storeState.typeStates.presentation = { slideIndex: 3 }

    render(<PresentationPreview item={makeItem()} previewOnly />)

    expect(await screen.findByText('First slide of next deck')).toBeInTheDocument()
    expect(mockSetTypeState).not.toHaveBeenCalled()
  })

  it('reports a failed editable-deck preview so its caller can retain the cover', async () => {
    const onError = vi.fn()
    mockLoadEditablePresentation.mockRejectedValue(new Error('Source unavailable'))
    render(<PresentationPreview item={makeItem()} previewOnly onError={onError} />)
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Source unavailable' })
      )
    )
    expect(mockSetTypeState).not.toHaveBeenCalled()
  })

  it('renders editable slide text and image elements', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: '主愛永不止息', x: 10, y: 20, width: 300 })
    const asset = {
      id: 'asset-1',
      name: 'photo.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAA='
    }
    const image = createImageElement({
      assetId: asset.id,
      slideWidth: document.width,
      slideHeight: document.height,
      sourceWidth: 800,
      sourceHeight: 400
    })
    mockLoadEditablePresentation.mockResolvedValue(
      addElementToSlide(
        addElementToSlide({ ...document, assets: { [asset.id]: asset } }, slideId, text),
        slideId,
        image
      )
    )

    render(<PresentationPreview item={makeItem()} />)

    expect(await screen.findByText('主愛永不止息')).toBeInTheDocument()
    expect(screen.getByAltText('photo.png')).toHaveAttribute('src', asset.dataUrl)
    await waitFor(() => {
      expect(mockSetTypeState).toHaveBeenCalledWith('presentation', {
        slideIndex: 0,
        slideCount: 1
      })
    })
  })

  it('renders an open session revision without loading its durable fallback', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Latest session text' })
    const latestDocument = addElementToSlide(document, slideId, text)
    const snapshot = {
      history: { past: [], present: latestDocument, future: [] },
      save: {
        status: 'saved' as const,
        scheduledRevision: 1,
        persistedRevision: 1,
        error: null,
        mirrorWarnings: []
      },
      draftKind: null,
      renderedDocument: latestDocument
    }
    const session = {
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => snapshot)
    } as unknown as PresentationEditorSession
    mockRegistryGet.mockReturnValue(session)

    render(<PresentationPreview item={makeItem()} />)

    expect(await screen.findByText('Latest session text')).toBeInTheDocument()
    expect(mockLoadEditablePresentation).not.toHaveBeenCalled()
  })

  it.each([
    'https://www.alive.org.tw/api/assets/content?ticket=browser-secret',
    'hhc-media://lease/11111111-1111-4111-8111-111111111111'
  ])('passes the current ephemeral source to the operator PPTX surface: %s', async (sourceUrl) => {
    const item = makePptxItem()
    await presentRemotePptx(item, sourceUrl)

    render(<PresentationPreview item={item} />)

    expect(screen.getByTestId('pptx-source')).toHaveTextContent(sourceUrl)
    expect(mockPptxSource).toHaveBeenCalledWith(expect.objectContaining({ url: sourceUrl }))
  })

  it('does not open the durable PPTX source while its remote source is preparing', () => {
    storeState.snapshot = {
      entries: [
        {
          itemId: 'pptx-deck',
          sourceUrl: 'hhc-line:asset-1',
          remoteItem: { remoteItemId: 'asset-1' }
        }
      ]
    }

    render(<PresentationPreview item={makePptxItem()} />)

    expect(screen.queryByTestId('pptx-source')).not.toBeInTheDocument()
    expect(mockPptxSource).not.toHaveBeenCalled()
  })
})
