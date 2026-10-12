import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { buildPresentation, materializeAllSlideNodes, parseZip } from '@aiden0z/pptx-renderer'
import {
  convertPresentationData,
  createBlankEditablePresentationDocument,
  createTextElement,
  duplicateEditableSlides,
  type EditablePresentationDocument,
  type EditableTextElement
} from '../editable-presentation'
import { createPptxSource, validatePptxPackage } from '../pptx-source'
import { readPptxNotes } from '../pptx-notes'
import { buildNativePptx } from '../pptx-export-package'
import { buildSourcePptx } from '../pptx-export-source'
import { exportPresentationPptx, PptxExportError } from '../pptx-export'
import type { FileItemRecord } from '@shared/types/folder'

const pns = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const rns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relns = 'http://schemas.openxmlformats.org/package/2006/relationships'
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQb8AAAAASUVORK5CYII='
const ans = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const sourceItem = { id: 'source', name: 'Original.pptx', url: 'blob:source' } as FileItemRecord
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
async function documentFrom(bytes: ArrayBuffer): Promise<EditablePresentationDocument> {
  const source = await createPptxSource(bytes)
  const presentation = buildPresentation(await parseZip(bytes))
  materializeAllSlideNodes(presentation)
  return convertPresentationData(
    sourceItem,
    presentation,
    source,
    await readPptxNotes(bytes, presentation)
  )
}
async function hymn(): Promise<{ bytes: ArrayBuffer; document: EditablePresentationDocument }> {
  const bytes = Uint8Array.from(
    await readFile('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx')
  ).buffer
  return { bytes, document: await documentFrom(bytes) }
}
function firstText(document: EditablePresentationDocument): EditableTextElement {
  return Object.values(document.slides[document.slideOrder[0]].elements).find(
    (element) => element.type === 'text'
  )!
}
function editText(element: EditableTextElement, text: string): void {
  element.text = text
  element.paragraphs = [
    { ...element.paragraphs![0], runs: [{ ...element.paragraphs![0].runs[0], text }] }
  ]
  delete element.runs
}
async function assertUntouched(
  before: ArrayBuffer,
  after: ArrayBuffer,
  excluded: ReadonlySet<string>
): Promise<void> {
  const original = await JSZip.loadAsync(before)
  const output = await JSZip.loadAsync(after)
  for (const name of Object.keys(original.files)) {
    if (excluded.has(name) || original.files[name].dir) continue
    expect(await output.file(name)!.async('uint8array'), name).toEqual(
      await original.file(name)!.async('uint8array')
    )
  }
}
async function combinedShape(): Promise<{
  bytes: ArrayBuffer
  document: EditablePresentationDocument
}> {
  const document = createBlankEditablePresentationDocument('Combined')
  const slide = document.slides[document.slideOrder[0]]
  const text = createTextElement({
    text: 'Original text',
    x: 10,
    y: 20,
    width: 300,
    height: 120,
    autoSize: 'fixed',
    autoWidth: false
  })
  slide.elements = {
    shape: {
      id: 'shape',
      type: 'shape',
      shape: 'rectangle',
      x: 10,
      y: 20,
      width: 300,
      height: 120,
      rotation: 0,
      opacity: 1,
      fillColor: '#abcdef',
      strokeColor: '#000000',
      strokeWidth: 2
    },
    [text.id]: text
  }
  slide.elementOrder = ['shape', text.id]
  const zip = await JSZip.loadAsync(await buildNativePptx(document))
  const xml = new DOMParser().parseFromString(
    await zip.file('ppt/slides/slide1.xml')!.async('string'),
    'application/xml'
  )
  const shapes = Array.from(xml.getElementsByTagNameNS(pns, 'sp'))
  shapes[0].appendChild(shapes[1].getElementsByTagNameNS(pns, 'txBody')[0])
  shapes[1].remove()
  shapes[0].setAttributeNS('urn:hhc:opaque', 'opaque:keep', 'preserved')
  zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  return { bytes, document: await documentFrom(bytes) }
}

