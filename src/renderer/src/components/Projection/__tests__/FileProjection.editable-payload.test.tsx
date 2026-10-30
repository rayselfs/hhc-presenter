import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FileProjection from '../FileProjection'

const { mockGetFileSource } = vi.hoisted(() => ({
  mockGetFileSource: vi.fn()
}))

vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: vi.fn().mockResolvedValue({}),
  getFileSource: mockGetFileSource
}))

vi.mock('@renderer/lib/pdfjs-loader', () => ({
  loadPdfjsLib: vi.fn()
}))

vi.mock('@renderer/lib/projection-adapter', () => ({
  createProjectionAdapter: () => ({
    setGeneration: vi.fn(),
    getGeneration: vi.fn(() => 0),
    send: vi.fn(),
    on: vi.fn(() => vi.fn()),
    dispose: vi.fn()
  })
}))

describe('FileProjection editable payload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders fixed imported text and image elements from the projection payload', () => {
    render(
      <FileProjection
        fileName="Editable deck.lpdeck"
        initialItemId="editable-deck"
        initialBlobId="editable-deck"
        initialMimeType="application/vnd.hhc.presenter+json"
        initialPresentation={{ slideIndex: 0, slideCount: 1 }}
        initialEditablePresentation={{
          width: 1024,
          height: 768,
          slide: {
            id: 'slide-1',
            name: 'Slide 1',
            background: { type: 'solid', color: '#ffffff', transparency: 0 },
            elementOrder: ['text-1', 'image-1'],
            elements: {
              'text-1': {
                id: 'text-1',
                type: 'text',
                x: 20,
                y: 30,
                width: 600,
                height: 120,
                rotation: 0,
                opacity: 1,
                text: 'Holy Spirit come',
                fontFamily: 'Inter Variable',
                fontSize: 64,
                bold: true,
                italic: false,
                underline: false,
                color: '#111827',
                align: 'center',
                lineHeight: 1.15,
                autoSize: 'fixed',
                autoWidth: false,
                paragraphs: [
                  {
                    runs: [
                      {
                        text: 'Holy Spirit come',
                        fontFamily: 'Inter Variable',
                        fontSize: 64,
                        bold: true,
                        italic: false,
                        underline: false,
                        color: '#111827',
                        strikethrough: true,
                        baseline: 'superscript',
                        characterSpacing: 2,
                        highlightColor: '#ffff00'
                      }
                    ],
                    align: 'justify',
                    lineSpacing: { kind: 'multiple', value: 1.15 },
                    list: null,
                    marginLeft: 0,
                    textIndent: 0
                  }
                ]
              },
              'image-1': {
                id: 'image-1',
                type: 'image',
                assetId: 'asset-1',
                x: 100,
                y: 180,
                width: 320,
                height: 180,
                rotation: 0,
                opacity: 1
              }
            },
            notes: ''
          },
          assets: {
            'asset-1': {
              id: 'asset-1',
              name: 'photo.png',
              mimeType: 'image/png',
              dataUrl:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZaoAAAAASUVORK5CYII='
            }
          }
        }}
      />
    )

    expect(mockGetFileSource).not.toHaveBeenCalled()
    const textContent = screen.getByText('Holy Spirit come')
    expect(textContent).toBeInTheDocument()
    expect(textContent).toHaveStyle({
      backgroundColor: '#ffff00',
      textDecoration: 'line-through',
      verticalAlign: 'super',
      letterSpacing: '2px'
    })
    expect(textContent.style.padding).toBe('')
    expect(textContent.style.boxSizing).toBe('')
    expect(textContent.closest('[data-slide-element]')).toHaveStyle({
      width: '600px',
      height: '120px'
    })
    expect(screen.getByAltText('photo.png')).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZaoAAAAASUVORK5CYII='
    )
    const frame = document.querySelector('[data-editable-projection-frame]')
    expect(frame).toHaveStyle({
      width: 'min(100vw, calc(100vh * 1.3333333333333333))',
      height: 'min(100vh, calc(100vw / 1.3333333333333333))'
    })
    expect(frame?.parentElement).toHaveClass('h-screen', 'w-screen')
  })
})
