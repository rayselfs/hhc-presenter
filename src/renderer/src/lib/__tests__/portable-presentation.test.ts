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
