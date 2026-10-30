import { describe, expect, it } from 'vitest'
import {
  createBlankEditablePresentationDocument,
  createTextElement,
  type EditablePresentationElement,
  type EditablePresentationDocument,
  type EditableSlideBackground
} from '../editable-presentation'
import { normalizeTextParagraphs } from '../presentation-rich-text'
import { PptxExportError, writeSlideDrawingMl } from '../pptx-export-drawingml'

const a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
function fixture(elements: EditablePresentationElement[] = []): {
  document: EditablePresentationDocument
  slideId: string
} {
  const document = createBlankEditablePresentationDocument('Export')
  const slideId = document.slideOrder[0]
  document.slides[slideId].elementOrder = elements.map((element) => element.id)
  document.slides[slideId].elements = Object.fromEntries(
    elements.map((element) => [element.id, element])
  )
  return { document, slideId }
}
const all = (root: Document | Element, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(a, name))
const one = (root: Document | Element, name: string): Element => all(root, name)[0]

describe('editable DrawingML output', () => {
  it('preserves Chinese, whitespace, empty paragraphs and explicit no-bullet with fixed frames', () => {
    const text = createTextElement({
      text: '  主愛<&>\n\n 願祢榮耀  ',
      x: 12,
      y: 15,
      width: 300,
      height: 140,
      fontSize: 24,
      fontFamily: 'Noto Sans TC',
      characterSpacing: 2,
      rotation: -45,
      opacity: 0.5,
      color: '#123456',
      autoWidth: false,
      autoSize: 'fixed'
    })
    text.textInsets = { top: 1, right: 2, bottom: 3, left: 4 }
    text.verticalAlign = 'center'
    const { document, slideId } = fixture([text])
    const original = JSON.stringify(document)
    const xml = writeSlideDrawingMl(document, slideId, new Map())
    expect(all(xml, 't').map((node) => node.textContent)).toEqual(['  主愛<&>', ' 願祢榮耀  '])
    expect(all(xml, 'p')).toHaveLength(3)
    expect(all(xml, 'buNone')).toHaveLength(3)
    expect(all(xml, 'noAutofit')).toHaveLength(1)
    expect(one(xml.getElementsByTagNameNS(p, 'sp')[0], 'xfrm').getAttribute('rot')).toBe('18900000')
    expect(one(xml.getElementsByTagNameNS(p, 'sp')[0], 'off').getAttribute('x')).toBe('114300')
    expect(one(xml.getElementsByTagNameNS(p, 'sp')[0], 'ext').getAttribute('cx')).toBe('2857500')
    expect(one(xml, 'rPr').getAttribute('sz')).toBe('1800')
    expect(one(xml, 'rPr').getAttribute('lang')).toBe('zh-TW')
    expect(one(xml, 'rPr').getAttribute('spc')).toBe('150')
    expect(one(xml, 'alpha').getAttribute('val')).toBe('50000')
    expect(one(xml, 'bodyPr').getAttribute('lIns')).toBe('38100')
    expect(one(xml, 'bodyPr').getAttribute('anchor')).toBe('ctr')
    expect(JSON.stringify(document)).toBe(original)
    const serialized = new XMLSerializer().serializeToString(xml)
    expect(serialized).toContain('&lt;&amp;&gt;')
    expect(
      new DOMParser()
        .parseFromString(serialized, 'application/xml')
        .getElementsByTagName('parsererror')
    ).toHaveLength(0)
  })

  it('writes paragraph spacing, list starts, levels and rich styles including empty typing style', () => {
    const text = createTextElement({ text: 'first\nsecond\n', fontSize: 20 })
    text.paragraphs = normalizeTextParagraphs(text)
    text.paragraphs[0].list = {
      kind: 'number',
      level: 1,
      format: 'arabicPeriod',
      startAt: 3,
      sequenceId: 'internal'
    }
    text.paragraphs[0].lineSpacing = { kind: 'exact', points: 18 }
    text.paragraphs[0].marginLeft = 12
    text.paragraphs[0].textIndent = -8
    text.paragraphs[0].align = 'justify'
    text.paragraphs[0].runs[0] = {
      ...text.paragraphs[0].runs[0],
      bold: true,
      italic: true,
      underline: true,
      strikethrough: true,
      baseline: 'superscript',
      highlightColor: '#ffcc00',
      color: 'rgb(10, 20, 30)'
    }
    text.paragraphs[1].list = { kind: 'bullet', level: 2, char: '●', font: 'Arial' }
    text.paragraphs[1].lineSpacing = { kind: 'multiple', value: 1.25 }
    text.paragraphs[2].typingStyle!.fontSize = 32
    const { document, slideId } = fixture([text])
    const xml = writeSlideDrawingMl(document, slideId, new Map())
    expect(one(xml, 'buAutoNum').getAttribute('startAt')).toBe('3')
    expect(one(xml, 'buChar').getAttribute('char')).toBe('●')
    expect(one(xml, 'buFont').getAttribute('typeface')).toBe('Arial')
    expect(one(xml, 'pPr').getAttribute('indent')).toBe('-76200')
    expect(one(xml, 'pPr').getAttribute('algn')).toBe('just')
    expect(one(xml, 'spcPts').getAttribute('val')).toBe('1800')
    expect(one(xml, 'spcPct').getAttribute('val')).toBe('125000')
    expect(one(xml, 'rPr').getAttribute('strike')).toBe('sngStrike')
    expect(one(xml, 'rPr').getAttribute('baseline')).toBe('30000')
    expect(one(xml, 'highlight').firstElementChild?.getAttribute('val')).toBe('FFCC00')
    expect(all(xml, 'endParaRPr').at(-1)?.getAttribute('sz')).toBe('2400')
  })

  it.each([
    ['left-right', 90, '0'],
    ['top-bottom', 180, '5400000'],
    ['diagonal', 135, '2700000']
  ] as const)('converts %s gradients, alpha and brightness', (direction, angle, expected) => {
    const { document, slideId } = fixture()
    document.slides[slideId].background = {
      type: 'gradient',
      gradientType: 'linear',
      direction,
      angle,
      stops: [
        { color: '#000000', position: 0, transparency: 25, brightness: 50 },
        { color: '#ffffff', position: 100, transparency: 0, brightness: -50 }
      ]
    }
    const xml = writeSlideDrawingMl(document, slideId, new Map())
    expect(one(xml, 'lin').getAttribute('ang')).toBe(expected)
    expect(all(xml, 'gs').map((node) => node.getAttribute('pos'))).toEqual(['0', '100000'])
    expect(one(xml, 'gs').firstElementChild?.getAttribute('val')).toBe('808080')
    expect(one(xml, 'alpha').getAttribute('val')).toBe('75000')
  })

  it('exports shape/line and image crop, effects, media refs with unique IDs and invisible zero outlines', () => {
    const base = { x: 10, y: 20, width: 80, height: 40, rotation: 30, opacity: 0.7 }
    const { document, slideId } = fixture([
      {
        ...base,
        id: 'shape',
        type: 'shape',
        shape: 'ellipse',
        fillColor: 'transparent',
        strokeColor: '#ff0000',
        strokeWidth: 0
      },
      { ...base, id: 'line', type: 'line', strokeColor: '#123456', strokeWidth: 4 },
      {
        ...base,
        id: 'image',
        type: 'image',
        assetId: 'asset',
        crop: { top: 0.1, right: 0.2, bottom: 0.05, left: 0.15 },
        borderColor: '#abcdef',
        borderWidth: 3,
        shadow: 'medium'
      }
    ])
    const xml = writeSlideDrawingMl(document, slideId, new Map([['asset', 'rId2']]))
    expect(one(xml, 'srcRect').getAttribute('l')).toBe('15000')
    expect(one(xml, 'blip').getAttributeNS(r, 'embed')).toBe('rId2')
    expect(one(xml, 'alphaModFix').getAttribute('amt')).toBe('70000')
    expect(all(xml, 'outerShdw')).toHaveLength(1)
    expect(all(xml, 'ln').map((node) => node.getAttribute('w'))).toEqual(['0', '38100', '28575'])
    expect(all(xml, 'ln')[0].firstElementChild?.localName).toBe('noFill')
    const ids = Array.from(xml.getElementsByTagNameNS(p, 'cNvPr')).map((node) =>
      node.getAttribute('id')
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(['currentColor', 'var(--private-color)', 'not-a-color'])(
    'rejects unresolved color %s without a black fallback',
    (color) => {
      const text = createTextElement({ text: 'unsafe fallback', color })
      const { document, slideId } = fixture([text])
      try {
        writeSlideDrawingMl(document, slideId, new Map())
        expect.fail('Expected a located error')
      } catch (error) {
        expect(error).toBeInstanceOf(PptxExportError)
        expect((error as PptxExportError).diagnostics[0]).toMatchObject({
          code: 'invalid-value',
          slideId,
          elementId: text.id
        })
      }
    }
  )

  it('rejects locked objects, non-finite geometry and missing image relationships', () => {
    const base = { x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1 }
    for (const element of [
      { ...base, id: 'locked', type: 'locked', label: 'Chart' },
      { ...base, id: 'image', type: 'image', assetId: 'missing' },
      createTextElement({ text: 'bad', x: Number.NaN })
    ] satisfies EditablePresentationElement[]) {
      const { document, slideId } = fixture([element])
      expect(() => writeSlideDrawingMl(document, slideId, new Map())).toThrow(PptxExportError)
    }
  })

  it('handles legacy solid and gradient backgrounds without mutating them', () => {
    for (const background of [
      { type: 'color', color: 'navy' },
      { type: 'gradient', from: '#000000', to: '#ffffff', direction: 'left-right' }
    ] satisfies EditableSlideBackground[]) {
      const { document, slideId } = fixture()
      document.slides[slideId].background = background
      const before = JSON.stringify(background)
      expect(() => writeSlideDrawingMl(document, slideId, new Map())).not.toThrow()
      expect(JSON.stringify(background)).toBe(before)
    }
  })
})
