import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import {
  createBlankEditablePresentationDocument,
  createTextElement,
  createShapeElement
} from '../editable-presentation'
import type { EditablePresentationDocument, PptxSource } from '../editable-presentation'
import { createPptxSource, validatePptxSource } from '../pptx-source'
import { validatePortablePresentation } from '../portable-presentation'

const pns = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const rns = 'http://schemas.openxmlformats.org/package/2006/relationships'
const cns = 'http://schemas.openxmlformats.org/package/2006/content-types'
const part = 'ppt/slides/slide1.xml'
const slide = `<p:sld xmlns:p="${pns}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2"/></p:nvSpPr></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3"/></p:nvPicPr></p:pic></p:spTree></p:cSld></p:sld>`

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => vi.unstubAllGlobals())

async function packageBytes(changes: Record<string, string | null> = {}): Promise<ArrayBuffer> {
  const zip = new JSZip()
  const parts: Record<string, string | null> = {
    '[Content_Types].xml': `<Types xmlns="${cns}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${rns}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="${pns}"/>`,
    [part]: slide,
    ...changes
  }
  for (const [name, body] of Object.entries(parts)) {
    if (body !== null) zip.file(name, body, { createFolders: false, date: new Date('1980-01-01') })
  }
  return zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
}

function source(buffer: ArrayBuffer): PptxSource {
  return {
    version: 1 as const,
    base64: Buffer.from(buffer).toString('base64'),
    sha256: createHash('sha256').update(Buffer.from(buffer)).digest('hex')
  }
}

function document(buffer: ArrayBuffer): EditablePresentationDocument & { pptxSource: PptxSource } {
  const deck = {
    ...createBlankEditablePresentationDocument('Source'),
    schemaVersion: 2 as const,
    pptxSource: source(buffer)
  }
  const current = deck.slides[deck.slideOrder[0]]
  current.pptxSourcePart = part
  const element = createTextElement({ x: 0, y: 0, width: 100, height: 100 })
  element.pptxSourceNode = { id: '2', role: 'text' }
  current.elements[element.id] = element
  current.elementOrder.push(element.id)
  return deck
}

function directoryOffsets(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer)
  const offsets: number[] = []
  for (let offset = 0; offset <= buffer.byteLength - 46; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) offsets.push(offset)
  }
  return offsets
}

