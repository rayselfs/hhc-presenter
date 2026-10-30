import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Blob as NodeBlob } from 'node:buffer'
import JSZip from 'jszip'
import { buildPresentation, materializeAllSlideNodes, parseZip } from '@aiden0z/pptx-renderer'
import {
  convertPresentationData,
  createBlankEditablePresentationDocument,
  createTextElement,
  type EditablePresentationDocument,
  type EditablePresentationElement
} from '../editable-presentation'
import { normalizeTextParagraphs, resolveParagraphListNumbers } from '../presentation-rich-text'
import { exportPresentationPptx, PptxExportError } from '../pptx-export'
import { readPptxNotes } from '../pptx-notes'
import { buildNativePptx } from '../pptx-export-package'
import { validatePptxPackage } from '../pptx-source'
import { PPTX_MIME_TYPE } from '../presentation-media'
import type { FileItemRecord } from '@shared/types/folder'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQb8AAAAASUVORK5CYII='
const source = { id: 'source', name: 'Export.pptx', url: 'blob:source' } as FileItemRecord
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'Blob',
    class extends NodeBlob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        return Uint8Array.from(new Uint8Array(await super.arrayBuffer())).buffer
      }
    }
  )
})
afterEach(() => vi.unstubAllGlobals())
async function converted(buffer: ArrayBuffer): Promise<EditablePresentationDocument> {
  const presentation = buildPresentation(
    await parseZip(Uint8Array.from(new Uint8Array(buffer)).buffer)
  )
  materializeAllSlideNodes(presentation)
  return convertPresentationData(
    source,
    presentation,
    undefined,
    await readPptxNotes(buffer, presentation)
  )
}
function put(
  document: EditablePresentationDocument,
  elements: EditablePresentationElement[]
): void {
  const slide = document.slides[document.slideOrder[0]]
  slide.elementOrder = elements.map((element) => element.id)
  slide.elements = Object.fromEntries(elements.map((element) => [element.id, element]))
}

