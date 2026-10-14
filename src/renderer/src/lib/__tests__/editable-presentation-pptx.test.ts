import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createPptxSource, validatePptxSource, validatePptxPackage } from '../pptx-source'
import JSZip from 'jszip'
import { validatePortablePresentation } from '../portable-presentation'
import { buildPresentation, materializeAllSlideNodes, parseZip } from '@aiden0z/pptx-renderer'
import {
  convertPresentationData,
  generateEditablePresentationThumbnail,
  createBlankEditablePresentationDocument,
  createShapeElement
} from '../editable-presentation'
import type { PresentationData } from '@aiden0z/pptx-renderer'
import { buildNativePptx } from '../pptx-export-package'
import { buildSourcePptx } from '../pptx-export-source'
import type { FileItemRecord } from '@shared/types/folder'

async function parseFixture(
  background = '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>',
  shapeProperties = '',
  image?: { extension: string; bytes: Uint8Array },
  onPackage?: (buffer: ArrayBuffer) => void
): Promise<PresentationData> {
  const zip = new JSZip()
  const ns =
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const rel = (type: string, target: string): string =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`
  )
  zip.file('ppt/_rels/presentation.xml.rels', rel('slide', 'slides/slide1.xml'))
  zip.file(
    'ppt/slides/slide1.xml',
    `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Synthetic text"/><p:cNvSpPr/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm>${shapeProperties}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="9000"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ea typeface="標楷體"/></a:rPr><a:t>Synthetic sample</a:t></a:r></a:p><a:p><a:r><a:t>Inherited style</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  )
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    rel('slideLayout', '../slideLayouts/slideLayout1.xml')
  )
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `<p:sldLayout ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Subtitle"/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr anchor="ctr" lIns="190500" rIns="285750" tIns="95250" bIns="381000"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="6000"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ea typeface="標楷體"/></a:defRPr></a:lvl1pPr></a:lstStyle><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`
  )
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rel('slideMaster', '../slideMasters/slideMaster1.xml')
  )
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<p:sldMaster ${ns}><p:cSld><p:bg><p:bgPr>${background}</p:bgPr></p:bg><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1"/><p:txStyles/></p:sldMaster>`
  )
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rel('theme', '../theme/theme1.xml'))
  zip.file(
    'ppt/theme/theme1.xml',
    `<a:theme ${ns}><a:themeElements><a:clrScheme name="Synthetic"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1></a:clrScheme><a:fontScheme name="Synthetic"><a:majorFont/><a:minorFont/></a:fontScheme><a:fmtScheme name="Synthetic"/></a:themeElements></a:theme>`
  )
  if (image) {
    const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    zip.file(
      'ppt/slides/slide1.xml',
      slideXml.replace(
        '</p:spTree>',
        '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic></p:spTree>'
      )
    )
    const relationships = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      relationships.replace(
        '</Relationships>',
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image.${image.extension}"/></Relationships>`
      )
    )
    zip.file(`ppt/media/image.${image.extension}`, image.bytes)
  }
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${image ? `<Default Extension="${image.extension}" ContentType="image/${image.extension}"/>` : ''}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`
  )
  zip.file('_rels/.rels', rel('officeDocument', 'ppt/presentation.xml'))
  const buffer = await zip.generateAsync({ type: 'arraybuffer' })
  onPackage?.(buffer)
  const presentation = buildPresentation(await parseZip(buffer))
  materializeAllSlideNodes(presentation)
  return presentation
}

describe('PPTX parser conversion contract', () => {
  it('preserves embedded BMP MIME and bytes through portable JSON reload', async () => {
    const bytes = new Uint8Array(58)
    const header = new DataView(bytes.buffer)
    bytes.set([0x42, 0x4d])
    header.setUint32(2, 58, true)
    header.setUint32(10, 54, true)
    header.setUint32(14, 40, true)
    header.setInt32(18, 1, true)
    header.setInt32(22, 1, true)
    header.setUint16(26, 1, true)
    header.setUint16(28, 24, true)
    header.setUint32(34, 4, true)
    const presentation = await parseFixture(undefined, '', { extension: 'bmp', bytes })
    const document = convertPresentationData(
      { id: 'test', name: 'Picture.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const asset = Object.values(document.assets)[0]
    expect(asset.mimeType).toBe('image/bmp')
    expect(asset.dataUrl).toBe(`data:image/bmp;base64,${btoa(String.fromCharCode(...bytes))}`)
    const reopened = JSON.parse(JSON.stringify(document))
    expect(() => validatePortablePresentation(reopened)).not.toThrow()
    expect(reopened.assets).toEqual(document.assets)
  })

  it('rejects an unknown embedded image extension explicitly', async () => {
    const presentation = await parseFixture(undefined, '', {
      extension: 'unknown',
      bytes: new Uint8Array([1, 2, 3])
    })
    expect(() =>
      convertPresentationData(
        { id: 'test', name: 'Picture.pptx', url: 'blob:test' } as FileItemRecord,
        presentation
      )
    ).toThrow('Unsupported PowerPoint image format')
  })

  it.each(['rect', 'line'])('preserves explicit %s outline width', async (geometry) => {
    const presentation = await parseFixture(
      undefined,
      `<a:prstGeom prst="${geometry}"/><a:ln w="38100"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>`
    )
    const document = convertPresentationData(
      { id: 'test', name: 'Outline.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const slide = document.slides[document.slideOrder[0]]
    const outline = Object.values(slide.elements).find(
      (element) => element.type === 'shape' || element.type === 'line'
    )
    expect(outline).toMatchObject({ strokeWidth: 4, strokeColor: '#FF0000' })
    expect(atob(generateEditablePresentationThumbnail(document).split(',')[1])).toContain(
      'stroke-width="4"'
    )
  })

  it.each(['<a:ln w="38100"><a:noFill/></a:ln>', ''])(
    'does not invent an outline for %s',
    async (line) => {
      const presentation = await parseFixture(
        undefined,
        `<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>${line}`
      )
      const document = convertPresentationData(
        { id: 'test', name: 'Outline.pptx', url: 'blob:test' } as FileItemRecord,
        presentation
      )
      const slide = document.slides[document.slideOrder[0]]
      const shape = Object.values(slide.elements).find((element) => element.type === 'shape')
      expect(shape?.type === 'shape' ? shape.strokeWidth : 0).toBe(0)
    }
  )

  it('retains the one-pixel fallback for a visible outline without explicit width', async () => {
    const presentation = await parseFixture(
      undefined,
      '<a:prstGeom prst="rect"/><a:ln><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>'
    )
    const document = convertPresentationData(
      { id: 'test', name: 'Outline.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const slide = document.slides[document.slideOrder[0]]
    expect(Object.values(slide.elements).find((element) => element.type === 'shape')).toMatchObject(
      { strokeWidth: 1 }
    )
  })

  it.each(['-1', 'NaN', 'Infinity'])('rejects invalid outline width %s', async (width) => {
    const presentation = await parseFixture(
      undefined,
      `<a:prstGeom prst="rect"/><a:ln w="${width}"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>`
    )
    expect(() =>
      convertPresentationData(
        { id: 'test', name: 'Outline.pptx', url: 'blob:test' } as FileItemRecord,
        presentation
      )
    ).toThrow('Invalid PowerPoint outline width')
  })

  it('inherits extended run styles while respecting explicit local overrides', async () => {
    const presentation = await parseFixture()
    const layout = [...presentation.layouts.values()][0]
    const defaults = layout.placeholders[0].node
      .child('txBody')
      .child('lstStyle')
      .child('lvl1pPr')
      .child('defRPr').element
    if (!defaults) throw new Error('Expected defaults')
    defaults.setAttribute('strike', 'sngStrike')
    defaults.setAttribute('baseline', '30000')
    defaults.setAttribute('spc', '150')
    const highlight = defaults.ownerDocument.createElementNS(
      'http://schemas.openxmlformats.org/drawingml/2006/main',
      'a:highlight'
    )
    const color = defaults.ownerDocument.createElementNS(
      'http://schemas.openxmlformats.org/drawingml/2006/main',
      'a:srgbClr'
    )
    color.setAttribute('val', 'FFFF00')
    highlight.appendChild(color)
    defaults.appendChild(highlight)
    const node = presentation.slides[0].nodes[0]
    if (node.nodeType !== 'shape') throw new Error('Expected shape')
    const local = node.textBody?.paragraphs[0].runs[0].properties?.element
    if (!local) throw new Error('Expected local style')
    local.setAttribute('strike', 'noStrike')
    local.setAttribute('baseline', '0')
    local.setAttribute('spc', '0')
    const document = convertPresentationData(
      { id: 'test', name: 'Styles.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const slide = document.slides[document.slideOrder[0]]
    const text = Object.values(slide.elements).find((element) => element.type === 'text')
    if (text?.type !== 'text') throw new Error('Expected text')
    expect(text.paragraphs?.[0].runs[0]).toMatchObject({
      strikethrough: false,
      baseline: 'normal',
      characterSpacing: 0,
      highlightColor: '#FFFF00'
    })
    expect(text.paragraphs?.[1].runs[0]).toMatchObject({
      strikethrough: true,
      baseline: 'superscript',
      characterSpacing: 2,
      highlightColor: '#FFFF00'
    })
  })

  it('retains whitespace and empty paragraphs across imported text representations', async () => {
    const presentation = await parseFixture()
    const node = presentation.slides[0].nodes[0]
    if (node.nodeType !== 'shape' || !node.textBody) throw new Error('Expected text')
    const paragraphs = node.textBody.paragraphs
    paragraphs[0].runs[0].text = '  title  '
    paragraphs[1].runs[0].text = ''
    paragraphs.push({ ...paragraphs[1], runs: [{ ...paragraphs[1].runs[0], text: 'tail ' }] })
    const document = convertPresentationData(
      { id: 'test', name: 'Whitespace.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const slide = document.slides[document.slideOrder[0]]
    const text = Object.values(slide.elements).find((element) => element.type === 'text')
    if (text?.type !== 'text') throw new Error('Expected text')
    expect(text.text).toBe('  title  \n\ntail ')
    expect(text.runs?.map((run) => run.text).join('')).toBe(text.text)
    expect(
      text.paragraphs?.map((paragraph) => paragraph.runs.map((run) => run.text).join('')).join('\n')
    ).toBe(text.text)
    expect(() => validatePortablePresentation(JSON.parse(JSON.stringify(document)))).not.toThrow()
  })

  it('retains an editable invisible rectangle without treating it as unsupported', async () => {
    const presentation = await parseFixture(
      undefined,
      '<a:prstGeom prst="rect"/><a:noFill/><a:ln><a:noFill/></a:ln>'
    )
    const node = presentation.slides[0].nodes[0]
    if (node.nodeType !== 'shape') throw new Error('Expected shape')
    node.textBody = undefined
    const document = convertPresentationData(
      { id: 'test', name: 'Invisible.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const slide = document.slides[document.slideOrder[0]]
    expect(Object.values(slide.elements)).toEqual([
      expect.objectContaining({ type: 'shape', fillColor: 'transparent', strokeWidth: 0 })
    ])
  })

  it.each([0, 38100, undefined])(
    'prefers explicit near-top text coordinates over layout coordinates (y=%s)',
    async (offsetY) => {
      let bytes: ArrayBuffer | undefined
      await parseFixture(
        undefined,
        '<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="000000"/></a:solidFill>',
        undefined,
        (buffer) => {
          bytes = buffer
        }
      )
      const zip = await JSZip.loadAsync(bytes!)
      const slidePath = 'ppt/slides/slide1.xml'
      const slideXml = await zip.file(slidePath)!.async('string')
      zip.file(
        slidePath,
        offsetY === undefined
          ? slideXml.replace(/<a:xfrm>.*?<\/a:xfrm>/, '')
          : slideXml.replace('x="0" y="0"', `x="0" y="${offsetY}"`)
      )
      const layoutPath = 'ppt/slideLayouts/slideLayout1.xml'
      zip.file(
        layoutPath,
        (await zip.file(layoutPath)!.async('string')).replace(
          '<p:spPr/>',
          '<p:spPr><a:xfrm><a:off x="1524000" y="1122363"/><a:ext cx="9144000" cy="2387600"/></a:xfrm></p:spPr>'
        )
      )
      const presentation = buildPresentation(
        await parseZip(await zip.generateAsync({ type: 'arraybuffer' }))
      )
      materializeAllSlideNodes(presentation)
      const doc = convertPresentationData(
        { id: 'test', name: 'Synthetic.pptx', url: 'blob:test' } as FileItemRecord,
        presentation
      )
      const slide = doc.slides[doc.slideOrder[0]]
      const text = Object.values(slide.elements).find((e) => e.type === 'text')!
      const shape = Object.values(slide.elements).find((e) => e.type === 'shape')!
      expect(shape).toMatchObject({ x: offsetY === undefined ? 160 : 0 })
      expect(shape.y).toBeCloseTo((offsetY ?? 1122363) / 9525, 6)
      expect(text).toMatchObject({
        type: 'text',
        align: 'center',
        x: offsetY === undefined ? 160 : 0,
        width: offsetY === undefined ? 960 : 1280
      })
      expect(text.y).toBeCloseTo((offsetY ?? 1122363) / 9525, 6)
    }
  )

  it('inherits master background, mapped text colors and layout paragraph formatting', async () => {
    const presentation = await parseFixture()
    const document = convertPresentationData(
      { id: 'test', name: 'Synthetic.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const slide = document.slides[document.slideOrder[0]]
    expect(slide.background).toEqual({ type: 'solid', color: '#000000', transparency: 0 })
    const text = slide.elements[slide.elementOrder[0]]
    expect(text).toMatchObject({
      type: 'text',
      color: '#FFFFFF',
      align: 'center',
      fontSize: 120,
      fontFamily: '標楷體',
      verticalAlign: 'center',
      textInsets: { left: 20, right: 30, top: 10, bottom: 40 }
    })
    if (text.type !== 'text') throw new Error('Expected text')
    const thumbnail = atob(generateEditablePresentationThumbnail(document).split(',')[1])
    expect(thumbnail).toContain('text-align:center;text-align-last:auto')
    expect(thumbnail).toContain('padding:10px 30px 40px 20px')
    expect(thumbnail).toContain('justify-content:center')
    expect(text.paragraphs?.[1]).toMatchObject({
      align: 'center',
      runs: [{ text: 'Inherited style', color: '#FFFFFF', fontSize: 80, fontFamily: '標楷體' }]
    })
  })
  it('preserves explicit background alpha from the parser', async () => {
    const presentation = await parseFixture(
      '<a:solidFill><a:srgbClr val="123456"><a:alpha val="75000"/></a:srgbClr></a:solidFill>'
    )
    const document = convertPresentationData(
      { id: 'test', name: 'Synthetic.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    expect(document.slides[document.slideOrder[0]].background).toEqual({
      type: 'solid',
      color: '#123456',
      transparency: 25
    })
  })

  it('rejects unsupported background fills instead of silently replacing them with white', async () => {
    const presentation = await parseFixture('<a:gradFill><a:gsLst/></a:gradFill>')
    expect(() =>
      convertPresentationData(
        { id: 'test', name: 'Synthetic.pptx', url: 'blob:test' } as FileItemRecord,
        presentation
      )
    ).toThrow('Unsupported PowerPoint background fill')
  })
  it('rejects visible master decorations but permits suppressed master graphics', async () => {
    const presentation = await parseFixture()
    const master = [...presentation.masters.values()][0]
    const tree = master.spTree.element
    if (!tree) throw new Error('Expected master tree')
    tree.appendChild(
      tree.ownerDocument.createElementNS(
        'http://schemas.openxmlformats.org/presentationml/2006/main',
        'p:pic'
      )
    )
    const source = { id: 'test', name: 'Synthetic.pptx', url: 'blob:test' } as FileItemRecord
    expect(() => convertPresentationData(source, presentation)).toThrow(
      'Unsupported PowerPoint layout or master decoration'
    )
    presentation.slides[0].showMasterSp = false
    expect(() => convertPresentationData(source, presentation)).not.toThrow()
  })
  it('preserves PowerPoint normal autofit font scaling', async () => {
    const presentation = await parseFixture()
    const node = presentation.slides[0].nodes[0]
    if (node.nodeType !== 'shape') throw new Error('Expected shape')
    const body = node.textBody?.bodyProperties?.element
    if (!body) throw new Error('Expected body properties')
    const fit = body.ownerDocument.createElementNS(
      'http://schemas.openxmlformats.org/drawingml/2006/main',
      'a:normAutofit'
    )
    fit.setAttribute('fontScale', '90000')
    body.appendChild(fit)
    const document = convertPresentationData(
      { id: 'test', name: 'Synthetic.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const slide = document.slides[document.slideOrder[0]]
    const text = slide.elements[slide.elementOrder[0]]
    expect(text).toMatchObject({
      fontSize: 108,
      paragraphs: [{ runs: [{ fontSize: 108 }] }, { runs: [{ fontSize: 72 }] }]
    })
  })
  it('inherits layout bullets and respects an explicit local no-bullet override', async () => {
    const presentation = await parseFixture()
    const layout = [...presentation.layouts.values()][0]
    const level = layout.placeholders[0].node
      .child('txBody')
      .child('lstStyle')
      .child('lvl1pPr').element
    if (!level) throw new Error('Expected layout paragraph')
    const bullet = level.ownerDocument.createElementNS(
      'http://schemas.openxmlformats.org/drawingml/2006/main',
      'a:buChar'
    )
    bullet.setAttribute('char', '•')
    level.setAttribute('marL', '381000')
    level.setAttribute('indent', '-190500')
    level.appendChild(bullet)
    const node = presentation.slides[0].nodes[0]
    if (node.nodeType !== 'shape' || !node.textBody) throw new Error('Expected text')
    const paragraph = node.source.child('txBody').children('p')[0]
    const properties = level.ownerDocument.createElementNS(
      'http://schemas.openxmlformats.org/drawingml/2006/main',
      'a:pPr'
    )
    properties.appendChild(
      level.ownerDocument.createElementNS(
        'http://schemas.openxmlformats.org/drawingml/2006/main',
        'a:buNone'
      )
    )
    paragraph.element?.appendChild(properties)
    node.textBody.paragraphs[0].properties = paragraph.child('pPr')
    const document = convertPresentationData(
      { id: 'test', name: 'Synthetic.pptx', url: 'blob:test' } as FileItemRecord,
      presentation
    )
    const slide = document.slides[document.slideOrder[0]]
    expect(slide.elements[slide.elementOrder[0]]).toMatchObject({
      paragraphs: [{ list: null }, { list: { kind: 'bullet', char: '•' } }]
    })
  })

  it.each(['gradient', 'arrow'])(
    'rejects a text-bearing %s shape instead of losing its appearance',
    async (kind) => {
      const presentation = await parseFixture()
      const node = presentation.slides[0].nodes[0]
      if (node.nodeType !== 'shape') throw new Error('Expected shape')
      if (kind === 'arrow') node.presetGeometry = 'rightArrow'
      else {
        const properties = node.source.child('spPr')
        const element = properties.element
        if (!element) throw new Error('Expected shape properties')
        element.appendChild(
          element.ownerDocument.createElementNS(
            'http://schemas.openxmlformats.org/drawingml/2006/main',
            'a:gradFill'
          )
        )
        node.fill = properties
      }
      expect(() =>
        convertPresentationData(
          { id: 'test', name: 'Synthetic.pptx', url: 'blob:test' } as FileItemRecord,
          presentation
        )
      ).toThrow(/Unsupported PowerPoint shape/)
    }
  )
})

afterEach(() => vi.unstubAllGlobals())

it('binds supplied source to original shape, text and picture nodes while default conversion stays v1', async () => {
  vi.stubGlobal('crypto', webcrypto)
  let packageBuffer: ArrayBuffer | undefined
  const presentation = await parseFixture(
    undefined,
    '<a:prstGeom prst="rect"/>',
    { extension: 'png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) },
    (buffer) => {
      packageBuffer = buffer
    }
  )
  if (!packageBuffer) throw new Error('Package not captured')
  const retained = await createPptxSource(packageBuffer)
  const input = {
    id: 'source',
    parentId: 'file-root',
    type: 'file' as const,
    name: 'Source.pptx',
    url: '',
    size: packageBuffer.byteLength,
    createdAt: 1,
    expiresAt: null,
    sortIndex: 0,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
  const converted = convertPresentationData(input, presentation, retained)
  expect(converted).toMatchObject({ schemaVersion: 2, pptxSource: retained })
  const slide = converted.slides[converted.slideOrder[0]]
  expect(slide.pptxSourcePart).toBe('ppt/slides/slide1.xml')
  expect(Object.values(slide.elements).map((element) => element.pptxSourceNode)).toEqual([
    { id: '2', role: 'geometry' },
    { id: '2', role: 'text' },
    { id: '3', role: 'image' }
  ])
  await expect(validatePptxSource(converted)).resolves.toBeUndefined()
  const old = convertPresentationData(input, presentation)
  expect(old.schemaVersion).toBe(1)
  expect(old).not.toHaveProperty('pptxSource')
  expect(old.slides[old.slideOrder[0]]).not.toHaveProperty('pptxSourcePart')
})

const source = {
  id: 'preset-source',
  name: 'Preset.pptx',
  url: 'blob:preset-source'
} as FileItemRecord

async function presetFixture(
  preset: string,
  guides: string | null = '',
  extra = '',
  body = '',
  geometryNamespace?: string
): Promise<PresentationData> {
  let original!: ArrayBuffer
  await parseFixture(
    undefined,
    `<a:prstGeom ${geometryNamespace ? `xmlns:a="${geometryNamespace}" ` : ''}prst="${preset}">${guides === null ? '' : `<a:avLst>${guides}</a:avLst>`}</a:prstGeom>${extra === 'flipH' ? '' : extra}`,
    undefined,
    (bytes) => {
      original = bytes
    }
  )
  const zip = await JSZip.loadAsync(original)
  const xml = (await zip.file('ppt/slides/slide1.xml')!.async('string'))
    .replace(/<p:txBody>[\s\S]*?<\/p:txBody>/, body)
    .replace('<p:ph type="subTitle" idx="1"/>', '')
    .replace('<a:xfrm>', extra === 'flipH' ? '<a:xfrm flipH="1">' : '<a:xfrm>')
  zip.file('ppt/slides/slide1.xml', xml)
  const presentation = buildPresentation(
    await parseZip(await zip.generateAsync({ type: 'arraybuffer' }))
  )
  materializeAllSlideNodes(presentation)
  return presentation
}

it.each([
  'roundRect',
  'triangle',
  'rtTriangle',
  'diamond',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow'
])('admits %s only for explicit v3 conversion and retains default omission', async (preset) => {
  const presentation = await presetFixture(preset)
  expect(() => convertPresentationData(source, presentation)).toThrow(/geometry/)
  const document = convertPresentationData(source, presentation, undefined, new Map(), 3)
  expect(document.schemaVersion).toBe(3)
  const element = Object.values(document.slides[document.slideOrder[0]].elements)[0]
  expect(element).toMatchObject({ type: 'shape', shape: preset })
  expect(element).not.toHaveProperty('adjustments')
  expect(() => validatePortablePresentation(document)).not.toThrow()
})

it('retains constant raw adjustments and materializes a sparse named prefix in preset order', async () => {
  const presentation = await presetFixture('rightArrow', '<a:gd name="adj2" fmla="val 75000"/>')
  const document = convertPresentationData(source, presentation, undefined, new Map(), 3)
  expect(Object.values(document.slides[document.slideOrder[0]].elements)[0]).toMatchObject({
    shape: 'rightArrow',
    adjustments: [50000, 75000]
  })
})

it.each([
  '<a:gd name="adj" fmla="val 1"/><a:gd name="adj" fmla="val 2"/>',
  '<a:gd name="other" fmla="val 1"/>',
  '<a:gd name="adj" fmla="*/ w 1 2"/>',
  '<a:gd name="adj" fmla="val 1.5"/>',
  '<a:gd name="adj" fmla="val 2147483648"/>',
  '<a:gd name="adj" fmla="val NaN"/>',
  '<a:gd name="adj" fmla="val 1e2"/>'
])(
  'rejects unknown/ambiguous/nonconstant preset adjustments with source location: %s',
  async (guides) => {
    const presentation = await presetFixture('roundRect', guides)
    try {
      convertPresentationData(source, presentation, undefined, new Map(), 3)
      expect.unreachable('unsafe preset adjustments accepted')
    } catch (error) {
      expect(error).toMatchObject({
        diagnostic: { code: 'shape', slideNumber: 1, objectNumber: 1, objectId: '2' }
      })
    }
  }
)

it.each([
  [
    'embedded text',
    '',
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Attached text</a:t></a:r></a:p></p:txBody>'
  ],
  ['reflection', 'flipH', ''],
  ['effect', '<a:effectLst><a:outerShdw/></a:effectLst>', ''],
  ['3D', '<a:sp3d extrusionH="9525"/>', ''],
  ['dash', '<a:ln w="9525"><a:prstDash val="dash"/></a:ln>', ''],
  ['outline end', '<a:ln w="9525"><a:headEnd type="triangle"/></a:ln>', ''],
  ['gradient', '<a:gradFill><a:gsLst/></a:gradFill>', '']
])('rejects unrepresented v3 shape properties before admitting %s', async (_name, extra, body) => {
  const presentation = await presetFixture('roundRect', '', extra, body)
  expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow()
})

it('accepts a missing avLst as preset defaults and rejects duplicate adjustment containers', async () => {
  const presentation = await presetFixture('triangle', null)
  const document = convertPresentationData(source, presentation, undefined, new Map(), 3)
  expect(Object.values(document.slides[document.slideOrder[0]].elements)[0]).toMatchObject({
    shape: 'triangle'
  })
  expect(Object.values(document.slides[document.slideOrder[0]].elements)[0]).not.toHaveProperty(
    'adjustments'
  )
  const duplicated = await presetFixture(
    'triangle',
    '',
    '<a:prstGeom prst="triangle"><a:avLst/></a:prstGeom>'
  )
  expect(() => convertPresentationData(source, duplicated, undefined, new Map(), 3)).toThrow(
    /adjustments/
  )
})

it('rejects preset geometry in an unrecognized XML namespace instead of rendering it', async () => {
  const presentation = await presetFixture('roundRect', '', '', '', 'urn:unknown-geometry')
  expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow()
})

it.each([
  ['triangle', '<a:round/>'],
  ['rightArrow', '<a:round/>'],
  ['rightArrow', '<a:miter lim="800000"/>'],
  ['upArrow', '<a:miter/>']
])('admits the represented Office default join for %s: %s', async (kind, join) => {
  const presentation = await presetFixture(kind, '', '<a:ln w="9525">' + join + '</a:ln>')
  expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).not.toThrow()
})

it.each([
  ['triangle', '<a:miter/>'],
  ['leftArrow', '<a:miter lim="800000"/>'],
  ['rightArrow', '<a:miter lim="400000"/>'],
  ['downArrow', '<a:bevel/>']
])('rejects a join that the v3 model cannot preserve for %s: %s', async (kind, join) => {
  const presentation = await presetFixture(kind, '', '<a:ln w="9525">' + join + '</a:ln>')
  expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
    /outline/
  )
})

async function themeStyleFixture(
  reference: 'fillRef' | 'lnRef' | 'effectRef',
  options: {
    localOverride?: boolean
    harmless?: boolean
    index?: string
    preset?: 'triangle' | 'rectangle' | 'rightArrow'
    partialLine?: 'w' | 'solidFill' | 'prstDash'
    themeLineJoin?: 'round' | 'miter'
    fillXml?: string
    referenceColorXml?: string
    themeLineXml?: string
    localLineXml?: string
    omitStyle?: boolean
  } = {}
): Promise<{ presentation: PresentationData; bytes: ArrayBuffer }> {
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const document = createBlankEditablePresentationDocument('Theme preset')
  document.schemaVersion = 3
  const shape = createShapeElement(options.preset ?? 'triangle', {
    width: 300,
    height: 200,
    fillColor: '#ff0000',
    strokeColor: '#000000',
    strokeWidth: 2
  })
  const slide = document.slides[document.slideOrder[0]]
  slide.elements = { [shape.id]: shape }
  slide.elementOrder = [shape.id]
  const zip = await JSZip.loadAsync(await buildNativePptx(document))
  const xml = new DOMParser().parseFromString(
    await zip.file('ppt/slides/slide1.xml')!.async('string'),
    'application/xml'
  )
  const properties = xml.getElementsByTagNameNS(drawing, 'prstGeom')[0].parentElement!
  if (!options.localOverride && reference === 'fillRef')
    properties.getElementsByTagNameNS(drawing, 'solidFill')[0].remove()
  if (!options.localOverride && reference === 'lnRef')
    properties.getElementsByTagNameNS(drawing, 'ln')[0].remove()
  if (options.partialLine) {
    const line = properties.getElementsByTagNameNS(drawing, 'ln')[0]
    if (options.partialLine === 'w') line.removeAttribute('w')
    else line.getElementsByTagNameNS(drawing, options.partialLine)[0].remove()
  }
  if (options.localOverride && reference === 'effectRef')
    properties.insertAdjacentHTML('beforeend', '<a:effectLst xmlns:a="' + drawing + '"/>')
  const style = xml.createElementNS(
    'http://schemas.openxmlformats.org/presentationml/2006/main',
    'p:style'
  )
  for (const name of ['lnRef', 'fillRef', 'effectRef', 'fontRef']) {
    const entry = xml.createElementNS(drawing, 'a:' + name)
    entry.setAttribute(
      'idx',
      name === 'fontRef' ? 'minor' : name === reference ? (options.index ?? '1') : '0'
    )
    const color = xml.createElementNS(drawing, 'a:srgbClr')
    color.setAttribute('val', 'FF0000')
    entry.appendChild(color)
    if (name === reference && options.referenceColorXml) entry.innerHTML = options.referenceColorXml
    style.appendChild(entry)
  }
  if (options.localLineXml) {
    properties.getElementsByTagNameNS(drawing, 'ln')[0]?.remove()
    const replacement = new DOMParser().parseFromString(
      `<root xmlns:a="${drawing}">${options.localLineXml}</root>`,
      'application/xml'
    ).documentElement.firstElementChild!
    properties.appendChild(xml.importNode(replacement, true))
  }
  if (!options.omitStyle) properties.parentElement!.appendChild(style)
  zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml))
  const theme = new DOMParser().parseFromString(
    await zip.file('ppt/theme/theme1.xml')!.async('string'),
    'application/xml'
  )
  const effects = theme.getElementsByTagNameNS(drawing, 'effectLst')[0]
  if (options.harmless) {
    const fill = theme.getElementsByTagNameNS(drawing, 'fillStyleLst')[0]
    fill.firstElementChild!.replaceWith(theme.createElementNS(drawing, 'a:noFill'))
    const line = theme.getElementsByTagNameNS(drawing, 'lnStyleLst')[0].firstElementChild!
    while (line.firstChild) line.firstChild.remove()
    line.appendChild(theme.createElementNS(drawing, 'a:noFill'))
  } else {
    const line = theme.getElementsByTagNameNS(drawing, 'lnStyleLst')[0].firstElementChild!
    line.setAttribute('w', '95250')
    line.getElementsByTagNameNS(drawing, 'prstDash')[0].setAttribute('val', 'dash')
    const shadow = theme.createElementNS(drawing, 'a:outerShdw')
    for (const [key, value] of Object.entries({ blurRad: '38100', dist: '38100', dir: '2700000' }))
      shadow.setAttribute(key, value)
    const color = theme.createElementNS(drawing, 'a:srgbClr')
    color.setAttribute('val', '000000')
    shadow.appendChild(color)
    effects.appendChild(shadow)
  }
  if (options.themeLineJoin) {
    const line = theme.getElementsByTagNameNS(drawing, 'lnStyleLst')[0].firstElementChild!
    line.appendChild(theme.createElementNS(drawing, 'a:' + options.themeLineJoin))
  }
  if (options.themeLineXml) {
    const line = theme.getElementsByTagNameNS(drawing, 'lnStyleLst')[0].firstElementChild!
    const replacement = new DOMParser().parseFromString(
      `<root xmlns:a="${drawing}">${options.themeLineXml}</root>`,
      'application/xml'
    ).documentElement.firstElementChild!
    line.replaceWith(theme.importNode(replacement, true))
  }
  if (options.fillXml) {
    const list = Number(options.index ?? '1') >= 1001 ? 'bgFillStyleLst' : 'fillStyleLst'
    const fill = theme.getElementsByTagNameNS(drawing, list)[0].firstElementChild!
    const replacement = new DOMParser().parseFromString(
      `<root xmlns:a="${drawing}">${options.fillXml}</root>`,
      'application/xml'
    ).documentElement.firstElementChild!
    fill.replaceWith(theme.importNode(replacement, true))
  }
  zip.file('ppt/theme/theme1.xml', new XMLSerializer().serializeToString(theme))
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  await validatePptxPackage(bytes)
  const presentation = buildPresentation(await parseZip(bytes))
  materializeAllSlideNodes(presentation)
  return { presentation, bytes }
}

it.each(['fillRef', 'lnRef', 'effectRef'] as const)(
  'rejects unrepresented inherited theme %s with source location before v3 conversion',
  async (reference) => {
    const { presentation, bytes } = await themeStyleFixture(
      reference,
      reference === 'fillRef' ? { fillXml: '<a:gradFill/>' } : {}
    )
    const retained = await createPptxSource(bytes)
    for (const original of [undefined, retained]) {
      try {
        convertPresentationData(source, presentation, original, new Map(), 3)
        expect.unreachable('Inherited visual style was silently lost')
      } catch (error) {
        expect(error).toMatchObject({
          diagnostic: { code: 'shape', slideNumber: 1, objectNumber: 1 }
        })
      }
    }
  }
)

it.each(['fillRef', 'lnRef', 'effectRef'] as const)(
  'keeps explicit local overrides of inherited theme %s',
  async (reference) => {
    const { presentation } = await themeStyleFixture(reference, { localOverride: true })
    const result = convertPresentationData(source, presentation, undefined, new Map(), 3)
    expect(Object.values(result.slides[result.slideOrder[0]].elements)[0]).toMatchObject({
      shape: 'triangle',
      fillColor: '#FF0000',
      strokeColor: '#000000',
      strokeWidth: 2
    })
  }
)

it.each(['fillRef', 'lnRef', 'effectRef'] as const)(
  'accepts harmless inherited theme %s without introducing paint',
  async (reference) => {
    const { presentation } = await themeStyleFixture(reference, { harmless: true })
    const result = convertPresentationData(source, presentation, undefined, new Map(), 3)
    expect(() => validatePortablePresentation(result)).not.toThrow()
    const element = Object.values(result.slides[result.slideOrder[0]].elements)[0]
    if (reference === 'fillRef') expect(element).toMatchObject({ fillColor: 'transparent' })
    if (reference === 'lnRef') expect(element).toMatchObject({ strokeWidth: 0 })
  }
)

it.each(['0', '-1', '1.5', '4'])(
  'handles inherited theme index %s without guessing an absent style',
  async (index) => {
    const { presentation } = await themeStyleFixture('fillRef', { index })
    const convert = (): unknown =>
      convertPresentationData(source, presentation, undefined, new Map(), 3)
    if (index === '0') expect(convert).not.toThrow()
    else expect(convert).toThrow(/theme/i)
  }
)

it('applies theme admission to ordinary basic-shape conversion while preserving v2 source compatibility', async () => {
  const { presentation, bytes } = await themeStyleFixture('fillRef', {
    preset: 'rectangle',
    fillXml: '<a:gradFill/>'
  })
  expect(() => convertPresentationData(source, presentation)).toThrow(/theme/i)
  const retained = await createPptxSource(bytes)
  expect(convertPresentationData(source, presentation, retained).schemaVersion).toBe(2)
})

it.each(['prstDash'] as const)(
  'rejects an inherited theme line when the local override leaves %s unresolved',
  async (partialLine) => {
    const { presentation } = await themeStyleFixture('lnRef', { localOverride: true, partialLine })
    expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
      /theme/i
    )
  }
)

it.each(['round', 'miter'] as const)(
  'accepts inherited %s joins that match the Office right-arrow default',
  async (themeLineJoin) => {
    const { presentation } = await themeStyleFixture('lnRef', {
      preset: 'rightArrow',
      localOverride: true,
      themeLineJoin
    })
    expect(() =>
      convertPresentationData(source, presentation, undefined, new Map(), 3)
    ).not.toThrow()
  }
)

it('rejects an inherited nondefault miter join on a triangle', async () => {
  const { presentation } = await themeStyleFixture('lnRef', {
    localOverride: true,
    themeLineJoin: 'miter'
  })
  expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
    /theme/i
  )
})

describe('resolved theme solid fills', () => {
  it.each(['triangle', 'rectangle'] as const)(
    'imports inherited placeholder color for %s',
    async (preset) => {
      const { presentation } = await themeStyleFixture('fillRef', { preset })
      const result = convertPresentationData(
        source,
        presentation,
        undefined,
        new Map(),
        preset === 'triangle' ? 3 : undefined
      )
      const element = Object.values(result.slides[result.slideOrder[0]].elements)[0]
      expect(element).toMatchObject({ type: 'shape', fillColor: '#FF0000' })
      const reopened = buildPresentation(await parseZip(await buildNativePptx(result)))
      materializeAllSlideNodes(reopened)
      const roundTrip = convertPresentationData(
        source,
        reopened,
        undefined,
        new Map(),
        preset === 'triangle' ? 3 : undefined
      )
      expect(Object.values(roundTrip.slides[roundTrip.slideOrder[0]].elements)[0]).toMatchObject({
        fillColor: '#FF0000'
      })
    }
  )

  it.each([
    [
      'saved system color',
      '1',
      '<a:solidFill><a:sysClr val="windowText" lastClr="112233"/></a:solidFill>',
      '#112233'
    ],
    [
      'alpha offset',
      '1',
      '<a:solidFill><a:schemeClr val="phClr"><a:alphaOff val="-25000"/></a:schemeClr></a:solidFill>',
      'rgba(255, 0, 0, 0.75)'
    ],
    ['concrete RGB', '1', '<a:solidFill><a:srgbClr val="2468AC"/></a:solidFill>', '#2468AC'],
    ['background fill', '1001', '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>', '#FF0000'],
    [
      'linear tint',
      '1',
      '<a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill>',
      '#FFBCBC'
    ],
    [
      'linear shade',
      '1',
      '<a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill>',
      '#BC0000'
    ],
    [
      'ordered luminance',
      '1',
      '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="50000"/><a:lumOff val="20000"/></a:schemeClr></a:solidFill>',
      '#E60000'
    ],
    [
      'reverse luminance',
      '1',
      '<a:solidFill><a:schemeClr val="phClr"><a:lumOff val="20000"/><a:lumMod val="50000"/></a:schemeClr></a:solidFill>',
      '#B30000'
    ],
    [
      'alpha',
      '1',
      '<a:solidFill><a:schemeClr val="phClr"><a:alphaMod val="50000"/></a:schemeClr></a:solidFill>',
      'rgba(255, 0, 0, 0.25)'
    ]
  ])('resolves %s using the style matrix', async (name, index, fillXml, expected) => {
    const { presentation } = await themeStyleFixture('fillRef', {
      index,
      fillXml,
      referenceColorXml:
        name === 'alpha' ? '<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>' : undefined
    })
    const result = convertPresentationData(source, presentation, undefined, new Map(), 3)
    expect(Object.values(result.slides[result.slideOrder[0]].elements)[0]).toMatchObject({
      fillColor: expected
    })
  })

  it('preserves exact source bytes, then writes an explicit edited fill without altering its theme', async () => {
    const { presentation, bytes } = await themeStyleFixture('fillRef')
    const retained = await createPptxSource(bytes)
    const document = convertPresentationData(source, presentation, retained, new Map(), 3)
    expect(new Uint8Array(await buildSourcePptx(document))).toEqual(new Uint8Array(bytes))
    const slide = document.slides[document.slideOrder[0]]
    const element = slide.elements[slide.elementOrder[0]]
    if (element.type !== 'shape') throw new Error('Expected theme-filled shape')
    element.fillColor = '#123456'
    const output = await buildSourcePptx(document)
    const originalZip = await JSZip.loadAsync(bytes)
    const editedZip = await JSZip.loadAsync(output)
    for (const [name, member] of Object.entries(originalZip.files)) {
      if (member.dir || name === 'ppt/slides/slide1.xml') continue
      expect(await editedZip.file(name)!.async('uint8array'), name).toEqual(
        await member.async('uint8array')
      )
    }
    const reopened = buildPresentation(await parseZip(output))
    materializeAllSlideNodes(reopened)
    const result = convertPresentationData(source, reopened, undefined, new Map(), 3)
    expect(Object.values(result.slides[result.slideOrder[0]].elements)[0]).toMatchObject({
      fillColor: '#123456'
    })
  })

  it('resolves mapped theme reference color before applying matrix transforms', async () => {
    const { presentation } = await themeStyleFixture('fillRef', {
      referenceColorXml: '<a:schemeClr val="tx1"><a:lumOff val="20000"/></a:schemeClr>',
      fillXml:
        '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="50000"/></a:schemeClr></a:solidFill>'
    })
    const result = convertPresentationData(source, presentation, undefined, new Map(), 3)
    expect(Object.values(result.slides[result.slideOrder[0]].elements)[0]).toMatchObject({
      fillColor: '#1A1A1A'
    })
  })

  it('rejects an unresolved reference placeholder without recursion', async () => {
    const { presentation } = await themeStyleFixture('fillRef', {
      referenceColorXml: '<a:schemeClr val="phClr"/>'
    })
    expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
      /theme fill/
    )
  })

  it.each([
    '<a:solidFill><a:schemeClr val="missing"/></a:solidFill>',
    '<a:solidFill><a:srgbClr val="invalid"/></a:solidFill>',
    '<a:solidFill><a:schemeClr val="phClr"><a:alpha val="NaN"/></a:schemeClr></a:solidFill>',
    '<a:solidFill><a:schemeClr val="phClr"><a:unknown val="50000"/></a:schemeClr></a:solidFill>'
  ])('rejects unresolved or unrepresented color without guessing: %s', async (fillXml) => {
    const { presentation } = await themeStyleFixture('fillRef', { fillXml })
    expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
      expect.objectContaining({
        diagnostic: expect.objectContaining({ code: 'shape', slideNumber: 1, objectNumber: 1 })
      })
    )
  })
})

describe('resolved theme solid lines', () => {
  const solid =
    '<a:ln w="95250"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>'
  it.each(['rectangle', 'triangle'] as const)(
    'imports inherited color and width for %s',
    async (preset) => {
      const { presentation } = await themeStyleFixture('lnRef', { preset, themeLineXml: solid })
      const version = preset === 'triangle' ? 3 : undefined
      const document = convertPresentationData(source, presentation, undefined, new Map(), version)
      expect(Object.values(document.slides[document.slideOrder[0]].elements)[0]).toMatchObject({
        strokeColor: '#FF0000',
        strokeWidth: 10
      })
      const reopened = buildPresentation(await parseZip(await buildNativePptx(document)))
      materializeAllSlideNodes(reopened)
      const result = convertPresentationData(source, reopened, undefined, new Map(), version)
      expect(Object.values(result.slides[result.slideOrder[0]].elements)[0]).toMatchObject({
        strokeColor: '#FF0000',
        strokeWidth: 10
      })
    }
  )
  it.each([
    ['width only', '<a:ln w="19050"/>', '#FF0000', 2],
    [
      'color only',
      '<a:ln><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln>',
      '#123456',
      10
    ],
    [
      'placeholder color',
      '<a:ln><a:solidFill><a:schemeClr val="phClr"><a:alpha val="50000"/></a:schemeClr></a:solidFill></a:ln>',
      'rgba(255, 0, 0, 0.5)',
      10
    ],
    ['no fill', '<a:ln><a:noFill/></a:ln>', '#000000', 0],
    ['zero width without paint', '<a:ln w="0"><a:noFill/></a:ln>', '#000000', 0]
  ] as const)(
    'merges a local %s override',
    async (_name, localLineXml, strokeColor, strokeWidth) => {
      const { presentation } = await themeStyleFixture('lnRef', {
        themeLineXml: solid,
        localLineXml
      })
      const document = convertPresentationData(source, presentation, undefined, new Map(), 3)
      expect(Object.values(document.slides[document.slideOrder[0]].elements)[0]).toMatchObject({
        strokeColor,
        strokeWidth
      })
    }
  )
  it('rejects a painted local zero-width hairline without a theme reference', async () => {
    const { presentation } = await themeStyleFixture('lnRef', {
      omitStyle: true,
      localLineXml: '<a:ln w="0"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln>'
    })
    expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
      /hairline/
    )
  })
  it.each(['local', 'inherited'] as const)(
    'rejects a painted %s zero-width hairline instead of losing it',
    async (origin) => {
      const { presentation } = await themeStyleFixture('lnRef', {
        themeLineXml: origin === 'inherited' ? solid.replace('95250', '0') : solid,
        localLineXml: origin === 'local' ? '<a:ln w="0"/>' : undefined
      })
      expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
        /hairline/
      )
    }
  )
  it.each(['-1', 'NaN', '1.5'])(
    'rejects malformed inherited width %s with location',
    async (width) => {
      const { presentation } = await themeStyleFixture('lnRef', {
        themeLineXml: solid.replace('95250', width)
      })
      expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
        expect.objectContaining({
          diagnostic: expect.objectContaining({ code: 'shape', slideNumber: 1, objectNumber: 1 })
        })
      )
    }
  )
  it.each([
    '<a:ln w="95250" cap="rnd"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>',
    '<a:ln w="95250" cmpd="dbl"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>',
    '<a:ln w="95250"><a:gradFill/></a:ln>',
    '<a:ln w="95250"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:headEnd type="triangle"/></a:ln>'
  ])('rejects unrepresented effective outlines', async (themeLineXml) => {
    const { presentation } = await themeStyleFixture('lnRef', { themeLineXml })
    expect(() => convertPresentationData(source, presentation, undefined, new Map(), 3)).toThrow(
      /theme line/
    )
  })
  it('lets local solid paint override inherited gradient paint without dropping inherited width', async () => {
    const { presentation } = await themeStyleFixture('lnRef', {
      themeLineXml: '<a:ln w="95250"><a:gradFill/></a:ln>',
      localLineXml: '<a:ln><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln>'
    })
    const document = convertPresentationData(source, presentation, undefined, new Map(), 3)
    expect(Object.values(document.slides[document.slideOrder[0]].elements)[0]).toMatchObject({
      strokeColor: '#123456',
      strokeWidth: 10
    })
  })
  it('keeps a zero style reference unpainted when only a local width is supplied', async () => {
    const { presentation } = await themeStyleFixture('lnRef', {
      index: '0',
      localLineXml: '<a:ln w="95250"/>'
    })
    const document = convertPresentationData(source, presentation, undefined, new Map(), 3)
    expect(Object.values(document.slides[document.slideOrder[0]].elements)[0]).toMatchObject({
      strokeWidth: 0
    })
  })
  it('preserves theme source bytes and writes a local stroke override after editing', async () => {
    const { presentation, bytes } = await themeStyleFixture('lnRef', { themeLineXml: solid })
    const document = convertPresentationData(
      source,
      presentation,
      await createPptxSource(bytes),
      new Map(),
      3
    )
    expect(new Uint8Array(await buildSourcePptx(document))).toEqual(new Uint8Array(bytes))
    const slide = document.slides[document.slideOrder[0]]
    const shape = slide.elements[slide.elementOrder[0]]
    if (shape.type !== 'shape') throw new Error('Expected shape')
    shape.strokeColor = '#123456'
    shape.strokeWidth = 4
    const output = await buildSourcePptx(document)
    const before = await JSZip.loadAsync(bytes),
      after = await JSZip.loadAsync(output)
    for (const [name, member] of Object.entries(before.files)) {
      if (member.dir || name === 'ppt/slides/slide1.xml') continue
      expect(await after.file(name)!.async('uint8array'), name).toEqual(
        await member.async('uint8array')
      )
    }
    const reopened = buildPresentation(await parseZip(output))
    materializeAllSlideNodes(reopened)
    const result = convertPresentationData(source, reopened, undefined, new Map(), 3)
    expect(Object.values(result.slides[result.slideOrder[0]].elements)[0]).toMatchObject({
      strokeColor: '#123456',
      strokeWidth: 4
    })
  })
})
