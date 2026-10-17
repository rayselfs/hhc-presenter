import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'
import type { EditablePresentationDocument } from '../src/renderer/src/lib/editable-presentation'

type Metrics = {
  stringifyMs: number[]
  serializedBytes: number
  sourceWrites: number
  thumbnailReady: number
  thumbnailWrites: number
  layoutMeasurements: number
  longTasks: number[]
  durableAt: number
  durableRevisions: number[]
}

declare global {
  interface Window {
    saveMetrics: Metrics
  }
}

test.describe.configure({ mode: 'serial' })

async function installFixture(
  page: Page,
  count: number
): Promise<{ sourceId: string; revision: number }> {
  const fixture = await page.evaluate(async (count) => {
    const result = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const db = await result(indexedDB.open('hhc-file-explorer'))
    const records = (await result(
      db.transaction('file-blobs').objectStore('file-blobs').getAll()
    )) as Array<{ id: string; blob: Blob; revision?: number }>
    const record = records.find(
      (record) => record.blob.type === 'application/vnd.hhc.presenter+json'
    )!
    const doc = JSON.parse(await record.blob.text()) as EditablePresentationDocument
    const base = doc.slides[doc.slideOrder[0]]
    doc.slides = {}
    doc.slideOrder = []
    let seed = 42
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 540
    const context = canvas.getContext('2d')!
    for (let i = 0; i < 5; i++) {
      const pixels = context.createImageData(540, 540)
      for (let j = 0; j < pixels.data.length; j++) {
        seed = (1664525 * seed + 1013904223) >>> 0
        pixels.data[j] = j % 4 === 3 ? 255 : seed >>> 24
      }
      context.putImageData(pixels, 0, 0)
      const id = `asset-${i}`
      doc.assets[id] = { id, name: id, mimeType: 'image/png', dataUrl: canvas.toDataURL() }
    }
    for (let i = 0; i < count; i++) {
      const id = `slide-${i}`
      const slide = { ...base, id, elements: {}, elementOrder: [] } as typeof base
      for (let j = 0; j < 3; j++) {
        const elementId = `text-${j}`
        slide.elements[elementId] = {
          id: elementId,
          type: 'text',
          text: `Slide ${i} text ${j}`,
          x: 50,
          y: 50 + j * 100,
          width: 600,
          height: 40,
          rotation: 0,
          opacity: 1,
          fontFamily: 'Arial',
          fontSize: 24,
          bold: false,
          italic: false,
          underline: false,
          color: '#000000',
          align: 'left',
          lineHeight: 1.15,
          autoWidth: false,
          autoSize: 'content'
        }
        slide.elementOrder.push(elementId)
      }
      slide.elements.image = {
        id: 'image',
        type: 'image',
        assetId: `asset-${i % 5}`,
        x: 700,
        y: 50,
        width: 200,
        height: 200,
        rotation: 0,
        opacity: 1
      }
      slide.elementOrder.push('image')
      doc.slides[id] = slide
      doc.slideOrder.push(id)
    }
    const blob = new Blob([JSON.stringify(doc)], { type: record.blob.type })
    const tx = db.transaction('file-blobs', 'readwrite')
    tx.objectStore('file-blobs').put({
      ...record,
      blob,
      size: blob.size,
      revision: (record.revision ?? 0) + 1
    })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    return { sourceId: record.id, revision: (record.revision ?? 0) + 1 }
  }, count)
  await page.reload()
  await expect(page.locator('[data-slide-option]')).toHaveCount(count)
  return fixture
}