describe('bounded original PPTX source', () => {
  it('retains exact source bytes and digest for the original hymn', async () => {
    const hymn = await readFile(
      'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
    )
    const buffer = Uint8Array.from(hymn).buffer
    const retained = await createPptxSource(buffer)
    expect(retained).toEqual(source(buffer))
    expect(Buffer.from(retained.base64, 'base64')).toEqual(hymn)
  })

  it('accepts v2 without source and rejects dangling references', async () => {
    const deck = { ...createBlankEditablePresentationDocument('Native'), schemaVersion: 2 as const }
    await expect(validatePptxSource(deck)).resolves.toBeUndefined()
    deck.slides[deck.slideOrder[0]].pptxSourcePart = part
    await expect(validatePptxSource(deck)).rejects.toThrow()
  })

  it('validates actual source-node identity without fetching external relationships', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const buffer = await packageBytes({
      'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${rns}"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/" TargetMode="External"/></Relationships>`
    })
    const deck = document(buffer)
    expect(() => validatePortablePresentation(deck)).not.toThrow()
    await expect(validatePptxSource(deck)).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    const current = deck.slides[deck.slideOrder[0]]
    const geometry = {
      ...createShapeElement('rectangle'),
      id: 'geometry',
      pptxSourceNode: { id: '2', role: 'geometry' as const }
    }
    current.elements.geometry = geometry
    current.elementOrder.push('geometry')
    await expect(validatePptxSource(deck)).resolves.toBeUndefined()
    geometry.pptxSourceNode = { id: '3', role: 'geometry' }
    await expect(validatePptxSource(deck)).rejects.toThrow()
  })

  it('rejects missing source parts, node IDs and duplicate role claims', async () => {
    for (const mutation of ['part', 'node', 'duplicate']) {
      const deck = document(await packageBytes())
      const current = deck.slides[deck.slideOrder[0]]
      if (mutation === 'part') current.pptxSourcePart = 'ppt/slides/missing.xml'
      if (mutation === 'node')
        current.elements[current.elementOrder[0]].pptxSourceNode = { id: 'missing', role: 'text' }
      if (mutation === 'duplicate') {
        current.elements.copy = { ...current.elements[current.elementOrder[0]], id: 'copy' }
        current.elementOrder.push('copy')
      }
      await expect(validatePptxSource(deck)).rejects.toThrow()
    }
  })

  it.each(['digest', 'uppercase', 'newline', 'padding', 'source-version'])(
    'rejects forged or noncanonical source: %s',
    async (mutation) => {
      const deck = document(await packageBytes())
      if (mutation === 'digest') deck.pptxSource.sha256 = '0'.repeat(64)
      if (mutation === 'uppercase') deck.pptxSource.sha256 = deck.pptxSource.sha256.toUpperCase()
      if (mutation === 'newline') deck.pptxSource.base64 += '\n'
      if (mutation === 'padding') deck.pptxSource.base64 += '='
      if (mutation === 'source-version') Object.assign(deck.pptxSource, { version: 2 })
      await expect(validatePptxSource(deck)).rejects.toThrow()
    }
  )

  it.each([
    '../evil.xml',
    '/evil.xml',
    'C:/evil.xml',
    'ppt/./evil.xml',
    'ppt/../evil.xml',
    'ppt\\evil.xml'
  ])('rejects unsafe archive path %s', async (name) => {
    await expect(createPptxSource(await packageBytes({ [name]: '<root/>' }))).rejects.toThrow()
  })

  it('rejects duplicate archive names before a ZIP library overwrites them', async () => {
    const buffer = await packageBytes({ 'a.xml': '<a/>', 'b.xml': '<b/>' })
    const bytes = new Uint8Array(buffer)
    const pattern = new TextEncoder().encode('b.xml')
    for (let offset = 0; offset < bytes.length - pattern.length; offset++) {
      if (pattern.every((byte, index) => bytes[offset + index] === byte))
        bytes[offset] = 'a'.charCodeAt(0)
    }
    await expect(createPptxSource(buffer)).rejects.toThrow()
  })

  it.each(['entry', 'total', 'media', 'count'])(
    'enforces ZIP metadata bound: %s',
    async (bound) => {
      const extras = Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `${bound === 'total' ? 'extra' : 'ppt/media'}/m${i}.bin`,
          'x'
        ])
      )
      const buffer = await packageBytes(extras)
      const view = new DataView(buffer)
      const offsets = directoryOffsets(buffer)
      if (bound === 'entry') view.setUint32(offsets[0] + 24, 33554433, true)
      if (bound === 'total' || bound === 'media') {
        for (const offset of offsets.slice(-(bound === 'total' ? 9 : 7))) {
          view.setUint32(offset + 24, 33554432, true)
          view.setUint32(view.getUint32(offset + 42, true) + 22, 33554432, true)
        }
      }
      if (bound === 'count') {
        const end = buffer.byteLength - 22
        view.setUint16(end + 8, 4001, true)
        view.setUint16(end + 10, 4001, true)
      }
      await expect(createPptxSource(buffer)).rejects.toThrow(/limit/)
    }
  )

  it.each(['encrypted', 'crc', 'expanded-size', 'local-name', 'truncated', 'zip64'])(
    'rejects corrupt ZIP metadata or bytes: %s',
    async (mutation) => {
      let buffer = await packageBytes()
      const view = new DataView(buffer)
      const [offset] = directoryOffsets(buffer)
      if (mutation === 'encrypted') view.setUint16(offset + 8, 1, true)
      if (mutation === 'crc') {
        view.setUint32(offset + 16, 0, true)
        view.setUint32(view.getUint32(offset + 42, true) + 14, 0, true)
      }
      if (mutation === 'expanded-size') view.setUint32(offset + 24, 1, true)
      if (mutation === 'local-name') new Uint8Array(buffer)[30] ^= 1
      if (mutation === 'truncated') buffer = buffer.slice(0, buffer.byteLength - 10)
      if (mutation === 'zip64') view.setUint32(offset + 24, 0xffffffff, true)
      await expect(createPptxSource(buffer)).rejects.toThrow()
    }
  )

  it.each(['deep', 'doctype', 'entity', 'malformed', 'macro', 'root', 'content-types', 'rels'])(
    'rejects unsafe XML/OPC input: %s',
    async (mutation) => {
      const changes: Record<string, string | null> = {}
      if (mutation === 'deep') changes[part] = '<x>'.repeat(129) + '</x>'.repeat(129)
      if (mutation === 'doctype')
        changes[part] = '<!DOCTYPE p:sld SYSTEM "https://example.test/x">' + slide
      if (mutation === 'entity') changes[part] = '<!DOCTYPE p:sld [<!ENTITY x "expanded">]>' + slide
      if (mutation === 'malformed') changes[part] = '<broken>'
      if (mutation === 'macro') changes['ppt/vbaProject.bin'] = 'macro'
      if (mutation === 'root') changes['ppt/presentation.xml'] = '<wrong/>'
      if (mutation === 'content-types') changes['[Content_Types].xml'] = null
      if (mutation === 'rels')
        changes['_rels/.rels'] =
          `<Relationships xmlns="${rns}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="missing.xml"/></Relationships>`
      await expect(createPptxSource(await packageBytes(changes))).rejects.toThrow()
    }
  )
})

