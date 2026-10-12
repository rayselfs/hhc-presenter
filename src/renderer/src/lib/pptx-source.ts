import JSZip from 'jszip'
import { PERSONAL_MAX_FILE_BYTES } from '@shared/personal-cloud'
import type { EditablePresentationDocument, PptxSource } from './editable-presentation'
import { validatePortablePresentation } from './portable-presentation'

const ENTRY_LIMIT = 32 * 1024 * 1024
const TOTAL_LIMIT = 256 * 1024 * 1024
const MEDIA_LIMIT = 192 * 1024 * 1024
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPE_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const OFFICE_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

interface ZipMember {
  name: string
  size: number
  crc: number
}

function check(condition: unknown, message = 'Invalid PPTX source'): asserts condition {
  if (!condition) throw new Error(message)
}

function safePath(name: string): boolean {
  const parts = name.replace(/\/$/, '').split('/')
  return (
    name.length > 0 &&
    !/[\\:]/.test(name) &&
    Array.from(name).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    ) &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  )
}

function checkExtraFields(view: DataView, offset: number, length: number): void {
  const end = offset + length
  check(end <= view.byteLength)
  while (offset < end) {
    check(offset + 4 <= end && view.getUint16(offset, true) !== 1)
    offset += 4 + view.getUint16(offset + 2, true)
    check(offset <= end)
  }
}

// Validate names and sizes before JSZip can normalize names or expand payloads.
function readDirectory(buffer: ArrayBuffer): ZipMember[] {
  check(
    buffer.byteLength >= 22 && buffer.byteLength <= PERSONAL_MAX_FILE_BYTES,
    'PPTX ZIP size limit'
  )
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let end = buffer.byteLength - 22
  const minimum = Math.max(0, end - 65535)
  while (
    end >= minimum &&
    !(
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === buffer.byteLength
    )
  )
    end--
  check(end >= minimum)
  check(view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0)
  const count = view.getUint16(end + 10, true)
  check(count > 0 && count <= 4000, 'PPTX ZIP entry count limit')
  check(view.getUint16(end + 8, true) === count)
  const directorySize = view.getUint32(end + 12, true)
  const directoryOffset = view.getUint32(end + 16, true)
  check(directoryOffset + directorySize === end)
  const members: ZipMember[] = []
  const names = new Set<string>()
  const ranges: [number, number][] = []
  let total = 0
  let media = 0
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    check(offset + 46 <= end && view.getUint32(offset, true) === 0x02014b50)
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const crc = view.getUint32(offset + 16, true)
    const compressed = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameSize = view.getUint16(offset + 28, true)
    const extraSize = view.getUint16(offset + 30, true)
    const commentSize = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    check(
      (flags & 1) === 0 && (method === 0 || method === 8) && view.getUint16(offset + 34, true) === 0
    )
    check(size !== 0xffffffff && compressed !== 0xffffffff && localOffset !== 0xffffffff)
    check(offset + 46 + nameSize + extraSize + commentSize <= end)
    checkExtraFields(view, offset + 46 + nameSize, extraSize)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameSize)
    )
    check(safePath(name) && !names.has(name))
    names.add(name)
    check(!/(?:^|\/)vbaproject(?:\.|\/|$)/i.test(name))
    total += size
    if (name.startsWith('ppt/media/')) media += size
    check(
      size <= ENTRY_LIMIT && total <= TOTAL_LIMIT && media <= MEDIA_LIMIT,
      'PPTX ZIP expanded size limit'
    )
    check(localOffset + 30 <= directoryOffset && view.getUint32(localOffset, true) === 0x04034b50)
    const localNameSize = view.getUint16(localOffset + 26, true)
    const localExtraSize = view.getUint16(localOffset + 28, true)
    checkExtraFields(view, localOffset + 30 + localNameSize, localExtraSize)
    const dataStart = localOffset + 30 + localNameSize + localExtraSize
    check(dataStart + compressed <= directoryOffset)
    check(
      view.getUint16(localOffset + 6, true) === flags &&
        view.getUint16(localOffset + 8, true) === method
    )
    const localName = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize)
    )
    check(localName === name)
    if ((flags & 8) === 0) {
      check(
        view.getUint32(localOffset + 14, true) === crc &&
          view.getUint32(localOffset + 18, true) === compressed &&
          view.getUint32(localOffset + 22, true) === size
      )
    }
    ranges.push([localOffset, dataStart + compressed])
    members.push({ name, size, crc })
    offset += 46 + nameSize + extraSize + commentSize
  }
  check(offset === end)
  ranges.sort((a, b) => a[0] - b[0])
  for (let index = 1; index < ranges.length; index++)
    check(ranges[index][0] >= ranges[index - 1][1])
  return members
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})