describe('native PPTX export', () => {
  it('exports an empty slide with blank master/layout styles and an OPC-valid package', async () => {
    const document = createBlankEditablePresentationDocument('Empty')
    const blob = await exportPresentationPptx(document)
    expect(blob.type).toBe(PPTX_MIME_TYPE)
    const buffer = await blob.arrayBuffer()
    await expect(validatePptxPackage(buffer)).resolves.toBeUndefined()
    const zip = await JSZip.loadAsync(buffer)
    const master = await zip.file('ppt/slideMasters/slideMaster1.xml')!.async('string')
    expect(master).not.toContain('buChar')
    expect(master).not.toContain('defRPr')
    const reopened = await converted(buffer)
    expect(reopened.slideOrder).toHaveLength(1)
    expect(reopened.slides[reopened.slideOrder[0]].elementOrder).toHaveLength(0)
  })

  it('retains 22 hymn slides and exact paragraph text through native export/reimport', async () => {
    const bytes = await readFile(
      'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
    )
    const document = await converted(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    )
    const original = JSON.stringify(document)
    const reopened = await converted(await (await exportPresentationPptx(document)).arrayBuffer())
    const text = (doc: EditablePresentationDocument): string[][] =>
      doc.slideOrder.map((id) =>
        doc.slides[id].elementOrder
          .map((elementId) => doc.slides[id].elements[elementId])
          .filter((element) => element.type === 'text')
          .map((element) => element.text)
      )
    expect(reopened.slideOrder).toHaveLength(22)
    expect(text(reopened)).toEqual(text(document))
    expect(JSON.stringify(document)).toBe(original)
  })

  it('deduplicates identical assets and preserves crop, opacity, image border and shadow on reimport', async () => {
    const document = createBlankEditablePresentationDocument('Image')
    document.assets.a = {
      id: 'a',
      name: 'a.png',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png}`
    }
    document.assets.b = { ...document.assets.a, id: 'b', name: 'b.png' }
    const image = {
      id: 'image',
      type: 'image' as const,
      assetId: 'a',
      x: 5,
      y: 6,
      width: 100,
      height: 80,
      rotation: 45,
      opacity: 0.6,
      crop: { top: 0.1, right: 0.2, bottom: 0, left: 0 },
      borderColor: '#abcdef',
      borderWidth: 4,
      shadow: 'soft' as const
    }
    put(document, [image, { ...image, id: 'image2', assetId: 'b' }])
    const buffer = await (await exportPresentationPptx(document)).arrayBuffer()
    const zip = await JSZip.loadAsync(buffer)
    expect(Object.keys(zip.files).filter((name) => name.startsWith('ppt/media/'))).toHaveLength(1)
    expect(await zip.file('ppt/media/image1.png')!.async('base64')).toBe(png)
    const reopened = await converted(buffer)
    const images = Object.values(reopened.slides[reopened.slideOrder[0]].elements)
    expect(images).toHaveLength(2)
    expect(images[0]).toMatchObject({
      type: 'image',
      x: 5,
      y: 6,
      width: 100,
      height: 80,
      rotation: 45,
      opacity: 0.6,
      crop: image.crop,
      borderColor: '#ABCDEF',
      borderWidth: 4,
      shadow: 'soft'
    })
  })

  it('reimports existing gradient backgrounds and text without phantom text-box geometry', async () => {
    const document = createBlankEditablePresentationDocument('Gradient')
    const slide = document.slides[document.slideOrder[0]]
    slide.background = {
      type: 'gradient',
      gradientType: 'linear',
      direction: 'left-right',
      angle: 90,
      stops: [
        { color: '#000000', position: 0, transparency: 25, brightness: 0 },
        { color: '#ffffff', position: 100, transparency: 0, brightness: 0 }
      ]
    }
    put(document, [
      createTextElement({ text: '  Text\n\n End  ', autoSize: 'fixed', autoWidth: false })
    ])
    const reopened = await converted(await (await exportPresentationPptx(document)).arrayBuffer())
    const result = reopened.slides[reopened.slideOrder[0]]
    expect(result.elementOrder).toHaveLength(1)
    expect(result.background).toMatchObject({
      type: 'gradient',
      angle: 90,
      stops: slide.background.stops.map((stop) => ({ ...stop, color: stop.color.toUpperCase() }))
    })
    expect(Object.values(result.elements)[0]).toMatchObject({
      type: 'text',
      text: '  Text\n\n End  '
    })
  })

  it('preserves an empty text box and its future typing style', async () => {
    const document = createBlankEditablePresentationDocument('Empty text')
    put(document, [
      createTextElement({
        text: '',
        fontSize: 32,
        color: '#123456',
        autoSize: 'fixed',
        autoWidth: false
      })
    ])
    const reopened = await converted(await (await exportPresentationPptx(document)).arrayBuffer())
    const elements = Object.values(reopened.slides[reopened.slideOrder[0]].elements)
    expect(elements).toHaveLength(1)
    expect(elements[0]).toMatchObject({
      type: 'text',
      text: '',
      fontSize: 32,
      paragraphs: [{ typingStyle: { fontSize: 32, color: '#123456' } }]
    })
  })

  it('rejects oversized WebP before invoking an image decoder', async () => {
    const document = createBlankEditablePresentationDocument('Huge raster')
    const bytes = new Uint8Array(30)
    bytes.set(new TextEncoder().encode('RIFF'), 0)
    bytes.set(new TextEncoder().encode('WEBPVP8X'), 8)
    bytes[24] = 0x28
    bytes[25] = 0x23
    document.assets.webp = {
      id: 'webp',
      name: 'huge.webp',
      mimeType: 'image/webp',
      dataUrl: `data:image/webp;base64,${btoa(String.fromCharCode(...bytes))}`
    }
    put(document, [
      {
        id: 'image',
        type: 'image',
        assetId: 'webp',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        rotation: 0,
        opacity: 1
      }
    ])
    const image = vi.fn()
    vi.stubGlobal('Image', image)
    await expect(exportPresentationPptx(document)).rejects.toMatchObject({
      diagnostics: [{ code: 'package-limit' }]
    })
    expect(image).not.toHaveBeenCalled()
  })

  it('retains visible numbering after export and reimport instead of adding the paragraph offset twice', async () => {
    const document = createBlankEditablePresentationDocument('Numbers')
    const text = createTextElement({ text: 'First\nSecond', autoSize: 'fixed', autoWidth: false })
    text.paragraphs = normalizeTextParagraphs(text)
    for (const paragraph of text.paragraphs)
      paragraph.list = { kind: 'number', level: 0, format: 'arabicPeriod', startAt: 3 }
    put(document, [text])
    const reopened = await converted(await (await exportPresentationPptx(document)).arrayBuffer())
    const result = Object.values(reopened.slides[reopened.slideOrder[0]].elements).find(
      (element) => element.type === 'text'
    )!
    expect(resolveParagraphListNumbers(normalizeTextParagraphs(result))).toEqual([3, 4])
  })

  it.each(['romanUcPeriod', 'alphaLcParenR'])(
    'rejects native %s numbering instead of silently exporting decimal',
    async (format) => {
      const document = createBlankEditablePresentationDocument('Unsupported numbers')
      const text = createTextElement({ text: 'First', autoSize: 'fixed', autoWidth: false })
      text.paragraphs = normalizeTextParagraphs(text)
      text.paragraphs[0].list = { kind: 'number', level: 0, format, startAt: 1 }
      put(document, [text])
      const before = structuredClone(document)
      await expect(exportPresentationPptx(document)).rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({
            code: 'unsupported-content',
            slideId: document.slideOrder[0],
            elementId: text.id
          })
        ]
      })
      expect(document).toEqual(before)
    }
  )

  it('keeps slide ordering/deletion and plain speaker notes in the package', async () => {
    const document = createBlankEditablePresentationDocument('Ordering')
    const first = document.slides[document.slideOrder[0]]
    first.notes = ' 中文 notes <&>\nSecond line '
    const second = { ...structuredClone(first), id: 'second', name: 'Second', notes: '' }
    document.slides.second = second
    document.slideOrder = ['second', first.id]
    const zip = await JSZip.loadAsync(await buildNativePptx(document))
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('name="Second"')
    const notes = new DOMParser().parseFromString(
      await zip.file('ppt/notesSlides/notesSlide2.xml')!.async('string'),
      'application/xml'
    )
    expect(
      Array.from(
        notes.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 't')
      )
        .map((t) => t.textContent)
        .join('\n')
    ).toBe(first.notes)
    const reopened = await converted(await buildNativePptx(document))
    expect(reopened.slides[reopened.slideOrder[1]].notes).toBe(first.notes)
    delete document.slides.second
    document.slideOrder = [first.id]
    const reduced = await JSZip.loadAsync(await buildNativePptx(document))
    expect(reduced.file('ppt/slides/slide2.xml')).toBeNull()
  })

  it('keeps notes relationships inert and rejects missing or invalid note bodies', async () => {
    const document = createBlankEditablePresentationDocument('Notes boundary')
    document.slides[document.slideOrder[0]].notes = 'Safe notes'
    const buffer = await buildNativePptx(document)
    const files = await parseZip(buffer)
    const presentation = buildPresentation(files)
    const external = Array.from(presentation.slides[0].rels.values()).find((entry) =>
      entry.type.endsWith('/notesSlide')
    )!
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    external.targetMode = 'External'
    await expect(readPptxNotes(buffer, presentation)).rejects.toThrow('External PowerPoint notes')
    expect(fetch).not.toHaveBeenCalled()
    external.targetMode = undefined
    const zip = await JSZip.loadAsync(buffer)
    zip.file(
      'ppt/notesSlides/notesSlide1.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'
    )
    await expect(
      readPptxNotes(await zip.generateAsync({ type: 'arraybuffer' }), presentation)
    ).rejects.toThrow('Invalid PowerPoint notes')
  })

  it('rejects invalid assets and unsupported content without mutating input', async () => {
    const document = createBlankEditablePresentationDocument('Invalid')
    put(document, [
      {
        id: 'locked',
        type: 'locked',
        label: 'Chart',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1
      }
    ])
    const original = JSON.stringify(document)
    await expect(exportPresentationPptx(document)).rejects.toBeInstanceOf(PptxExportError)
    expect(JSON.stringify(document)).toBe(original)
    put(document, [])
    document.assets.bad = {
      id: 'bad',
      name: 'bad.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,YmFk'
    }
    await expect(exportPresentationPptx(document)).rejects.toBeInstanceOf(PptxExportError)
  })

  it('rejects a valid graph that exceeds the package entry budget before generating ZIP bytes', async () => {
    const document = createBlankEditablePresentationDocument('Huge')
    const first = document.slides[document.slideOrder[0]]
    document.slideOrder = Array.from({ length: 2000 }, (_, index) => `slide-${index}`)
    document.slides = Object.fromEntries(document.slideOrder.map((id) => [id, { ...first, id }]))
    await expect(exportPresentationPptx(document)).rejects.toMatchObject({
      diagnostics: [{ code: 'package-limit' }]
    })
  })
})