describe('retained source PPTX export', () => {
  it('returns exact original bytes for unchanged hymn despite internal metadata differences', async () => {
    const { bytes, document } = await hymn()
    document.name = 'Renamed local deck'
    document.updatedAt++
    const original = JSON.stringify(document)
    expect(new Uint8Array(await buildSourcePptx(document))).toEqual(new Uint8Array(bytes))
    expect(JSON.stringify(document)).toBe(original)
  })

  it('patches text while preserving all unrelated original package members and styles', async () => {
    const { bytes, document } = await hymn()
    editText(firstText(document), '  修改文字 <&>  ')
    const original = JSON.stringify(document)
    const output = await (await exportPresentationPptx(document)).arrayBuffer()
    await validatePptxPackage(output)
    await assertUntouched(bytes, output, new Set(['ppt/slides/slide1.xml']))
    const reopened = await documentFrom(output)
    expect(firstText(reopened).text).toBe('  修改文字 <&>  ')
    expect(firstText(reopened).paragraphs?.[0].list).toBeNull()
    expect(JSON.stringify(document)).toBe(original)
  })

  it('splits independently moved text and geometry roles with unique IDs and keeps opaque metadata', async () => {
    const { bytes, document } = await combinedShape()
    const text = firstText(document)
    const slide = document.slides[document.slideOrder[0]]
    const geometry = Object.values(slide.elements).find((element) => element.type === 'shape')!
    expect(text.pptxSourceNode?.id).toBe(geometry.pptxSourceNode?.id)
    text.x += 50
    slide.elementOrder.reverse()
    const output = await buildSourcePptx(document)
    await validatePptxPackage(output)
    await assertUntouched(bytes, output, new Set(['ppt/slides/slide1.xml']))
    const zip = await JSZip.loadAsync(output)
    const xml = new DOMParser().parseFromString(
      await zip.file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const ids = Array.from(xml.getElementsByTagNameNS(pns, 'cNvPr'), (node) =>
      node.getAttribute('id')
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      Array.from(xml.getElementsByTagNameNS(pns, 'sp')).some(
        (node) => node.getAttributeNS('urn:hhc:opaque', 'keep') === 'preserved'
      )
    ).toBe(true)
    const reopened = await documentFrom(output)
    expect(firstText(reopened).x).toBe(text.x)
    expect(
      Object.values(reopened.slides[reopened.slideOrder[0]].elements).find(
        (element) => element.type === 'shape'
      )?.x
    ).toBe(geometry.x)
  })

  it('deletes a mapped text role without deleting its geometry sibling', async () => {
    const { document } = await combinedShape()
    const slide = document.slides[document.slideOrder[0]]
    const text = firstText(document)
    delete slide.elements[text.id]
    slide.elementOrder = slide.elementOrder.filter((id) => id !== text.id)
    const reopened = await documentFrom(await buildSourcePptx(document))
    const elements = Object.values(reopened.slides[reopened.slideOrder[0]].elements)
    expect(elements).toHaveLength(1)
    expect(elements[0].type).toBe('shape')
  })

  it('reorders, removes and copies slides without dangling targets or changing unrelated source parts', async () => {
    const { document } = await hymn()
    const removed = document.slideOrder.pop()!
    delete document.slides[removed]
    document.slideOrder.reverse()
    const copied = duplicateEditableSlides(document, [document.slideOrder[0]], 0).document
    const output = await buildSourcePptx(copied)
    await validatePptxPackage(output)
    const reopened = await documentFrom(output)
    expect(reopened.slideOrder).toHaveLength(22)
    expect(firstText(reopened).text).toBe(firstText(copied).text)
    const zip = await JSZip.loadAsync(output)
    expect(zip.file('ppt/slides/slide22.xml')).not.toBeNull()
  })

  it('rejects unrepresentable dynamic-field text edits and contradictory references without mutating input', async () => {
    const { bytes } = await hymn()
    const zip = await JSZip.loadAsync(bytes)
    const xml = new DOMParser().parseFromString(
      await zip.file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const run = xml.getElementsByTagNameNS(ans, 'r')[0]
    const field = xml.createElementNS(ans, 'a:fld')
    field.setAttribute('id', '{00000000-0000-0000-0000-000000000001}')
    field.setAttribute('type', 'slidenum')
    while (run.firstChild) field.appendChild(run.firstChild)
    run.replaceWith(field)
    zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
    const document = await documentFrom(await zip.generateAsync({ type: 'arraybuffer' }))
    editText(firstText(document), 'Changed field')
    const original = JSON.stringify(document)
    await expect(exportPresentationPptx(document)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'source-conflict' })]
    })
    expect(JSON.stringify(document)).toBe(original)
    firstText(document).pptxSourceNode!.id = 'nonexistent'
    await expect(exportPresentationPptx(document)).rejects.toBeInstanceOf(PptxExportError)
  })

  it('preserves dynamic fields and omitted inherited styles during formatting-only edits', async () => {
    const { bytes } = await hymn()
    const zip = await JSZip.loadAsync(bytes)
    const xml = new DOMParser().parseFromString(
      await zip.file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const run = xml.getElementsByTagNameNS(ans, 'r')[0]
    const field = xml.createElementNS(ans, 'a:fld')
    field.setAttribute('id', '{00000000-0000-0000-0000-000000000001}')
    field.setAttribute('type', 'slidenum')
    while (run.firstChild) field.appendChild(run.firstChild)
    run.replaceWith(field)
    const properties = field.getElementsByTagNameNS(ans, 'rPr')[0]
    properties.removeAttribute('sz')
    properties.setAttributeNS('urn:hhc:opaque', 'opaque:keep', 'run-metadata')
    zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
    const original = await zip.generateAsync({ type: 'arraybuffer' })
    const document = await documentFrom(original)
    firstText(document).paragraphs![0].runs[0].bold =
      !firstText(document).paragraphs![0].runs[0].bold
    const output = await buildSourcePptx(document)
    await assertUntouched(original, output, new Set(['ppt/slides/slide1.xml']))
    const patched = new DOMParser().parseFromString(
      await (await JSZip.loadAsync(output)).file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const retained = patched.getElementsByTagNameNS(ans, 'fld')[0]
    expect(retained).toBeDefined()
    expect(retained.getAttribute('type')).toBe('slidenum')
    expect(retained.getElementsByTagNameNS(ans, 't')).toHaveLength(1)
    expect(retained.getElementsByTagNameNS(ans, 't')[0].textContent).toBe(
      firstText(document).paragraphs![0].runs[0].text
    )
    const style = retained.getElementsByTagNameNS(ans, 'rPr')[0]
    expect(style.getAttribute('b')).toBe(
      firstText(document).paragraphs![0].runs[0].bold ? '1' : '0'
    )
    expect(style.hasAttribute('sz')).toBe(false)
    expect(style.getAttributeNS('urn:hhc:opaque', 'keep')).toBe('run-metadata')
  })

  it('freezes effective font sizes for edited autofit text, new runs and empty paragraphs', async () => {
    const { bytes } = await combinedShape()
    const zip = await JSZip.loadAsync(bytes)
    const xml = new DOMParser().parseFromString(
      await zip.file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const body = xml.getElementsByTagNameNS(pns, 'txBody')[0]
    const properties = body.getElementsByTagNameNS(ans, 'bodyPr')[0]
    properties.getElementsByTagNameNS(ans, 'noAutofit')[0].remove()
    const scale = xml.createElementNS(ans, 'a:normAutofit')
    scale.setAttribute('fontScale', '50000')
    scale.setAttribute('lnSpcReduction', '0')
    properties.appendChild(scale)
    const originalSize = Number(body.getElementsByTagNameNS(ans, 'rPr')[0].getAttribute('sz')) / 75
    const empty = xml.createElementNS(ans, 'a:p')
    const end = xml.createElementNS(ans, 'a:endParaRPr')
    end.setAttribute('sz', String(originalSize * 75))
    empty.appendChild(end)
    body.appendChild(empty)
    zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
    const original = await zip.generateAsync({ type: 'arraybuffer' })
    const document = await documentFrom(original)
    expect(new Uint8Array(await buildSourcePptx(document))).toEqual(new Uint8Array(original))
    const text = firstText(document)
    expect(text.paragraphs![0].runs[0].fontSize).toBe(originalSize / 2)
    expect.soft(text.paragraphs![1].typingStyle?.fontSize).toBe(originalSize / 2)
    text.paragraphs![0].runs[0].fontSize = 50
    const resized = await documentFrom(await buildSourcePptx(document))
    expect.soft(firstText(resized).paragraphs![0].runs[0].fontSize).toBe(50)
    text.paragraphs![0].runs.push({ ...text.paragraphs![0].runs[0], text: ' New', fontSize: 30 })
    text.paragraphs![1].typingStyle!.fontSize = 22
    text.paragraphs!.push({
      ...text.paragraphs![1],
      runs: [],
      typingStyle: { ...text.paragraphs![1].typingStyle!, fontSize: 28 }
    })
    const output = await buildSourcePptx(document)
    await validatePptxPackage(output)
    await assertUntouched(original, output, new Set(['ppt/slides/slide1.xml']))
    const reopened = firstText(await documentFrom(output))
    expect.soft(reopened.paragraphs![0].runs.map((run) => run.fontSize)).toEqual([50, 30])
    expect.soft(reopened.paragraphs![1].typingStyle?.fontSize).toBe(22)
    expect.soft(reopened.paragraphs![2].typingStyle?.fontSize).toBe(28)
    const patched = new DOMParser().parseFromString(
      await (await JSZip.loadAsync(output)).file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    expect(patched.getElementsByTagNameNS(ans, 'normAutofit')).toHaveLength(0)
    expect(patched.getElementsByTagNameNS(ans, 'noAutofit')).toHaveLength(1)
    for (const run of patched.getElementsByTagNameNS(ans, 'r'))
      expect(run.getElementsByTagNameNS(ans, 't')).toHaveLength(1)
    const contentSized = structuredClone(document)
    firstText(contentSized).autoSize = 'content'
    const withoutScale = firstText(await documentFrom(await buildSourcePptx(contentSized)))
    expect(withoutScale.paragraphs![0].runs.map((run) => run.fontSize)).toEqual([50, 30])
    expect(withoutScale.paragraphs![1].typingStyle?.fontSize).toBe(22)
    scale.setAttribute('lnSpcReduction', '20000')
    zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
    const unsupported = await documentFrom(await zip.generateAsync({ type: 'arraybuffer' }))
    firstText(unsupported).paragraphs![0].runs[0].fontSize = 50
    const snapshot = JSON.stringify(unsupported)
    await expect(exportPresentationPptx(unsupported)).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: 'source-conflict',
          slideId: unsupported.slideOrder[0],
          elementId: firstText(unsupported).id
        })
      ]
    })
    expect(JSON.stringify(unsupported)).toBe(snapshot)
  })

  it.each(['100000', null])(
    'freezes resized autofit text even when fontScale is %s',
    async (fontScale) => {
      const { bytes } = await combinedShape()
      const zip = await JSZip.loadAsync(bytes)
      const xml = new DOMParser().parseFromString(
        await zip.file('ppt/slides/slide1.xml')!.async('string'),
        'application/xml'
      )
      const properties = xml
        .getElementsByTagNameNS(pns, 'txBody')[0]
        .getElementsByTagNameNS(ans, 'bodyPr')[0]
      properties.getElementsByTagNameNS(ans, 'noAutofit')[0].remove()
      const scale = xml.createElementNS(ans, 'a:normAutofit')
      if (fontScale) scale.setAttribute('fontScale', fontScale)
      properties.appendChild(scale)
      zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
      const document = await documentFrom(await zip.generateAsync({ type: 'arraybuffer' }))
      const text = firstText(document)
      const expectedSize = text.paragraphs![0].runs[0].fontSize
      text.x += 10
      const moved = new DOMParser().parseFromString(
        await (await JSZip.loadAsync(await buildSourcePptx(document)))
          .file('ppt/slides/slide1.xml')!
          .async('string'),
        'application/xml'
      )
      expect(moved.getElementsByTagNameNS(ans, 'normAutofit')).toHaveLength(1)
      text.width += 10
      const output = await buildSourcePptx(document)
      const resized = new DOMParser().parseFromString(
        await (await JSZip.loadAsync(output)).file('ppt/slides/slide1.xml')!.async('string'),
        'application/xml'
      )
      expect(resized.getElementsByTagNameNS(ans, 'normAutofit')).toHaveLength(0)
      expect(firstText(await documentFrom(output)).paragraphs![0].runs[0].fontSize).toBe(
        expectedSize
      )
      scale.setAttributeNS('urn:hhc:opaque', 'opaque:keep', 'autofit')
      zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
      const opaque = await documentFrom(await zip.generateAsync({ type: 'arraybuffer' }))
      firstText(opaque).width += 10
      await expect(exportPresentationPptx(opaque)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'source-conflict' })]
      })
    }
  )

  it('patches owned frames without removing flips or unmodified transform attributes', async () => {
    const native = createBlankEditablePresentationDocument('Flipped image')
    native.assets.image = {
      id: 'image',
      name: 'Image.png',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png}`
    }
    const slide = native.slides[native.slideOrder[0]]
    slide.elements = {
      image: {
        id: 'image',
        type: 'image',
        assetId: 'image',
        x: 5,
        y: 6,
        width: 100,
        height: 80,
        rotation: 0,
        opacity: 1
      }
    }
    slide.elementOrder = ['image']
    const zip = await JSZip.loadAsync(await buildNativePptx(native))
    const xml = new DOMParser().parseFromString(
      await zip.file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const transform = xml
      .getElementsByTagNameNS(pns, 'pic')[0]
      .getElementsByTagNameNS(ans, 'xfrm')[0]
    transform.setAttribute('flipH', '1')
    transform.setAttribute('flipV', '1')
    transform.removeAttribute('rot')
    transform.setAttributeNS('urn:hhc:opaque', 'opaque:keep', 'transform')
    transform
      .getElementsByTagNameNS(ans, 'off')[0]
      .setAttributeNS('urn:hhc:opaque', 'opaque:keep', 'offset')
    zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
    const original = await zip.generateAsync({ type: 'arraybuffer' })
    const document = await documentFrom(original)
    const image = Object.values(document.slides[document.slideOrder[0]].elements)[0]
    image.x += 25
    image.height += 20
    const output = await buildSourcePptx(document)
    await validatePptxPackage(output)
    await assertUntouched(original, output, new Set(['ppt/slides/slide1.xml']))
    const patched = new DOMParser().parseFromString(
      await (await JSZip.loadAsync(output)).file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const frame = patched
      .getElementsByTagNameNS(pns, 'pic')[0]
      .getElementsByTagNameNS(ans, 'xfrm')[0]
    expect(frame.getAttribute('flipH')).toBe('1')
    expect(frame.getAttribute('flipV')).toBe('1')
    expect(frame.hasAttribute('rot')).toBe(false)
    expect(frame.getAttributeNS('urn:hhc:opaque', 'keep')).toBe('transform')
    expect(
      frame.getElementsByTagNameNS(ans, 'off')[0].getAttributeNS('urn:hhc:opaque', 'keep')
    ).toBe('offset')
    const imported = await documentFrom(output)
    expect(Object.values(imported.slides[imported.slideOrder[0]].elements)[0]).toMatchObject({
      x: image.x,
      height: image.height
    })
  })

  it('refuses aggregate note edits with retained custom text shapes without altering input', async () => {
    const native = createBlankEditablePresentationDocument('Custom notes')
    native.slides[native.slideOrder[0]].notes = 'Body'
    const zip = await JSZip.loadAsync(await buildNativePptx(native))
    const xml = new DOMParser().parseFromString(
      await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string'),
      'application/xml'
    )
    const body = Array.from(xml.getElementsByTagNameNS(pns, 'sp')).find(
      (node) => node.getElementsByTagNameNS(pns, 'ph')[0]?.getAttribute('type') === 'body'
    )!
    const custom = body.cloneNode(true) as Element
    custom.getElementsByTagNameNS(pns, 'ph')[0].remove()
    custom.getElementsByTagNameNS(pns, 'cNvPr')[0].setAttribute('id', '9001')
    custom.getElementsByTagNameNS(ans, 't')[0].textContent = 'Custom'
    body.parentNode!.appendChild(custom)
    zip.file('ppt/notesSlides/notesSlide1.xml', new XMLSerializer().serializeToString(xml))
    const original = await zip.generateAsync({ type: 'arraybuffer' })
    const document = await documentFrom(original)
    expect(document.slides[document.slideOrder[0]].notes).toBe('Body\nCustom')
    expect(new Uint8Array(await buildSourcePptx(document))).toEqual(new Uint8Array(original))
    document.slides[document.slideOrder[0]].notes = 'Body edited\nCustom'
    const snapshot = JSON.stringify(document)
    await expect(exportPresentationPptx(document)).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'source-conflict', slideId: document.slideOrder[0] })
      ]
    })
    expect(JSON.stringify(document)).toBe(snapshot)
  })

  it('keeps whitespace explicit and paragraph inheritance when adding empty and rich paragraphs', async () => {
    const { document } = await hymn()
    const text = firstText(document)
    const paragraph = text.paragraphs![0]
    text.paragraphs = [
      { ...paragraph, runs: [{ ...paragraph.runs[0], text: '  Leading & trailing  ' }] },
      { ...paragraph, runs: [], typingStyle: { ...paragraph.typingStyle!, fontSize: 33 } },
      { ...paragraph, runs: [{ ...paragraph.runs[0], text: 'Last', italic: true }] }
    ]
    const output = await buildSourcePptx(document)
    const xml = new DOMParser().parseFromString(
      await (await JSZip.loadAsync(output)).file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    expect(
      xml
        .getElementsByTagNameNS(ans, 't')[0]
        .getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space')
    ).toBe('preserve')
    const reopened = firstText(await documentFrom(output))
    expect(reopened.text).toBe('  Leading & trailing  \n\nLast')
    expect(reopened.paragraphs![1].typingStyle?.fontSize).toBe(33)
    expect(reopened.paragraphs![2].runs[0].italic).toBe(true)
  })

  it('deletes only geometry while retaining the source text role', async () => {
    const { document } = await combinedShape()
    const slide = document.slides[document.slideOrder[0]]
    const geometry = Object.values(slide.elements).find((element) => element.type === 'shape')!
    delete slide.elements[geometry.id]
    slide.elementOrder = slide.elementOrder.filter((id) => id !== geometry.id)
    const reopened = await documentFrom(await buildSourcePptx(document))
    const elements = Object.values(reopened.slides[reopened.slideOrder[0]].elements)
    expect(elements).toHaveLength(1)
    expect(elements[0]).toMatchObject({ type: 'text', text: 'Original text' })
  })

  it('shares original media across copies and new objects while keeping inert external relationships', async () => {
    const native = createBlankEditablePresentationDocument('Shared image')
    native.assets.image = {
      id: 'image',
      name: 'Image.png',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png}`
    }
    const slide = native.slides[native.slideOrder[0]]
    slide.elements = {
      image: {
        id: 'image',
        type: 'image',
        assetId: 'image',
        x: 5,
        y: 6,
        width: 100,
        height: 80,
        rotation: 0,
        opacity: 1
      }
    }
    slide.elementOrder = ['image']
    const zip = await JSZip.loadAsync(await buildNativePptx(native))
    const rels = new DOMParser().parseFromString(
      await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string'),
      'application/xml'
    )
    const external = rels.createElementNS(relns, 'Relationship')
    for (const [key, value] of Object.entries({
      Id: 'rIdOpaque',
      Type: `${rns}/hyperlink`,
      Target: 'https://example.invalid/inert',
      TargetMode: 'External'
    }))
      external.setAttribute(key, value)
    rels.documentElement.appendChild(external)
    zip.file('ppt/slides/_rels/slide1.xml.rels', new XMLSerializer().serializeToString(rels))
    const original = await zip.generateAsync({ type: 'arraybuffer' })
    let document = await documentFrom(original)
    const first = document.slides[document.slideOrder[0]]
    const image = Object.values(first.elements).find((element) => element.type === 'image')!
    if (image.type !== 'image') throw new Error('Missing image')
    image.crop = { top: 0.1, right: 0.2, bottom: 0, left: 0 }
    image.opacity = 0.6
    image.borderColor = '#abcdef'
    image.borderWidth = 4
    image.shadow = 'soft'
    first.elements.newImage = { ...image, id: 'newImage', pptxSourceNode: undefined, x: 200 }
    first.elementOrder.push('newImage')
    document = duplicateEditableSlides(document, [first.id], 1).document
    const fetch = vi.fn(() => {
      throw new Error('External fetch must never occur')
    })
    vi.stubGlobal('fetch', fetch)
    const output = await (await exportPresentationPptx(document)).arrayBuffer()
    expect(fetch).not.toHaveBeenCalled()
    const result = await JSZip.loadAsync(output)
    const media = Object.keys(result.files).filter(
      (name) => name.startsWith('ppt/media/') && !result.files[name].dir
    )
    expect(media).toHaveLength(1)
    expect(await result.file('ppt/media/image1.png')!.async('base64')).toBe(png)
    expect(await result.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).toContain(
      'https://example.invalid/inert'
    )
    const reopened = await documentFrom(output)
    expect(reopened.slideOrder).toHaveLength(2)
    for (const id of reopened.slideOrder) {
      const images = Object.values(reopened.slides[id].elements)
      expect(images).toHaveLength(2)
      expect(images[0]).toMatchObject({
        type: 'image',
        crop: image.crop,
        opacity: 0.6,
        borderColor: '#ABCDEF',
        borderWidth: 4,
        shadow: 'soft'
      })
    }
  })

  it('patches existing notes and adds new notes without changing unrelated source members', async () => {
    const native = createBlankEditablePresentationDocument('Notes')
    native.slides[native.slideOrder[0]].notes = 'Original note'
    const nativeZip = await JSZip.loadAsync(await buildNativePptx(native))
    const noteXml = new DOMParser().parseFromString(
      await nativeZip.file('ppt/notesSlides/notesSlide1.xml')!.async('string'),
      'application/xml'
    )
    noteXml
      .getElementsByTagNameNS(ans, 'rPr')[0]
      .setAttributeNS('urn:hhc:opaque', 'opaque:keep', 'notes-metadata')
    nativeZip.file(
      'ppt/notesSlides/notesSlide1.xml',
      new XMLSerializer().serializeToString(noteXml)
    )
    const bytes = await nativeZip.generateAsync({ type: 'arraybuffer' })
    const document = await documentFrom(bytes)
    document.slides[document.slideOrder[0]].notes = ' First line\n\nLast & line '
    const output = await (await exportPresentationPptx(document)).arrayBuffer()
    await assertUntouched(
      bytes,
      output,
      new Set(['ppt/notesSlides/notesSlide1.xml', 'ppt/slides/slide1.xml'])
    )
    const noteOutput = new DOMParser().parseFromString(
      await (await JSZip.loadAsync(output))
        .file('ppt/notesSlides/notesSlide1.xml')!
        .async('string'),
      'application/xml'
    )
    expect(
      noteOutput.getElementsByTagNameNS(ans, 'rPr')[0]?.getAttributeNS('urn:hhc:opaque', 'keep')
    ).toBe('notes-metadata')
    expect(noteOutput.getElementsByTagNameNS(ans, 'p')).toHaveLength(3)
    const reopened = await documentFrom(output)
    expect(reopened.slides[reopened.slideOrder[0]].notes).toBe(' First line\n\nLast & line ')
    const hymnDocument = (await hymn()).document
    hymnDocument.slides[hymnDocument.slideOrder[0]].notes = 'New note'
    const newOutput = await (await exportPresentationPptx(hymnDocument)).arrayBuffer()
    const newReopened = await documentFrom(newOutput)
    expect(newReopened.slides[newReopened.slideOrder[0]].notes).toBe('New note')
  })

  it('retains the position of unknown inert nodes and background extensions during a local edit', async () => {
    const { bytes } = await combinedShape()
    const zip = await JSZip.loadAsync(bytes)
    const xml = new DOMParser().parseFromString(
      await zip.file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const tree = xml.getElementsByTagNameNS(pns, 'spTree')[0]
    const opaque = xml.createElementNS('urn:hhc:opaque', 'opaque:metadata')
    opaque.textContent = 'retained inert value'
    const second = tree.getElementsByTagNameNS(pns, 'sp')[0].cloneNode(true) as Element
    second.getElementsByTagNameNS(pns, 'cNvPr')[0].setAttribute('id', '9002')
    tree.append(opaque, second)
    const background = xml.getElementsByTagNameNS(pns, 'bgPr')[0]
    background.setAttributeNS('urn:hhc:opaque', 'opaque:keep', 'background-metadata')
    const ext = xml.createElementNS(ans, 'a:extLst')
    ext.appendChild(opaque.cloneNode(true))
    background.appendChild(ext)
    zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
    const document = await documentFrom(await zip.generateAsync({ type: 'arraybuffer' }))
    const slide = document.slides[document.slideOrder[0]]
    slide.background = { type: 'solid', color: '#123456', transparency: 0 }
    editText(firstText(document), 'Edited text')
    const output = await (await exportPresentationPptx(document)).arrayBuffer()
    const result = new DOMParser().parseFromString(
      await (await JSZip.loadAsync(output)).file('ppt/slides/slide1.xml')!.async('string'),
      'application/xml'
    )
    const children = Array.from(result.getElementsByTagNameNS(pns, 'spTree')[0].children)
    const opaqueIndex = children.findIndex((node) => node.namespaceURI === 'urn:hhc:opaque')
    const shapeIndices = children.flatMap((node, index) => (node.localName === 'sp' ? [index] : []))
    expect(opaqueIndex).toBeGreaterThan(shapeIndices[0])
    expect(opaqueIndex).toBeLessThan(shapeIndices[1])
    const bg = result.getElementsByTagNameNS(pns, 'bgPr')[0]
    expect(bg.getAttributeNS('urn:hhc:opaque', 'keep')).toBe('background-metadata')
    expect(bg.getElementsByTagNameNS('urn:hhc:opaque', 'metadata')[0].textContent).toBe(
      'retained inert value'
    )
  })

  it('adds notes through a notes-only dependency graph', async () => {
    const { bytes, document } = await hymn()
    document.slides[document.slideOrder[0]].notes = 'New note'
    const output = await (await exportPresentationPptx(document)).arrayBuffer()
    await assertUntouched(
      bytes,
      output,
      new Set([
        'ppt/presentation.xml',
        'ppt/_rels/presentation.xml.rels',
        'ppt/slides/_rels/slide1.xml.rels',
        '[Content_Types].xml'
      ])
    )
    const zip = await JSZip.loadAsync(output)
    expect(
      Object.keys(zip.files).filter((name) => /^ppt\/slides\/[^/]+\.xml$/.test(name))
    ).toHaveLength(22)
  })

  it('allocates a new image dependency and keeps the original media immutable', async () => {
    const native = createBlankEditablePresentationDocument('Replace image')
    native.assets.image = {
      id: 'image',
      name: 'Image.png',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png}`
    }
    const slide = native.slides[native.slideOrder[0]]
    slide.elements = {
      image: {
        id: 'image',
        type: 'image',
        assetId: 'image',
        x: 5,
        y: 6,
        width: 100,
        height: 80,
        rotation: 0,
        opacity: 1
      }
    }
    slide.elementOrder = ['image']
    const bytes = await buildNativePptx(native)
    const document = await documentFrom(bytes)
    const current = document.slides[document.slideOrder[0]]
    const image = Object.values(current.elements).find((element) => element.type === 'image')!
    if (image.type !== 'image') throw new Error('Missing image')
    const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    document.assets.changed = {
      id: 'changed',
      name: 'Changed.gif',
      mimeType: 'image/gif',
      dataUrl: `data:image/gif;base64,${gif}`
    }
    image.assetId = 'changed'
    const newText = createTextElement({ text: 'Added text', autoWidth: false, autoSize: 'fixed' })
    current.elements[newText.id] = newText
    current.elementOrder.push(newText.id)
    const original = JSON.stringify(document)
    const output = await (await exportPresentationPptx(document)).arrayBuffer()
    await assertUntouched(
      bytes,
      output,
      new Set(['[Content_Types].xml', 'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels'])
    )
    const reopened = await documentFrom(output)
    const images = Object.values(reopened.slides[reopened.slideOrder[0]].elements).filter(
      (element) => element.type === 'image'
    )
    expect(reopened.assets[images[0].assetId].dataUrl).toBe(`data:image/gif;base64,${gif}`)
    expect(firstText(reopened).text).toBe('Added text')
    expect(JSON.stringify(document)).toBe(original)
  })
})
