import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('a failed restore keeps trash and selection, and retry waits for durable success', async ({
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
      id: 'durable-trash-file',
      parentId: 'file-root',
      originalParentId: 'file-root',
      deletedAt: Date.now(),
      type: 'file',
      name: 'Restore.txt',
      url: 'blob:durable-trash-file',
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
  await page.goto('/#/trash')
  await page.reload()
  const row = page.locator('[data-item-id="durable-trash-file"]')
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
        value.id === 'durable-trash-file' &&
        'deletedAt' in value &&
        !value.deletedAt
      ) {
        request.addEventListener('success', () => this.transaction.abort(), { once: true })
      }
      return request
    }
  })
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Restore', exact: true }).click()
  await expect(page.getByText(/aborted|AbortError|Restore failed/i).first()).toBeVisible()
  await expect(row).toBeVisible()
  await expect(page.getByText(/\b1 selected\b/)).toBeVisible()
  await page.reload()
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Restore', exact: true }).click()
  await expect(row).toHaveCount(0)
  expect(
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('hhc-file-explorer')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const request = db
        .transaction('folder-items')
        .objectStore('folder-items')
        .get('durable-trash-file')
      const record = await new Promise<{ deletedAt?: number }>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      db.close()
      return record.deletedAt
    })
  ).toBeUndefined()
})
