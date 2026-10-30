import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import type { FileItemRecord } from '@shared/types/folder'
import {
  addElementToSlide,
  createShapeElement,
  loadEditablePresentation,
  clearEditablePresentationCache,
  createBlankEditablePresentationDocument
} from '../editable-presentation'
import {
  openFileExplorerDB,
  resetFileExplorerDBForTests,
  type FileBlobRecord
} from '../file-explorer-db'
import { getDerivedAsset, resetMediaWorkDBForTests } from '../media-work-db'
import {
  persistEditablePresentationRevision,
  refreshEditablePresentationThumbnail,
  type EditablePresentationRevisionWrite
} from '../editable-presentation-persistence'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '../presentation-media'

const item: FileItemRecord = {
  id: 'deck-1',
  parentId: 'file-root',
  type: 'file',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null,
  name: 'Original',
  url: 'blob:deck-source',
  size: 1,
  mimeType: EDITABLE_PRESENTATION_MIME_TYPE
}
const initialDocument = createBlankEditablePresentationDocument(
  'Original',
  '00000000-0000-4000-8000-000000000004'
)

function createWrite(
  overrides: Partial<EditablePresentationRevisionWrite> = {}
): EditablePresentationRevisionWrite {
  return {
    itemId: item.id,
    sourceBlobId: 'deck-source',
    revision: 4,
    document: { ...initialDocument, name: 'Renamed' },
    catalogName: 'Renamed',
    ...overrides
  }
}

async function readBlobText(blob: Blob | undefined): Promise<string> {
  if (!blob) throw new Error('Expected a source blob')
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

async function seedAuthority(
  source: FileBlobRecord = {
    id: 'deck-source',
    blob: new Blob([JSON.stringify(initialDocument)], {
      type: EDITABLE_PRESENTATION_MIME_TYPE
    }),
    size: 1,
    refCount: 1,
    revision: 1
  }
): Promise<void> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(['file-blobs', 'folder-items'], 'readwrite')
  await Promise.all([
    tx.objectStore('file-blobs').put(source),
    tx.objectStore('folder-items').put(item)
  ])
  await tx.done
}

beforeEach(async () => {
  clearEditablePresentationCache()
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('persistEditablePresentationRevision', () => {
  it('commits the source blob and catalog rename in one revision', async () => {
    await seedAuthority()

    const result = await persistEditablePresentationRevision(createWrite())

    const db = await openFileExplorerDB()
    const source = await db.get('file-blobs', 'deck-source')
    const catalog = await db.get('folder-items', item.id)
    const mirror = await getDerivedAsset(
      'deck-source',
      'editable-presentation-document',
      `document:${item.id}`
    )
    expect(result).toEqual({ revision: 4, mirrorWarnings: [] })
    expect(source).toMatchObject({ revision: 4, refCount: 1 })
    expect(JSON.parse(await readBlobText(source?.blob))).toMatchObject({ name: 'Renamed' })
    expect(catalog).toMatchObject({ name: 'Renamed', size: source?.blob?.size })
    expect(mirror).toBeUndefined()
  })

  it('rejects an equal revision without changing the source or catalog', async () => {
    await seedAuthority({
      id: 'deck-source',
      blob: new Blob([JSON.stringify(initialDocument)], {
        type: EDITABLE_PRESENTATION_MIME_TYPE
      }),
      size: 1,
      refCount: 1,
      revision: 4
    })

    await expect(persistEditablePresentationRevision(createWrite())).rejects.toThrow(
      'Presentation revision 4 is not newer than persisted revision 4'
    )

    const db = await openFileExplorerDB()
    const source = await db.get('file-blobs', 'deck-source')
    await expect(readBlobText(source?.blob)).resolves.toContain('"name":"Original"')
    expect(source).toMatchObject({ revision: 4, size: 1 })
    await expect(db.get('folder-items', item.id)).resolves.toMatchObject({
      name: 'Original',
      size: 1
    })
  })

  it('does not update the catalog when the source authority is missing', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-items', item)

    await expect(persistEditablePresentationRevision(createWrite())).rejects.toThrow(
      'Editable presentation source is missing'
    )

    await expect(db.get('folder-items', item.id)).resolves.toEqual(item)
    await expect(db.get('file-blobs', 'deck-source')).resolves.toBeUndefined()
  })

  it('does not update the source when the catalog authority is missing', async () => {
    const originalSource: FileBlobRecord = {
      id: 'deck-source',
      blob: new Blob([JSON.stringify(initialDocument)], {
        type: EDITABLE_PRESENTATION_MIME_TYPE
      }),
      size: 1,
      refCount: 1,
      revision: 1
    }
    const db = await openFileExplorerDB()
    await db.put('file-blobs', originalSource)

    await expect(persistEditablePresentationRevision(createWrite())).rejects.toThrow(
      'Editable presentation catalog item is missing'
    )

    const unchanged = await db.get('file-blobs', 'deck-source')
    expect(unchanged).toMatchObject({ revision: 1, size: 1 })
    expect(JSON.parse(await readBlobText(unchanged?.blob))).toMatchObject({ name: 'Original' })
  })

  it('does not create a duplicate derived document after authority commits', async () => {
    await seedAuthority()

    const result = await persistEditablePresentationRevision(createWrite())

    const db = await openFileExplorerDB()
    await expect(db.get('file-blobs', 'deck-source')).resolves.toMatchObject({ revision: 4 })
    await expect(db.get('folder-items', item.id)).resolves.toMatchObject({ name: 'Renamed' })
    await expect(
      getDerivedAsset('deck-source', 'editable-presentation-document', `document:${item.id}`)
    ).resolves.toBeUndefined()
    expect(result).toEqual({ revision: 4, mirrorWarnings: [] })
  })
})

describe('refreshEditablePresentationThumbnail', () => {
  it('persists the generated cover independently from the document revision', async () => {
    await refreshEditablePresentationThumbnail(initialDocument)

    const cover = await getDerivedAsset(initialDocument.id, 'cover-thumbnail')
    expect(cover).toMatchObject({
      sourceBlobId: initialDocument.id,
      status: 'ready',
      mimeType: 'image/svg+xml'
    })
  })

  it('saves and notifies using the catalog source blob identity', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-items', { ...item, id: initialDocument.id, url: 'blob:independent-body' })
    const listener = vi.fn()
    window.addEventListener('hhc:thumbnail-ready', listener)
    try {
      await refreshEditablePresentationThumbnail(initialDocument)
      expect(await getDerivedAsset('independent-body', 'cover-thumbnail')).toMatchObject({
        status: 'ready'
      })
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
        itemId: initialDocument.id,
        sourceBlobId: 'independent-body'
      })
    } finally {
      window.removeEventListener('hhc:thumbnail-ready', listener)
    }
  })

  it('publishes the refreshed cover to mounted file views', async () => {
    const listener = vi.fn()
    window.addEventListener('hhc:thumbnail-ready', listener)

    await refreshEditablePresentationThumbnail(initialDocument)

    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      itemId: initialDocument.id,
      sourceBlobId: initialDocument.id
    })
    window.removeEventListener('hhc:thumbnail-ready', listener)
  })
})

