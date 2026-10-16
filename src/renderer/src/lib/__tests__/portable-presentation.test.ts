import { beforeEach, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  clearEditablePresentationCache,
  createBlankEditablePresentationDocument,
  createTextElement,
  loadEditablePresentation
} from '../editable-presentation'

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  clearEditablePresentationCache()
  await resetFileExplorerDBForTests()
})

async function load(document: unknown): Promise<unknown> {
  const db = await openFileExplorerDB()
  await db.put('file-blobs', { id: 'portable-source', blob: new Blob([JSON.stringify(document)]) })
  return loadEditablePresentation({
    id: 'portable-item',
    name: 'Portable',
    url: 'blob:portable-source'
  })
}

it('migrates legacy decks to v1 without retaining another computer provenance', async () => {
  const document = createBlankEditablePresentationDocument('Portable')
  const legacy = {
    ...document,
    schemaVersion: undefined,
    sourceItemId: 'old-item',
    sourceBlobId: 'old-blob'
  }
  const loaded = await load(legacy)
  expect(loaded).toMatchObject({ schemaVersion: 1 })
  expect(loaded).not.toHaveProperty('sourceItemId', 'old-item')
  expect(loaded).not.toHaveProperty('sourceBlobId', 'old-blob')
})

it.each([{ schemaVersion: 2 }, { width: 0 }, { height: 100001 }, { slideOrder: ['missing'] }])(
  'rejects unsupported or inconsistent portable documents: %j',
  async (changes) => {
    const document = { ...createBlankEditablePresentationDocument('Portable'), ...changes }
    await expect(load(document)).rejects.toThrow()
    expect(await (await openFileExplorerDB()).get('file-blobs', 'portable-source')).toBeDefined()
  }
)

it.each([
  ['image/png', 'https://example.org/image.png'],
  ['image/png', 'blob:another-computer'],
  ['image/svg+xml', 'data:image/svg+xml;base64,PHN2Zy8+'],
  ['image/png', 'data:image/png;base64,AAA=']
])('rejects nonportable image content %s %s', async (mimeType, dataUrl) => {
  await expect(
    load({
      ...createBlankEditablePresentationDocument('Portable'),
      assets: { image: { id: 'image', name: 'Image', mimeType, dataUrl } }
    })
  ).rejects.toThrow()
})

it('round-trips embedded images, themes and notes with a new local document identity', async () => {
  const document = createBlankEditablePresentationDocument('Portable')
  document.slides[document.slideOrder[0]].notes = 'Speaker notes'
  document.assets.image = {
    id: 'image',
    name: 'Image',
    mimeType: 'image/png',
    dataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZaoAAAAASUVORK5CYII='
  }
  expect(await load(document)).toMatchObject({
    id: 'portable-item',
    schemaVersion: 1,
    assets: document.assets,
    themes: document.themes,
    slides: { [document.slideOrder[0]]: { notes: 'Speaker notes' } }
  })
})

it.each([
  { fontSize: -1 },
  { fontFamily: 'Arial; background:url(https://example.org)' },
  { color: 'url(https://example.org)' },
  { lineHeight: 0 }
])('rejects invalid portable text styles and retains the original bytes: %j', async (change) => {
  const document = createBlankEditablePresentationDocument('Styles')
  const slide = document.slides[document.slideOrder[0]]
  const element = { ...createTextElement({ text: 'Portable text' }), ...change }
  slide.elements[element.id] = element
  slide.elementOrder.push(element.id)
  await expect(load(document)).rejects.toThrow()
  expect(await (await openFileExplorerDB()).get('file-blobs', 'portable-source')).toBeDefined()
})

it('opens a native downloaded deck without an IndexedDB blob or the original PPTX', async () => {
  const source = await import('../presentation-source')
  const document = createBlankEditablePresentationDocument('Native portable')
  const bytes = await new Blob([JSON.stringify(document)]).arrayBuffer()
  const read = vi.spyOn(source, 'readPresentationArrayBuffer').mockResolvedValue(bytes)
  try {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'native-source',
      storage: 'native-fs',
      size: bytes.byteLength
    })
    const loaded = await loadEditablePresentation({
      id: 'local-native-item',
      name: 'Native portable',
      url: 'blob:native-source'
    })
    expect(loaded).toMatchObject({
      id: 'local-native-item',
      schemaVersion: 1,
      name: 'Native portable'
    })
    expect(read).toHaveBeenCalledOnce()
  } finally {
    read.mockRestore()
  }
})

it.each([
  { verticalAlign: 'sideways' },
  { textInsets: { top: -1, right: 0, bottom: 0, left: 0 } },
  { textInsets: { top: 0, right: '10px', bottom: 0, left: 0 } }
])('rejects malformed imported text layout %j', async (changes) => {
  const document = createBlankEditablePresentationDocument('Portable')
  const slide = document.slides[document.slideOrder[0]]
  const text = { ...createTextElement(), ...changes }
  slide.elements[text.id] = text as ReturnType<typeof createTextElement>
  slide.elementOrder.push(text.id)
  await expect(load(document)).rejects.toThrow('Invalid portable presentation document')
})

it.each([
  { type: 'image/svg+xml', size: 100 },
  { type: 'image/avif', size: 100 },
  { type: '', size: 100 },
  { type: 'image/png', size: 0 },
  { type: 'image/png', size: 20 * 1024 * 1024 + 1 }
])('rejects inadmissible image inputs before reading bytes: %j', async (file) => {
  const { assertPresentationImageFile } = await import('../portable-presentation')
  expect(() => assertPresentationImageFile(file)).toThrow()
})

it.each(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp'])(
  'accepts a supported %s input at the size boundary',
  async (type) => {
    const { assertPresentationImageFile } = await import('../portable-presentation')
    expect(() => assertPresentationImageFile({ type, size: 20 * 1024 * 1024 })).not.toThrow()
  }
)

it('does not create a catalog entry or draft for an unreadable converted document', async () => {
  const { createEditablePresentationItem } = await import('../editable-presentation')
  const { createPresentationDraft } = await import('../presentation-drafts')
  const document = createBlankEditablePresentationDocument('Invalid converted source')
  document.assets.image = {
    id: 'image',
    name: 'SVG',
    mimeType: 'image/svg+xml',
    dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+'
  }
  await expect(createEditablePresentationItem(document, 'file-root')).rejects.toThrow()
  await expect(
    createPresentationDraft(
      {
        id: 'raw',
        parentId: 'file-root',
        type: 'file',
        name: 'Raw.pptx',
        url: 'blob:raw',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 1,
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null
      },
      document
    )
  ).rejects.toThrow()
  const db = await openFileExplorerDB()
  expect(await db.getAll('folder-items')).toEqual([])
  expect(await db.getAll('file-blobs')).toEqual([])
  expect(await db.getAll('presentation-drafts')).toEqual([])
})
