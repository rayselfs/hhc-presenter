import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'

async function readFolder(page: Page): Promise<{ name: string; expiresAt: number | null }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hhc-file-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<{ name: string; expiresAt: number | null }>((resolve, reject) => {
        const request = db
          .transaction('folder-records')
          .objectStore('folder-records')
          .get('durable-properties')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  })
}

test('folder properties retain failed name and retention changes until a durable retry', async ({
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
    const tx = db.transaction('folder-records', 'readwrite')
    tx.objectStore('folder-records').put({
      id: 'durable-properties',
      parentId: 'file-root',
      name: 'Original folder',
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      sortIndex: 0
    })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
  await page.goto('/#/files')
  await page.reload()
  const original = await readFolder(page)
  await page.getByText('Original folder', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit Folder' })
  const input = dialog.getByRole('textbox', { name: 'Folder Name' })
  await input.fill('Renamed folder')
  await dialog.getByRole('button', { name: /Retention/ }).click()
  await page.getByRole('option', { name: 'Permanent', exact: true }).click()
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      const request = originalPut.call(this, value, key)
      if (
        this.name === 'folder-records' &&
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        value.id === 'durable-properties'
      ) {
        request.addEventListener(
          'success',
          () => {
            document.documentElement.dataset.propertiesAborts = '1'
            IDBObjectStore.prototype.put = originalPut
            this.transaction.abort()
          },
          { once: true }
        )
      }
      return request
    }
  })
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-properties-aborts', '1')
  await expect(dialog).toBeVisible()
  await expect(input).toHaveValue('Renamed folder')
  await expect(dialog.getByRole('button', { name: /Retention/ })).toContainText('Permanent')
  expect(await readFolder(page)).toMatchObject(original)
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      const request = originalPut.call(this, value, key)
      if (
        this.name === 'folder-records' &&
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        value.id === 'durable-properties'
      ) {
        request.addEventListener(
          'success',
          () => {
            IDBObjectStore.prototype.put = originalPut
            const keepAlive = (): void => {
              if (document.documentElement.dataset.releaseProperties === '1') return
              this.get('durable-properties').onsuccess = keepAlive
            }
            keepAlive()
          },
          { once: true }
        )
      }
      return request
    }
  })
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(dialog.locator('[aria-busy="true"]')).toBeVisible()
  await expect(input).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.dataset.releaseProperties = '1'
  })
  await expect(dialog).toHaveCount(0)
  expect(await readFolder(page)).toMatchObject({ name: 'Renamed folder', expiresAt: null })
  await page.reload()
  await expect(page.getByText('Renamed folder', { exact: true })).toBeVisible()
  expect(await readFolder(page)).toMatchObject({ name: 'Renamed folder', expiresAt: null })
})
