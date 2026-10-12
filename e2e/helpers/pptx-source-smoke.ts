import { expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import type { EditablePresentationDocument } from '../../src/renderer/src/lib/editable-presentation'
import { completeOnboarding } from '../helpers.ts'

export async function prepareSourceHymn(
  page: Page,
  bytes?: Buffer
): Promise<{ id: string; source: { version: number; base64: string; sha256: string } }> {
  bytes ??= await readFile('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx')
  const source = {
    version: 1,
    base64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  const zip = await JSZip.loadAsync(bytes)
  const nodes = await Promise.all(
    Array.from({ length: 22 }, async (_, index) => {
      const part = `ppt/slides/slide${index + 1}.xml`
      const xml = await zip.file(part)!.async('string')
      const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((id) => id !== '1')
      return { part, ids }
    })
  )
  await completeOnboarding(page)
  await page.goto(page.url().replace(/#.*$/, '#/files'))
  await page.locator('input[type="file"][multiple]:not([webkitdirectory])').first().setInputFiles({
    name: 'Source hymn.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: bytes
  })
  const file = page.getByText('Source hymn.lpdeck', { exact: true })
  await expect(file).toHaveCount(1)
  // Seed the approved v2 read contract; ordinary imports deliberately remain v1 until API rollout.
  const id = await page.evaluate(
    async ({ source, nodes }) => {
      const request = indexedDB.open('hhc-file-explorer')
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const read = db.transaction(['folder-items', 'file-blobs'])
      const items = await new Promise<Array<{ id: string; name: string; url: string }>>(
        (resolve, reject) => {
          const request = read.objectStore('folder-items').getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        }
      )
      const item = items.find((item) => item.name === 'Source hymn.lpdeck')
      if (!item) throw new Error('Hymn catalog missing')
      const record = await new Promise<{ id: string; blob: Blob; size: number }>(
        (resolve, reject) => {
          const request = db
            .transaction('file-blobs')
            .objectStore('file-blobs')
            .get(item.url.slice(5))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        }
      )
      const document = JSON.parse(await record.blob.text()) as EditablePresentationDocument
      if (document.schemaVersion !== 1 || document.pptxSource)
        throw new Error('Ordinary import activated v2')
      document.schemaVersion = 2
      document.pptxSource = { ...source, version: 1 }
      document.slideOrder.forEach((id, index) => {
        const slide = document.slides[id]
        slide.pptxSourcePart = nodes[index].part
        if (nodes[index].ids.length !== 1) throw new Error('Hymn node mapping mismatch')
        slide.elementOrder.forEach((id) => {
          const element = slide.elements[id]
          if (element.type !== 'text' && element.type !== 'shape')
            throw new Error('Unexpected hymn node')
          element.pptxSourceNode = {
            id: nodes[index].ids[0],
            role: element.type === 'text' ? 'text' : 'geometry'
          }
        })
      })
      const blob = new Blob([JSON.stringify(document)], { type: record.blob.type })
      const tx = db.transaction(['folder-items', 'file-blobs'], 'readwrite')
      tx.objectStore('file-blobs').put({ ...record, blob, size: blob.size })
      tx.objectStore('folder-items').put({ ...item, size: blob.size })
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
      db.close()
      return item.id
    },
    { source, nodes }
  )
  await page.reload()
  await file.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  return { id, source }
}

export async function runPptxSourceSmoke(
  page: Page,
  openProjection: () => Promise<Page>
): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { id, source } = await prepareSourceHymn(page)
  const slides = page.locator('[data-slide-option]')
  await expect(slides).toHaveCount(22)
  const editorUrl = page.url()
  await page.locator('.presentation-stage [data-text-content]').first().dblclick()
  await page.locator('.presentation-stage [contenteditable="true"]').fill('來源保存測試')
  await slides.first().click()
  await slides.first().press('ControlOrMeta+C')
  await slides.first().press('ControlOrMeta+V')
  await expect(slides).toHaveCount(23)
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText(/^(Saved|已儲存|已保存)$/)).toBeVisible()
  const copied = await readSavedSourceDocument(page, id)
  expect(copied.pptxSource).toEqual(source)
  const detached = Object.values(copied.slides).filter((slide) => !slide.pptxSourcePart)
  expect(detached).toHaveLength(1)
  expect(Object.values(detached[0].elements).every((element) => !element.pptxSourceNode)).toBe(true)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(slides).toHaveCount(22)
  await slides.first().click()
  const opened = openProjection()
  await page.keyboard.press('F5')
  const projection = await opened
  projection.on('pageerror', (error) => errors.push(error.message))
  await expect(projection.getByText('來源保存測試', { exact: true })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(projection.getByText('Amazing grace', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    location.hash = '#/bible'
  })
  await expect(page).toHaveURL(/#\/bible$/)
  await expect(projection.getByText('Amazing grace', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    location.hash = '#/media'
  })
  await expect(page).toHaveURL(/#\/media$/)
  await expect(page.locator('.presenter-current')).toBeVisible()
  await expect(projection.getByText('Amazing grace', { exact: true })).toBeVisible()
  await page.bringToFront()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(editorUrl)
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText(/^(Saved|已儲存|已保存)$/)).toBeVisible()
  await page.reload()
  await expect(slides).toHaveCount(22)
  await slides.first().click()
  await expect(
    page.locator('.presentation-stage').getByText('來源保存測試', { exact: true })
  ).toBeVisible()
  const saved = await readSavedSourceDocument(page, id)
  expect(saved.schemaVersion).toBe(2)
  expect(saved.pptxSource).toEqual(source)
  expect(saved.slideOrder).toHaveLength(22)
  expect(
    Object.values(saved.slides).every(
      (slide) =>
        slide.pptxSourcePart &&
        Object.values(slide.elements).every((element) => element.pptxSourceNode)
    )
  ).toBe(true)
  expect(errors).toEqual([])
}

async function readSavedSourceDocument(
  page: Page,
  id: string
): Promise<EditablePresentationDocument> {
  return page.evaluate(async (id) => {
    const request = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const record = await new Promise<{ blob: Blob }>((resolve, reject) => {
      const request = db.transaction('file-blobs').objectStore('file-blobs').get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return JSON.parse(await record.blob.text()) as EditablePresentationDocument
  }, id)
}
