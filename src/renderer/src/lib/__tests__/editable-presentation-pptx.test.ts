import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { validatePortablePresentation } from '../portable-presentation'
import { buildPresentation, materializeAllSlideNodes, parseZip } from '@aiden0z/pptx-renderer'
import {
  convertPresentationData,
  generateEditablePresentationThumbnail
} from '../editable-presentation'
import type { PresentationData } from '@aiden0z/pptx-renderer'
import type { FileItemRecord } from '@shared/types/folder'

async function parseFixture(
  background = '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>',
  shapeProperties = '',
  image?: { extension: string; bytes: Uint8Array }
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
  const presentation = buildPresentation(
    await parseZip(await zip.generateAsync({ type: 'arraybuffer' }))
  )
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
