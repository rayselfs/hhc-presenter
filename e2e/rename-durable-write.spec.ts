import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'

async function readName(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hhc-file-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const request = db.transaction('folder-items').objectStore('folder-items').get('durable-rename')
    const record = await new Promise<{ name: string }>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return record.name
  })
}

test('a failed rename retains the draft and original durable name, and retry persists across reload', async ({
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
    const tx = db.transaction('folder-items', 'readwrite')
    tx.objectStore('folder-items').put({
      id: 'durable-rename',
      parentId: 'file-root',
      type: 'file',
      name: 'Original.txt',
      url: 'blob:durable-rename',
      mimeType: 'text/plain',
      size: 0,
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.goto('/#/files')
  await page.reload()
  const row = page.locator('[data-item-id="durable-rename"]').first()
  await expect(row).toBeVisible()
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      const request = originalPut.call(this, value, key)
      if (
        this.name === 'folder-items' &&
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        value.id === 'durable-rename'
      ) {
        request.addEventListener(
          'success',
          () => {
            document.documentElement.dataset.renameAborts = '1'
            IDBObjectStore.prototype.put = originalPut
            this.transaction.abort()
          },
          { once: true }
        )
      }
      return request
    }
  })
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Rename file' })
  await input.fill('Renamed')
  await input.press('Enter')
  await expect(page.getByText(/aborted|AbortError|Rename failed/i).first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-rename-aborts', '1')
  await expect(input).toHaveValue('Renamed')
  expect(await readName(page)).toBe('Original.txt')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(row.getByText('Renamed.txt', { exact: true })).toBeVisible()
  expect(await readName(page)).toBe('Renamed.txt')
  await page.reload()
  await expect(row.getByText('Renamed.txt', { exact: true })).toBeVisible()
  expect(await readName(page)).toBe('Renamed.txt')
})