function readMember(entry: JSZip.JSZipObject, member: ZipMember): Promise<Uint8Array> {
  // JSZip exposes this browser streaming API but omits it from JSZipObject's declarations.
  const stream = (
    entry as JSZip.JSZipObject & {
      internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>
    }
  ).internalStream('uint8array')
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let crc = 0xffffffff
    let failed = false
    stream.on('data', (chunk) => {
      if (failed) return
      size += chunk.byteLength
      if (size > member.size || size > ENTRY_LIMIT) {
        failed = true
        stream.pause()
        reject(new Error('PPTX ZIP expanded size limit'))
        return
      }
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
      chunks.push(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => {
      if (failed) return
      if (size !== member.size || (crc ^ 0xffffffff) >>> 0 !== member.crc) {
        reject(new Error('Invalid PPTX source CRC or expanded size'))
        return
      }
      const result = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
      }
      resolve(result)
    })
    stream.resume()
  })
}

function parseXml(bytes: Uint8Array): Document {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  check(!/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
  const xml = new DOMParser().parseFromString(text, 'application/xml')
  check(xml.getElementsByTagName('parsererror').length === 0 && xml.documentElement)
  const pending: [Element, number][] = [[xml.documentElement, 1]]
  while (pending.length) {
    const next = pending.pop()
    if (!next) break
    const [element, depth] = next
    check(depth <= 128, 'PPTX XML depth limit')
    for (const child of element.children) pending.push([child, depth + 1])
  }
  return xml
}

function internalTarget(part: string, target: string): string {
  check(
    target.length > 0 &&
      !/[\\]/.test(target) &&
      Array.from(target).every((character) => character.charCodeAt(0) >= 32)
  )
  const root = 'https://pptx.invalid/'
  const url = new URL(target, root + part)
  check(url.origin === 'https://pptx.invalid' && !url.search)
  const path = decodeURIComponent(url.pathname.slice(1))
  check(safePath(path))
  return path
}

async function inspectPackage(buffer: ArrayBuffer): Promise<Map<string, Map<string, string>>> {
  const members = readDirectory(buffer)
  const names = new Set(members.map((member) => member.name))
  const zip = await JSZip.loadAsync(buffer, { createFolders: false })
  const xmlParts = new Map<string, Document>()
  // Sequential reads keep peak decompression below the existing concurrency limit of eight.
  for (const member of members) {
    if (member.name.endsWith('/')) {
      check(member.size === 0)
      continue
    }
    const entry = zip.file(member.name)
    check(entry && entry.unsafeOriginalName === member.name)
    const bytes = await readMember(entry, member)
    if (/\.(?:xml|rels)$/i.test(member.name)) xmlParts.set(member.name, parseXml(bytes))
  }
  const types = xmlParts.get('[Content_Types].xml')
  check(
    types?.documentElement.namespaceURI === CONTENT_TYPE_NS &&
      types.documentElement.localName === 'Types'
  )
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const element of types.documentElement.children) {
    check(element.namespaceURI === CONTENT_TYPE_NS)
    const type = element.getAttribute('ContentType') ?? ''
    check(type && !/macroenabled|vba/i.test(type))
    if (element.localName === 'Default') {
      const extension = element.getAttribute('Extension') ?? ''
      check(extension && !defaults.has(extension))
      defaults.set(extension, type)
    } else {
      check(element.localName === 'Override')
      const name = element.getAttribute('PartName') ?? ''
      check(name.startsWith('/') && names.has(name.slice(1)) && !overrides.has(name.slice(1)))
      overrides.set(name.slice(1), type)
    }
  }
  for (const name of names) {
    if (name === '[Content_Types].xml' || name.endsWith('/')) continue
    check(overrides.has(name) || defaults.has(name.split('.').at(-1) ?? ''))
  }
  let presentationPart: string | undefined
  for (const [name, xml] of xmlParts) {
    if (!name.endsWith('.rels')) continue
    check(
      xml.documentElement.namespaceURI === RELATIONSHIP_NS &&
        xml.documentElement.localName === 'Relationships'
    )
    const owner =
      name === '_rels/.rels' ? '' : name.replace(/(^|\/)_rels\//, '$1').replace(/\.rels$/, '')
    check(name === '_rels/.rels' || (owner !== name && names.has(owner)))
    const ids = new Set<string>()
    for (const rel of xml.documentElement.children) {
      check(rel.namespaceURI === RELATIONSHIP_NS && rel.localName === 'Relationship')
      const id = rel.getAttribute('Id') ?? ''
      const type = rel.getAttribute('Type') ?? ''
      const target = rel.getAttribute('Target') ?? ''
      check(id && !ids.has(id) && type && target)
      ids.add(id)
      const mode = rel.getAttribute('TargetMode')
      if (mode === 'External') continue
      check(mode === null || mode === 'Internal')
      const resolved = internalTarget(owner, target)
      check(names.has(resolved))
      if (name === '_rels/.rels' && type === OFFICE_RELATIONSHIP) {
        check(presentationPart === undefined)
        presentationPart = resolved
      }
    }
  }
  check(presentationPart)
  const presentation = xmlParts.get(presentationPart)
  check(
    presentation?.documentElement.namespaceURI === PRESENTATION_NS &&
      presentation.documentElement.localName === 'presentation'
  )
  check(
    overrides.get(presentationPart) ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
  )
  const nodes = new Map<string, Map<string, string>>()
  for (const [name, xml] of xmlParts) {
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(name)) continue
    check(
      xml.documentElement.namespaceURI === PRESENTATION_NS &&
        xml.documentElement.localName === 'sld'
    )
    const ids = new Set<string>()
    for (const element of xml.getElementsByTagNameNS(PRESENTATION_NS, 'cNvPr')) {
      const id = element.getAttribute('id') ?? ''
      check(id && !ids.has(id))
      ids.add(id)
    }
    const slideNodes = new Map<string, string>()
    for (const kind of ['sp', 'pic']) {
      for (const element of xml.getElementsByTagNameNS(PRESENTATION_NS, kind)) {
        const id = element.getElementsByTagNameNS(PRESENTATION_NS, 'cNvPr')[0]?.getAttribute('id')
        check(id)
        slideNodes.set(id, kind)
      }
    }
    nodes.set(name, slideNodes)
  }
  return nodes
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
  }
  return btoa(binary)
}

