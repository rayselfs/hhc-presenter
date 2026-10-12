import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { Blob as NodeBlob } from 'node:buffer'
import type { FileItemRecord } from '@shared/types/folder'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { importEditablePptx } from '../pptx-import'
import {
  convertPptxToEditablePresentation,
  loadEditablePresentation
} from '../editable-presentation'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { resetMediaWorkDBForTests } from '../media-work-db'
import { resetThumbnailDBForTests } from '../thumbnail-db'
import { getPresentationDraft } from '../presentation-drafts'
import { PPTX_MIME_TYPE } from '../presentation-media'

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:resolved-pptx')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  usePersonalSyncStore.setState({ activeOwnerId: null })
  useFileExplorerStore.setState({ items: {}, _itemsArray: [], _itemsByParent: {} })
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetThumbnailDBForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function fixture(kind: string): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(
    await readFile('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx')
  )
  const path = 'ppt/slides/slide1.xml'
  let xml = await zip.file(path)!.async('string')
  const features: Record<string, string> = {
    animation: '<p:timing><p:tnLst/></p:timing>',
    transition: '<p:transition><p:fade/></p:transition>',
    media: '<p:extLst><a:audioFile r:link="audio1"/></p:extLst>',
    'color mapping': '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1"/></p:clrMapOvr>'
  }
  if (features[kind]) xml = xml.replace('</p:sld>', `${features[kind]}</p:sld>`)
  if (kind === 'group')
    xml = xml.replace(
      '</p:spTree>',
      '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="99" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/><a:chOff x="0" y="0"/><a:chExt cx="952500" cy="952500"/></a:xfrm></p:grpSpPr></p:grpSp></p:spTree>'
    )
  if (kind === 'malformed') xml = '<broken>'
  zip.file(path, xml)
  if (kind === 'macro') zip.file('ppt/vbaProject.bin', 'macro')
  const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
  if (kind === 'encrypted' || kind === 'oversized') {
    const view = new DataView(buffer)
    for (let offset = 0; offset <= buffer.byteLength - 46; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue
      if (kind === 'encrypted') view.setUint16(offset + 8, 1, true)
      else view.setUint32(offset + 24, 33554433, true)
      break
    }
  }
  return buffer
}

async function prepareConversion(
  bytes: ArrayBuffer,
  mode: string
): Promise<() => Promise<FileItemRecord>> {
  if (mode === 'upload')
    return () =>
      importEditablePptx(new File([bytes], 'Sunday.pptx', { type: PPTX_MIME_TYPE }), 'file-root')
  if (mode === 'provider') usePersonalSyncStore.setState({ activeOwnerId: 'readonly-provider' })
  const source: FileItemRecord = {
    id: 'raw-source',
    type: 'file',
    name: 'Sunday.pptx',
    parentId: 'file-root',
    url:
      mode === 'provider'
        ? 'https://www.alive.org.tw/api/assets/content?ticket=test'
        : 'blob:raw-source',
    mimeType: PPTX_MIME_TYPE,
    size: bytes.byteLength,
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    ...(mode === 'provider' ? { sharedRecipientId: 'readonly-provider' } : {})
  }
  const db = await openFileExplorerDB()
  await db.put('folder-items', source)
  await db.put('file-blobs', { id: source.id, blob: new Blob([bytes]), refCount: 1 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes))
  return () => convertPptxToEditablePresentation(source)
}

async function snapshot(): Promise<unknown> {
  const db = await openFileExplorerDB()
  return {
    items: await db.getAll('folder-items'),
    drafts: await db.getAll('presentation-drafts'),
    blobs: await Promise.all(
      (await db.getAll('file-blobs')).map(async (record) => ({
        ...record,
        blob: record.blob ? Array.from(new Uint8Array(await record.blob.arrayBuffer())) : undefined
      }))
    )
  }
}

describe.each(['upload', 'local', 'provider'])('%s editable conversion boundary', (mode) => {
  it.each([
    'animation',
    'transition',
    'media',
    'color mapping',
    'group',
    'malformed',
    'macro',
    'encrypted',
    'oversized'
  ])('rejects %s before any partial item, blob or draft is created', async (kind) => {
    const bytes = await fixture(kind)
    const convert = await prepareConversion(bytes, mode)
    const before = await snapshot()
    await expect(convert()).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('retains the supported hymn and schema-v1 persistence policy', async () => {
    const bytes = await fixture('supported')
    const convert = await prepareConversion(bytes, mode)
    const item = await convert()
    const document =
      mode === 'provider'
        ? (await getPresentationDraft(item.id))!.document
        : await loadEditablePresentation(item)
    expect(document.slideOrder).toHaveLength(22)
    expect(document.schemaVersion).toBe(1)
    expect(document.pptxSource).toBeUndefined()
    const db = await openFileExplorerDB()
    expect(await db.count('folder-items')).toBe(mode === 'local' ? 2 : 1)
    expect(await db.count('presentation-drafts')).toBe(mode === 'provider' ? 1 : 0)
    if (mode !== 'upload') {
      expect(await db.get('folder-items', 'raw-source')).toMatchObject({
        name: 'Sunday.pptx',
        mimeType: PPTX_MIME_TYPE
      })
      expect(await (await db.get('file-blobs', 'raw-source'))!.blob!.arrayBuffer()).toEqual(bytes)
    }
  })
})
