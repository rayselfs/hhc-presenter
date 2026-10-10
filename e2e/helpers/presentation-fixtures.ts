import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'

export async function pageDeck(count = 10): Promise<Buffer> {
  const zip = await JSZip.loadAsync(
    await readFile(resolve('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'))
  )
  const presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const slides = presentation.match(/<p:sldId\b[^>]*\/>/g)!.slice(0, count)
  zip.file(
    'ppt/presentation.xml',
    presentation.replace(
      /<p:sldIdLst>.*?<\/p:sldIdLst>/s,
      `<p:sldIdLst>${slides.join('')}</p:sldIdLst>`
    )
  )
  const relationships = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  for (let index = 0; index < slides.length; index++) {
    const id = slides[index].match(/r:id="([^"]+)"/)![1]
    const relationship = relationships
      .match(/<Relationship\b[^>]*\/>/g)!
      .find((entry) => entry.includes(`Id="${id}"`))!
    const target = relationship.match(/Target="([^"]+)"/)![1]
    const path = `ppt/${target}`
    const xml = await zip.file(path)!.async('string')
    zip.file(path, xml.replace(/<a:t>[^<]*<\/a:t>/g, `<a:t>Presenter page ${index + 1}</a:t>`))
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}
