import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'

async function readCopies(page: Page): Promise<{ names: string[]; refs: number }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hhc-file-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['folder-items', 'file-blobs'])
    const items = tx.objectStore('folder-items').getAll()
    const blob = tx.objectStore('file-blobs').get('durable-copy')
    const [names, refs] = await Promise.all([
      new Promise<string[]>((resolve, reject) => {
        items.onsuccess = () => resolve(items.result.map((item) => item.name).sort())
        items.onerror = () => reject(items.error)
      }),
      new Promise<number>((resolve, reject) => {
        blob.onsuccess = () => resolve(blob.result.refCount)
        blob.onerror = () => reject(blob.error)
      })
    ])
    db.close()
    return { names, refs }
  })
}

test('paste commits its unique name with the copy and retries an aborted write without a duplicate', async ({
  page
}) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hhc-file-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['folder-items', 'file-blobs'], 'readwrite')
    tx.objectStore('folder-items').put({
      id: 'durable-copy',
      parentId: 'file-root',
      type: 'file',
      name: 'Original.txt',
      url: 'blob:durable-copy',
      mimeType: 'text/plain',
      size: 5,
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    })
    tx.objectStore('file-blobs').put({
      id: 'durable-copy',
      blob: new Blob(['hello']),
      refCount: 1
    })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
  await page.goto('/#/files')
  await page.reload()
  const row = page.locator('[data-item-id="durable-copy"]').first()
  await expect(row).toBeVisible()
  await row.click()
  await page.keyboard.press('ControlOrMeta+c')
  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      const request = originalAdd.call(this, value, key)
      if (
        this.name === 'folder-items' &&
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        value.id !== 'durable-copy'
      ) {
        document.documentElement.dataset.copyName = 'name' in value ? String(value.name) : ''
        request.addEventListener(
          'success',
          () => {
            IDBObjectStore.prototype.add = originalAdd
            this.transaction.abort()
          },
          { once: true }
        )
      }
      return request
    }
  })
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByText(/aborted|AbortError|copy failed/i).first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-copy-name', 'Original 2.txt')
  expect(await readCopies(page)).toEqual({ names: ['Original.txt'], refs: 1 })
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByText('Original 2.txt', { exact: true }).first()).toBeVisible()
  expect(await readCopies(page)).toEqual({ names: ['Original 2.txt', 'Original.txt'], refs: 2 })
  await page.reload()
  await expect(page.getByText('Original 2.txt', { exact: true }).first()).toBeVisible()
  expect(await readCopies(page)).toEqual({ names: ['Original 2.txt', 'Original.txt'], refs: 2 })
})
