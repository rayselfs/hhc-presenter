import JSZip from 'jszip'
import type { PresentationData } from '@aiden0z/pptx-renderer'
import { validatePptxPackage } from './pptx-source'

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'

export async function readPptxNotes(
  buffer: ArrayBuffer,
  presentation: PresentationData
): Promise<ReadonlyMap<string, string>> {
  const entries = presentation.slides.flatMap((slide) => {
    const relationship = Array.from(slide.rels.values()).find((entry) =>
      entry.type.endsWith('/notesSlide')
    )
    return relationship ? [{ slide, relationship }] : []
  })
  const notes = new Map<string, string>()
  if (!entries.length) return notes
  await validatePptxPackage(buffer)
  const zip = await JSZip.loadAsync(buffer, { createFolders: false })
  for (const { slide, relationship } of entries) {
    if (relationship.targetMode === 'External')
      throw new Error('External PowerPoint notes are not supported')
    const target = new URL(relationship.target, `https://pptx.invalid/${slide.slidePath}`)
    const entry = zip.file(decodeURIComponent(target.pathname.slice(1)))
    if (!entry) throw new Error('PowerPoint notes are missing')
    const root = new DOMParser().parseFromString(await entry.async('string'), 'application/xml')
    if (root.documentElement.namespaceURI !== P_NS || root.documentElement.localName !== 'notes')
      throw new Error('Invalid PowerPoint notes')
    const paragraphs: string[] = []
    for (const shape of root.getElementsByTagNameNS(P_NS, 'sp')) {
      const placeholder = shape.getElementsByTagNameNS(P_NS, 'ph')[0]?.getAttribute('type')
      if (placeholder && placeholder !== 'body') continue
      for (const paragraph of shape.getElementsByTagNameNS(A_NS, 'p')) {
        paragraphs.push(
          Array.from(paragraph.children, (node) => {
            if (node.namespaceURI !== A_NS) return ''
            if (node.localName === 'br') return '\n'
            if (node.localName !== 'r' && node.localName !== 'fld') return ''
            return Array.from(
              node.getElementsByTagNameNS(A_NS, 't'),
              (text) => text.textContent ?? ''
            ).join('')
          }).join('')
        )
      }
    }
    notes.set(slide.slidePath, paragraphs.join('\n'))
  }
  return notes
}
