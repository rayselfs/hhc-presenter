import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import { Blob as NodeBlob } from 'node:buffer'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  convertPptxToEditablePresentation,
  loadEditablePresentation
} from '../editable-presentation'
import { importEditablePptx } from '../pptx-import'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { resetMediaWorkDBForTests } from '../media-work-db'
import { resetThumbnailDBForTests } from '../thumbnail-db'
import { PPTX_MIME_TYPE } from '../presentation-media'
import type { FileItemRecord } from '@shared/types/folder'

const { readSource } = vi.hoisted(() => ({ readSource: vi.fn() }))
vi.mock('../presentation-source', () => ({ readPresentationArrayBuffer: readSource }))

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  readSource.mockReset()
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetThumbnailDBForTests()
})

it.each([
  ['animation', '<p:timing><p:tnLst/></p:timing>', /animation/i],
  ['transition', '<p:transition><p:fade/></p:transition>', /transition/i],
  ['audio', '<p:extLst><a:audioFile r:link="audio1"/></p:extLst>', /media/i],
  [
    'table',
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="999" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="914400"/></a:tblGrid><a:tr h="914400"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Table content</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>',
    /cannot yet be edited/i
  ]
])('rejects %s consistently before catalog or draft writes', async (_name, markup, error) => {
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const zip = await JSZip.loadAsync(bytes)
  const path = 'ppt/slides/slide1.xml'
  zip.file(
    path,
    (await zip.file(path)!.async('string')).replace(
      _name === 'table' ? '</p:spTree>' : '</p:sld>',
      `${markup}${_name === 'table' ? '</p:spTree>' : '</p:sld>'}`
    )
  )
  const buffer = await zip.generateAsync({ type: 'arraybuffer' })
  const file = new File([buffer], 'Original.pptx', { type: PPTX_MIME_TYPE })
  await expect(importEditablePptx(file, 'file-root')).rejects.toThrow(error)
  const db = await openFileExplorerDB()
  for (const parentId of ['file-root', 'read-only-source']) {
    const source: FileItemRecord = {
      id: 'original',
      name: file.name,
      parentId,
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      url: 'blob:original',
      size: buffer.byteLength,
      mimeType: PPTX_MIME_TYPE
    }
    await db.put('folder-items', source)
    await db.put('file-blobs', { id: source.id, blob: new Blob([buffer]), revision: 7 })
    readSource.mockResolvedValue(buffer)
    await expect(convertPptxToEditablePresentation(source)).rejects.toThrow(error)
    expect(await db.getAll('folder-items')).toEqual([source])
    expect(await db.getAllKeys('file-blobs')).toEqual([source.id])
    const original = await db.get('file-blobs', source.id)
    expect(original?.revision).toBe(7)
    expect(await original?.blob?.arrayBuffer()).toEqual(buffer)
    expect(await db.getAll('presentation-drafts')).toEqual([])
  }
})

it.each(['file-root', 'read-only-source'])(
  'keeps supported copy behavior for %s',
  async (parentId) => {
    const bytes = await readFile(
      'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
    )
    const buffer = new Uint8Array(bytes).buffer
    const source: FileItemRecord = {
      id: 'original',
      name: 'Original.pptx',
      parentId,
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      url: 'blob:original',
      size: buffer.byteLength,
      mimeType: PPTX_MIME_TYPE
    }
    const db = await openFileExplorerDB()
    await db.put('folder-items', source)
    readSource.mockResolvedValue(buffer)
    const copy = await convertPptxToEditablePresentation(source)
    expect(copy.id).not.toBe(source.id)
    expect(await db.get('folder-items', source.id)).toEqual(source)
    const document = await loadEditablePresentation(copy)
    expect(document.slideOrder).toHaveLength(22)
    expect(document.sourceItemId).toBe(parentId === 'file-root' ? undefined : source.id)
    expect(await db.count('presentation-drafts')).toBe(parentId === 'file-root' ? 0 : 1)
    expect(await db.count('folder-items')).toBe(parentId === 'file-root' ? 2 : 1)
  }
)

it('rejects an empty deck before either import or edit-copy writes', async () => {
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const zip = await JSZip.loadAsync(bytes)
  for (const path of Object.keys(zip.files)) {
    if (path.startsWith('ppt/slides/')) zip.remove(path)
  }
  const path = 'ppt/presentation.xml'
  zip.file(
    path,
    (await zip.file(path)!.async('string')).replace(
      /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
      '<p:sldIdLst/>'
    )
  )
  const buffer = await zip.generateAsync({ type: 'arraybuffer' })
  await expect(
    importEditablePptx(new File([buffer], 'Empty.pptx', { type: PPTX_MIME_TYPE }), 'file-root')
  ).rejects.toThrow(/no slides/)
  readSource.mockResolvedValue(buffer)
  const source: FileItemRecord = {
    id: 'empty',
    name: 'Empty.pptx',
    parentId: 'file-root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    url: 'blob:empty',
    size: buffer.byteLength,
    mimeType: PPTX_MIME_TYPE
  }
  await expect(convertPptxToEditablePresentation(source)).rejects.toThrow(/no slides/)
  const db = await openFileExplorerDB()
  expect(await db.count('folder-items')).toBe(0)
  expect(await db.count('file-blobs')).toBe(0)
  expect(await db.count('presentation-drafts')).toBe(0)
})

it('rejects converted documents with unsafe font styles before writing', async () => {
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const zip = await JSZip.loadAsync(bytes)
  for (const path of Object.keys(zip.files).filter((name) => name.endsWith('.xml'))) {
    const xml = await zip.file(path)!.async('string')
    zip.file(path, xml.replace(/typeface="[^"]*"/g, 'typeface="unsafe;font"'))
  }
  const buffer = await zip.generateAsync({ type: 'arraybuffer' })
  await expect(
    importEditablePptx(new File([buffer], 'Invalid.pptx', { type: PPTX_MIME_TYPE }), 'file-root')
  ).rejects.toThrow(/Invalid portable/)
  readSource.mockResolvedValue(buffer)
  const source: FileItemRecord = {
    id: 'invalid',
    name: 'Invalid.pptx',
    parentId: 'file-root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    url: 'blob:invalid',
    size: buffer.byteLength,
    mimeType: PPTX_MIME_TYPE
  }
  await expect(convertPptxToEditablePresentation(source)).rejects.toThrow(/Invalid portable/)
  const db = await openFileExplorerDB()
  expect(await db.count('folder-items')).toBe(0)
  expect(await db.count('file-blobs')).toBe(0)
  expect(await db.count('presentation-drafts')).toBe(0)
})