async function digest(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function validatePptxPackage(buffer: ArrayBuffer): Promise<void> {
  await inspectPackage(buffer)
}

export async function createPptxSource(buffer: ArrayBuffer): Promise<PptxSource> {
  await inspectPackage(buffer)
  return { version: 1, base64: encodeBase64(new Uint8Array(buffer)), sha256: await digest(buffer) }
}

export async function validatePptxSource(document: EditablePresentationDocument): Promise<void> {
  validatePortablePresentation(document)
  const source = document.pptxSource
  if (!source) return
  const binary = atob(source.base64)
  check(binary.length <= PERSONAL_MAX_FILE_BYTES, 'PPTX ZIP size limit')
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  check(encodeBase64(bytes) === source.base64 && (await digest(bytes.buffer)) === source.sha256)
  const nodes = await inspectPackage(bytes.buffer)
  const claimed = new Set<string>()
  for (const slide of Object.values(document.slides)) {
    if (slide.pptxSourcePart !== undefined) check(nodes.has(slide.pptxSourcePart))
    for (const element of Object.values(slide.elements)) {
      const reference = element.pptxSourceNode
      if (!reference) continue
      const kind = nodes.get(slide.pptxSourcePart ?? '')?.get(reference.id)
      check(kind === (reference.role === 'image' ? 'pic' : 'sp'))
      const key = JSON.stringify([slide.pptxSourcePart, reference.id, reference.role])
      check(!claimed.has(key))
      claimed.add(key)
    }
  }
}
