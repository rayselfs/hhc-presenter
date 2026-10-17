import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

for (const entryPoint of ['keyboard', 'context menu'] as const) {
  test(`failed trash through ${entryPoint} retains the file and selection for a durable retry`, async ({
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
        id: 'durable-delete-file',
        parentId: 'file-root',
        type: 'file',
        name: 'Trash.txt',
        url: 'blob:durable-delete-file',
        mimeType: 'text/plain',
        size: 3,
        sortIndex: 0,
        createdAt: Date.now(),
        expiresAt: null
      })
      tx.objectStore('file-blobs').put({
        id: 'durable-delete-file',
        blob: new Blob(['one']),
        size: 3,
        refCount: 1
      })
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    })
    await page.goto('/#/files')
    await page.reload()
    const row = page.locator('[data-item-id="durable-delete-file"]').first()
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByText(/\b1 selected\b/)).toBeVisible()
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
          value.id === 'durable-delete-file' &&
          'deletedAt' in value &&
          value.deletedAt
        ) {
          request.addEventListener(
            'success',
            () => {
              IDBObjectStore.prototype.put = originalPut
              document.documentElement.dataset.trashAborts = '1'
              this.transaction.abort()
            },
            { once: true }
          )
        }
        return request
      }
    })
    const deleteSelected = async (): Promise<void> => {
      if (entryPoint === 'keyboard') await page.keyboard.press('Delete')
      else {
        await row.click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
      }
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Confirm', exact: true })
        .click()
    }
    await deleteSelected()
    await expect(page.locator('html')).toHaveAttribute('data-trash-aborts', '1')
    await expect(row).toBeVisible()
    await expect(page.getByText(/\b1 selected\b/)).toBeVisible()
    const readState = async (): Promise<{ deletedAt?: number; blobSize: number }> =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('hhc-file-explorer')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const tx = db.transaction(['folder-items', 'file-blobs'])
        const read = <T>(request: IDBRequest<T>): Promise<T> =>
          new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
        try {
          const [record, blob] = await Promise.all([
            read(tx.objectStore('folder-items').get('durable-delete-file')),
            read(tx.objectStore('file-blobs').get('durable-delete-file'))
          ])
          return { deletedAt: record.deletedAt, blobSize: blob.blob.size }
        } finally {
          db.close()
        }
      })
    expect(await readState()).toEqual({ deletedAt: undefined, blobSize: 3 })
    await deleteSelected()
    await expect(row).toHaveCount(0)
    expect(await readState()).toEqual({ deletedAt: expect.any(Number), blobSize: 3 })
    await page.goto('/#/trash')
    await expect(row).toBeVisible()
    await page.reload()
    await expect(row).toBeVisible()
    expect(await readState()).toEqual({ deletedAt: expect.any(Number), blobSize: 3 })
  })
}