for (const count of [10, 100]) {
  for (let run = 1; run <= 5; run++) {
    test(`${count} slides run ${run}`, async ({ page }, testInfo) => {
      test.setTimeout(90000)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto('/')
      await completeOnboarding(page)
      await page.goto('/#/files')
      await page.getByLabel('New', { exact: true }).click()
      await page.getByRole('menuitem', { name: 'Create Presentation', exact: true }).click()
      await expect(page.locator('[data-slide-option]')).toHaveCount(1)
      await page.waitForTimeout(1500)
      const fixture = await installFixture(page, count)
      await page.waitForTimeout(2000)
      await page.evaluate((sourceId) => {
        const metrics: Metrics = {
          stringifyMs: [],
          serializedBytes: 0,
          sourceWrites: 0,
          thumbnailReady: 0,
          thumbnailWrites: 0,
          layoutMeasurements: 0,
          longTasks: [],
          durableAt: 0,
          durableRevisions: []
        }
        window.saveMetrics = metrics
        const stringify = JSON.stringify
        JSON.stringify = new Proxy(stringify, {
          apply(target, thisArg, args) {
            const start = performance.now()
            const body: string = Reflect.apply(target, thisArg, args)
            const value = args[0] as Partial<EditablePresentationDocument> | undefined
            if (value?.slides && value.slideOrder) {
              metrics.stringifyMs.push(performance.now() - start)
              metrics.serializedBytes += new Blob([body]).size
            }
            return body
          }
        })
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (
          ...args: Parameters<typeof put>
        ): IDBRequest<IDBValidKey> {
          const record = args[0] as {
            id?: string
            kind?: string
            sourceBlobId?: string
            revision: number
          }
          if (
            this.name === 'derived-assets' &&
            record.kind === 'cover-thumbnail' &&
            record.sourceBlobId === sourceId
          ) {
            metrics.thumbnailWrites++
          }
          if (this.name === 'file-blobs' && record.id === sourceId) {
            metrics.sourceWrites++
            const revision = (args[0] as { revision: number }).revision
            this.transaction.addEventListener('complete', () => {
              metrics.durableAt = performance.now()
              metrics.durableRevisions.push(revision)
            })
          }
          return put.apply(this, args)
        }
        window.addEventListener('hhc:thumbnail-ready', (event) => {
          if ((event as CustomEvent<{ itemId: string }>).detail.itemId === sourceId)
            metrics.thumbnailReady++
        })
        const clone = Node.prototype.cloneNode
        Node.prototype.cloneNode = function (deep?: boolean): Node {
          if (this instanceof HTMLElement && this.hasAttribute('data-text-content'))
            metrics.layoutMeasurements++
          return clone.call(this, deep)
        }
        new PerformanceObserver((list) => {
          metrics.longTasks.push(...list.getEntries().map((entry) => entry.duration))
        }).observe({ type: 'longtask', buffered: false })
      }, fixture.sourceId)
      const slides = page.locator('[data-slide-option]')
      await slides.nth(1).click()
      const text = page.locator('.presentation-stage [data-text-content]').first()
      await text.dblclick()
      await text.press('End')
      await text.pressSequentially('abcdefghij'.repeat(10), { delay: 100 })
      await page.keyboard.press('Escape')
      const nudgeUntil = Date.now() + 3000
      while (Date.now() < nudgeUntil) {
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(100)
      }
      const notes = page.getByRole('textbox', { name: 'Notes', exact: true })
      if (!(await notes.isVisible()))
        await page.locator('[aria-controls="presentation-notes-region"]').click()
      for (let n = 0; n < 20; n++) {
        await notes.fill(`Note ${n}`)
        await notes.press('Tab')
        await page.waitForTimeout(300)
      }
      await slides.first().click()
      await text.dblclick()
      await text.press('ControlOrMeta+A')
      await text.pressSequentially('Changed cover')
      await page.keyboard.press('Escape')
      await page.keyboard.press('ArrowLeft')
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
      await page.getByRole('button', { name: 'Undo', exact: true }).click()
      await page.getByRole('button', { name: 'Redo', exact: true }).click()
      const lastEditAt = await page.evaluate(() => performance.now())
      await expect(page.getByText(/^(Saved|已儲存|已保存)$/)).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const metrics = window.saveMetrics
            return metrics.thumbnailReady > 0 && metrics.thumbnailReady === metrics.thumbnailWrites
          })
        )
        .toBe(true)
      const metrics = await page.evaluate(() => window.saveMetrics)
      // Existing Chromium baselines write 5–6 revisions; retain headroom for checkpoint timing.
      expect(metrics.sourceWrites).toBeGreaterThan(0)
      expect(metrics.sourceWrites).toBeLessThanOrEqual(8)
      expect(metrics.thumbnailWrites).toBeGreaterThan(0)
      expect(metrics.thumbnailWrites).toBeLessThanOrEqual(2)
      expect(metrics.durableRevisions).toHaveLength(metrics.sourceWrites)
      expect(
        metrics.durableRevisions.every(
          (revision, index, revisions) =>
            revision > (index === 0 ? fixture.revision : revisions[index - 1])
        )
      ).toBe(true)
      const persisted = await page.evaluate(async (sourceId) => {
        const result = <T>(request: IDBRequest<T>): Promise<T> =>
          new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
        const db = await result(indexedDB.open('hhc-file-explorer'))
        const record = await result(
          db.transaction('file-blobs').objectStore('file-blobs').get(sourceId)
        )
        db.close()
        return {
          revision: record.revision as number,
          document: JSON.parse(await record.blob.text()) as EditablePresentationDocument
        }
      }, fixture.sourceId)
      expect(persisted.revision).toBe(metrics.durableRevisions.at(-1))
      const storedSlides = persisted.document.slideOrder.map((id) => persisted.document.slides[id])
      expect(storedSlides[0].elements['text-0']).toMatchObject({ text: 'Changed cover' })
      expect(storedSlides[1].elements['text-0']).toMatchObject({
        text: `Slide 1 text 0${'abcdefghij'.repeat(10)}`
      })
      expect(storedSlides[1].notes).toBe('Note 19')
      await testInfo.attach('metrics', {
        body: JSON.stringify({
          ...metrics,
          count,
          run,
          durableLatencyMs: metrics.durableAt - lastEditAt
        }),
        contentType: 'application/json'
      })
      console.log(
        'SAVE_METRICS',
        JSON.stringify({ ...metrics, count, run, durableLatencyMs: metrics.durableAt - lastEditAt })
      )
      await page.reload()
      await expect(page.locator('.presentation-stage [data-text-content]').first()).toContainText(
        'Changed cover'
      )
      await slides.nth(1).click()
      await page.locator('[aria-controls="presentation-notes-region"]').click()
      await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Note 19')
    })
  }
}
