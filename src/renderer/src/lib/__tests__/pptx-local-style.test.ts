import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { buildPresentation, parseZip, materializeAllSlideNodes } from '@aiden0z/pptx-renderer'
import {
  convertPresentationData,
  type EditablePresentationDocument,
  type EditablePresentationElement
} from '../editable-presentation'
import {
  assertEditablePptxPackage,
  assertEditablePptxFeatures,
  assertEditablePptxDocument
} from '../pptx-compatibility'
import { validatePortablePresentation } from '../portable-presentation'
import type { FileItemRecord } from '@shared/types/folder'

const source = {
  id: 'review',
  url: 'blob:review',
  name: 'review.pptx',
  type: 'file',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
} as FileItemRecord
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
async function convert(
  edit?: (xml: XMLDocument, zip: JSZip) => void | Promise<void>
): Promise<EditablePresentationDocument> {
  const zip = await JSZip.loadAsync(
    readFileSync('src/renderer/src/lib/__fixtures__/pptx/theme-solid-fill.pptx')
  )
  const path = 'ppt/slides/slide1.xml'
  const xml = new DOMParser().parseFromString(
    await zip.file(path)!.async('string'),
    'application/xml'
  )
  await edit?.(xml, zip)
  zip.file(path, new XMLSerializer().serializeToString(xml))
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  await assertEditablePptxPackage(bytes)
  const files = await parseZip(bytes)
  const presentation = buildPresentation(files)
  assertEditablePptxFeatures(files, presentation)
  materializeAllSlideNodes(presentation)
  const result = convertPresentationData(source, presentation)
  assertEditablePptxDocument(result, presentation)
  validatePortablePresentation(result)
  return result
}
const first = (doc: EditablePresentationDocument): EditablePresentationElement =>
  doc.slides[doc.slideOrder[0]].elements[doc.slides[doc.slideOrder[0]].elementOrder[0]]
it('equivalent local tint and theme tint must yield the same color', async () => {
  expect(first(await convert())).toMatchObject({ fillColor: '#FFBCBC' })
  const local = first(
    await convert((xml) => {
      const properties = xml.getElementsByTagNameNS(P, 'spPr')[0]
      const fill = new DOMParser().parseFromString(
        `<a:solidFill xmlns:a="${A}"><a:srgbClr val="FF0000"><a:tint val="50000"/></a:srgbClr></a:solidFill>`,
        'application/xml'
      ).documentElement
      properties.appendChild(xml.importNode(fill, true))
    })
  )
  expect(local).toMatchObject({ fillColor: '#FFBCBC' })
})
it('ordinary v1 import must not silently discard an explicit dashed outline without style reference', async () => {
  await expect(
    convert((xml) => {
      xml.getElementsByTagNameNS(P, 'style')[0]?.remove()
      const line = xml.getElementsByTagNameNS(A, 'ln')[0]
      line.getElementsByTagNameNS(A, 'prstDash')[0].setAttribute('val', 'dash')
    })
  ).rejects.toThrow(expect.objectContaining({ name: 'PptxCompatibilityError' }))
})
it('ordinary v1 import must not silently discard an explicit arrowhead without style reference', async () => {
  await expect(
    convert((xml) => {
      xml.getElementsByTagNameNS(P, 'style')[0]?.remove()
      const line = xml.getElementsByTagNameNS(A, 'ln')[0]
      xml.getElementsByTagNameNS(A, 'prstGeom')[0].setAttribute('prst', 'line')
      const end = xml.createElementNS(A, 'a:tailEnd')
      end.setAttribute('type', 'triangle')
      line.appendChild(end)
    })
  ).rejects.toThrow(expect.objectContaining({ name: 'PptxCompatibilityError' }))
})

it('positive control: current inherited theme tint remains correct', async () => {
  expect(first(await convert())).toMatchObject({ fillColor: '#FFBCBC', strokeWidth: 2 })
})
it('positive control: solid local outline without theme is accepted', async () => {
  expect(
    first(await convert((xml) => xml.getElementsByTagNameNS(P, 'style')[0]?.remove()))
  ).toMatchObject({ strokeColor: '#000000', strokeWidth: 2 })
})

it.each([false, true])(
  'preserves an inherited line width or noFill when no local line exists: %s',
  async (invisible) => {
    const document = await convert(async (xml, zip) => {
      xml.getElementsByTagNameNS(A, 'prstGeom')[0].setAttribute('prst', 'line')
      xml.getElementsByTagNameNS(A, 'ln')[0].remove()
      xml.getElementsByTagNameNS(A, 'lnRef')[0].setAttribute('idx', '1')
      const path = 'ppt/theme/theme1.xml'
      const theme = new DOMParser().parseFromString(
        await zip.file(path)!.async('string'),
        'application/xml'
      )
      const line = theme.getElementsByTagNameNS(A, 'lnStyleLst')[0].firstElementChild!
      line.setAttribute('w', '38100')
      line.replaceChildren(
        theme.importNode(
          new DOMParser().parseFromString(
            `<a:solidFill xmlns:a="${A}"><a:srgbClr val="000000"/></a:solidFill>`,
            'application/xml'
          ).documentElement,
          true
        )
      )
      if (invisible) line.replaceChildren(theme.createElementNS(A, 'a:noFill'))
      zip.file(path, new XMLSerializer().serializeToString(theme))
    })
    expect(first(document)).toMatchObject({ type: 'line', strokeWidth: invisible ? 0 : 4 })
  }
)