it('rejects unreadable personal revisions and saves valid bytes without overwriting uploads', async () => {
  await seedAuthority()
  const db = await openFileExplorerDB()
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    collectionId: 'cloud',
    rootId: item.parentId,
    collectionRevision: 1,
    sequence: 0
  })
  await db.put('personal-sync-nodes', {
    id: item.id,
    ownerId: 'alice',
    remoteId: 'remote-deck',
    kind: 'file',
    localRevision: 1,
    syncedLocalRevision: 1,
    remoteRevision: 1
  })

  await expect(
    persistEditablePresentationRevision(
      createWrite({
        document: {
          ...initialDocument,
          assets: {
            image: {
              id: 'image',
              name: 'SVG',
              mimeType: 'image/svg+xml',
              dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+'
            }
          }
        }
      })
    )
  ).rejects.toThrow()
  expect(await db.get('folder-items', item.id)).toEqual(item)
  expect(await db.getAll('personal-sync-outbox')).toEqual([])
  expect(await db.getAllKeys('file-blobs')).toEqual(['deck-source'])
  expect((await db.get('personal-sync-nodes', item.id))?.localRevision).toBe(1)
  expect(await readBlobText((await db.get('file-blobs', 'deck-source'))?.blob)).toBe(
    JSON.stringify(initialDocument)
  )
  await persistEditablePresentationRevision(createWrite())
  const firstCatalog = await db.get('folder-items', item.id)
  const firstOperations = await db.getAll('personal-sync-outbox')
  expect(firstCatalog).toMatchObject({ name: 'Renamed' })
  expect(firstCatalog && 'url' in firstCatalog && firstCatalog.url).not.toBe(item.url)
  expect(firstOperations).toHaveLength(2)
  const replace = firstOperations.find((operation) => operation.mutation.type === 'replace-content')
  expect(replace).toMatchObject({ fileName: 'Renamed.lpdeck' })
  const firstSnapshot = await db.get('file-blobs', replace?.snapshotBlobId ?? '')
  expect(JSON.parse(await readBlobText(firstSnapshot?.blob))).toMatchObject({ name: 'Renamed' })
  expect(firstOperations.find((operation) => operation.mutation.type === 'rename')).toMatchObject({
    dependsOn: replace?.id,
    localRevision: 2
  })

  await persistEditablePresentationRevision(
    createWrite({ revision: 5, document: { ...initialDocument, name: 'Later' } })
  )
  expect(await db.getAll('personal-sync-outbox')).toHaveLength(3)
  expect(await db.get('file-blobs', replace?.snapshotBlobId ?? '')).toMatchObject({ revision: 4 })
  expect(await db.get('personal-sync-nodes', item.id)).toMatchObject({
    localRevision: 3,
    syncedLocalRevision: 1
  })
})