it('rejects an element claiming a source role of another element kind', async () => {
  const deck = document(await packageBytes())
  const current = deck.slides[deck.slideOrder[0]]
  current.elements[current.elementOrder[0]].pptxSourceNode = { id: '3', role: 'image' }
  expect(() => validatePortablePresentation(deck)).toThrow()
})

it('rejects ZIP64 extra fields even without sentinel sizes', async () => {
  const original = await packageBytes()
  const [offset] = directoryOffsets(original)
  const originalView = new DataView(original)
  const insertion = offset + 46 + originalView.getUint16(offset + 28, true)
  const bytes = new Uint8Array(original.byteLength + 4)
  bytes.set(new Uint8Array(original).subarray(0, insertion))
  bytes.set([1, 0, 0, 0], insertion)
  bytes.set(new Uint8Array(original).subarray(insertion), insertion + 4)
  const view = new DataView(bytes.buffer)
  view.setUint16(offset + 30, 4, true)
  view.setUint32(
    bytes.byteLength - 22 + 12,
    originalView.getUint32(original.byteLength - 22 + 12, true) + 4,
    true
  )
  await expect(createPptxSource(bytes.buffer)).rejects.toThrow()
})

it('bounds actual DEFLATE output when declared expanded size is forged', async () => {
  const buffer = await packageBytes({ 'ppt/media/test.bin': 'x'.repeat(8192) })
  const zip = await JSZip.loadAsync(buffer)
  const deflated = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
  const offsets = directoryOffsets(deflated)
  const offset = offsets[offsets.length - 1]
  const view = new DataView(deflated)
  view.setUint32(offset + 24, 1, true)
  view.setUint32(view.getUint32(offset + 42, true) + 22, 1, true)
  await expect(createPptxSource(deflated)).rejects.toThrow(/expanded size/)
})

it('accepts and rejects the shared portable source corpus', async () => {
  const cases = JSON.parse(
    await readFile('src/renderer/src/lib/__fixtures__/pptx-source/contract.json', 'utf8')
  ) as { name: string; valid: boolean; document: Parameters<typeof validatePptxSource>[0] }[]
  for (const entry of cases) {
    if (entry.valid)
      await expect(validatePptxSource(entry.document), entry.name).resolves.toBeUndefined()
    else await expect(validatePptxSource(entry.document), entry.name).rejects.toThrow()
  }
})

it('checks version 3 geometry through the asynchronous source boundary without mutation', async () => {
  const cases = JSON.parse(
    await readFile('src/renderer/src/lib/__fixtures__/preset-geometry/contract.json', 'utf8')
  ) as { name: string; valid: boolean; document: Parameters<typeof validatePptxSource>[0] }[]
  for (const entry of cases) {
    const original = JSON.stringify(entry.document)
    if (entry.valid)
      await expect(validatePptxSource(entry.document), entry.name).resolves.toBeUndefined()
    else await expect(validatePptxSource(entry.document), entry.name).rejects.toThrow()
    expect(JSON.stringify(entry.document), entry.name).toBe(original)
  }
})
