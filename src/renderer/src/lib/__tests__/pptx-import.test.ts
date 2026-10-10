import JSZip from 'jszip'
import { beforeEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { Blob as NodeBlob } from 'node:buffer'
import { importEditablePptx } from '../pptx-import'
import { loadEditablePresentation } from '../editable-presentation'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { resetMediaWorkDBForTests } from '../media-work-db'
import { resetThumbnailDBForTests } from '../thumbnail-db'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { EDITABLE_PRESENTATION_MIME_TYPE, PPTX_MIME_TYPE } from '../presentation-media'

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetThumbnailDBForTests()
  useFileExplorerStore.setState({
    items: {},
    _itemsArray: [],
    _itemsByParent: {},
    pendingPersistenceCount: 0
  })
})

it('imports one directly editable deck with all slides and no extra catalog copy', async () => {
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const file = new File([bytes], 'Sunday.pptx', { type: PPTX_MIME_TYPE })
  const item = await importEditablePptx(file, 'file-root')
  const db = await openFileExplorerDB()
  expect(await db.getAll('folder-items')).toHaveLength(1)
  expect(item).toMatchObject({ name: 'Sunday.lpdeck', mimeType: EDITABLE_PRESENTATION_MIME_TYPE })
  const reopened = await loadEditablePresentation(item)
  expect(reopened.name).toBe('Sunday')
  expect(reopened.slideOrder).toHaveLength(22)
  expect(
    Object.values(reopened.slides).every((slide) =>
      Object.values(slide.elements).some((element) => element.type === 'text')
    )
  ).toBe(true)
})

it('leaves no imported catalog entry after invalid PPTX data', async () => {
  await expect(
    importEditablePptx(new File(['invalid'], 'broken.pptx', { type: PPTX_MIME_TYPE }), 'file-root')
  ).rejects.toThrow()
  expect(await (await openFileExplorerDB()).getAll('folder-items')).toHaveLength(0)
})

it('rejects animation that would otherwise be silently lost', async () => {
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const zip = await JSZip.loadAsync(bytes)
  const path = 'ppt/slides/slide1.xml'
  const xml = await zip.file(path)!.async('string')
  zip.file(path, xml.replace('</p:sld>', '<p:timing><p:tnLst/></p:timing></p:sld>'))
  const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'Animated.pptx', {
    type: PPTX_MIME_TYPE
  })
  await expect(importEditablePptx(file, 'file-root')).rejects.toThrow(/animation/i)
  expect(await (await openFileExplorerDB()).getAll('folder-items')).toHaveLength(0)
})

it('resolves concurrent same-name imports to distinct catalog names', async () => {
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const items = await Promise.all(
    Array.from({ length: 3 }, () =>
      importEditablePptx(new File([bytes], 'Sunday.pptx', { type: PPTX_MIME_TYPE }), 'file-root')
    )
  )
  expect(new Set(items.map((item) => item.name)).size).toBe(3)
  expect(await (await openFileExplorerDB()).getAll('folder-items')).toHaveLength(3)
})

it.each([
  ['transition', '<p:transition><p:fade/></p:transition>', /transition/i],
  [
    'theme override',
    '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1"/></p:clrMapOvr>',
    /color mapping/i
  ],
  ['audio', '<p:extLst><a:audioFile r:link="audio1"/></p:extLst>', /media/i]
])('rejects unsupported %s without a partial catalog import', async (_name, markup, error) => {
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const zip = await JSZip.loadAsync(bytes)
  const path = 'ppt/slides/slide1.xml'
  const xml = await zip.file(path)!.async('string')
  zip.file(path, xml.replace('</p:sld>', `${markup}</p:sld>`))
  const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'Unsupported.pptx', {
    type: PPTX_MIME_TYPE
  })
  await expect(importEditablePptx(file, 'file-root')).rejects.toThrow(error)
  expect(await (await openFileExplorerDB()).getAll('folder-items')).toHaveLength(0)
})

it('accepts a slide color-map override identical to the inherited theme mapping', async () => {
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const zip = await JSZip.loadAsync(bytes)
  const path = 'ppt/slides/slide1.xml'
  const xml = await zip.file(path)!.async('string')
  zip.file(
    path,
    xml.replace(
      '</p:sld>',
      '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1"/></p:clrMapOvr></p:sld>'
    )
  )
  const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'Compatible.pptx', {
    type: PPTX_MIME_TYPE
  })
  await expect(importEditablePptx(file, 'file-root')).resolves.toMatchObject({
    name: 'Compatible.lpdeck'
  })
})