it.each([
  ['image/svg+xml', 'data:image/svg+xml;base64,PHN2Zy8+'],
  ['image/avif', 'data:image/avif;base64,AAAA'],
  ['image/png', 'data:image/png;base64,AAA=']
])(
  'rejects an unreadable %s revision without overwriting the saved body',
  async (mimeType, dataUrl) => {
    await seedAuthority()
    const db = await openFileExplorerDB()
    const before = await db.get('file-blobs', 'deck-source')
    await expect(
      persistEditablePresentationRevision(
        createWrite({
          document: {
            ...initialDocument,
            assets: { image: { id: 'image', name: 'Image', mimeType, dataUrl } }
          }
        })
      )
    ).rejects.toThrow()
    const after = await db.get('file-blobs', 'deck-source')
    expect(after?.revision).toBe(before?.revision)
    expect(await readBlobText(after?.blob)).toBe(await readBlobText(before?.blob))
    expect(await db.get('folder-items', item.id)).toEqual(item)
  }
)

it('rejects an oversized image before replacing the saved revision', async () => {
  await seedAuthority()
  const document = {
    ...initialDocument,
    assets: {
      image: {
        id: 'image',
        name: 'Large',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,' + 'A'.repeat(4 * Math.ceil((20 * 1024 * 1024 + 1) / 3))
      }
    }
  }
  await expect(persistEditablePresentationRevision(createWrite({ document }))).rejects.toThrow()
  expect((await (await openFileExplorerDB()).get('file-blobs', 'deck-source'))?.revision).toBe(1)
})

it('keeps a recoverable draft unchanged when an image cannot be reloaded', async () => {
  const db = await openFileExplorerDB()
  await db.put('presentation-drafts', { id: item.id, item, document: initialDocument, revision: 1 })
  const document = {
    ...initialDocument,
    assets: {
      image: {
        id: 'image',
        name: 'Image',
        mimeType: 'image/svg+xml',
        dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+'
      }
    }
  }
  await expect(persistEditablePresentationRevision(createWrite({ document }))).rejects.toThrow()
  expect(await db.get('presentation-drafts', item.id)).toMatchObject({
    document: initialDocument,
    revision: 1
  })
})

it('reloads a saved valid embedded image with identical content', async () => {
  const { loadEditablePresentation, clearEditablePresentationCache } =
    await import('../editable-presentation')
  await seedAuthority()
  const image = {
    id: 'image',
    name: 'Image.png',
    mimeType: 'image/png',
    dataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZaoAAAAASUVORK5CYII='
  }
  await persistEditablePresentationRevision(
    createWrite({ document: { ...initialDocument, assets: { image } } })
  )
  clearEditablePresentationCache()
  expect((await loadEditablePresentation(item)).assets.image).toEqual(image)
})

it('preserves an existing unreadable draft when promotion is rejected', async () => {
  const { savePresentationDraft } = await import('../presentation-drafts')
  const db = await openFileExplorerDB()
  const document = {
    ...initialDocument,
    assets: {
      image: {
        id: 'image',
        name: 'SVG',
        mimeType: 'image/svg+xml',
        dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+'
      }
    }
  }
  await db.put('presentation-drafts', { id: item.id, item, document, revision: 1 })
  await expect(savePresentationDraft(item.id, 'file-root', 'Recovered')).rejects.toThrow()
  expect(await db.get('presentation-drafts', item.id)).toMatchObject({ document, revision: 1 })
  expect(await db.getAll('folder-items')).toEqual([])
  expect(await db.getAll('file-blobs')).toEqual([])
})

it('saves and reopens adjusted v3 shapes from the authoritative local blob', async () => {
  await seedAuthority()
  const source = createBlankEditablePresentationDocument('Geometry')
  source.schemaVersion = 3
  const slideId = source.slideOrder[0]
  const shape = { ...createShapeElement('rightArrow'), adjustments: [25000, 2147483647] }
  const document = addElementToSlide(source, slideId, shape)
  await persistEditablePresentationRevision(createWrite({ document }))
  const reopened = await loadEditablePresentation({ id: item.id, name: 'Geometry', url: item.url })
  expect(reopened.schemaVersion).toBe(3)
  expect(reopened.slides[slideId].elements[shape.id]).toMatchObject({
    shape: 'rightArrow',
    adjustments: [25000, 2147483647]
  })
})
