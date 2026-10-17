import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'

async function readCreatedFolders(
  page: Page
): Promise<Array<{ name: string; expiresAt: number | null }>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hhc-file-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const records = await new Promise<Array<{ name: string; expiresAt: number | null }>>(
        (resolve, reject) => {
          const request = db.transaction('folder-records').objectStore('folder-records').getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        }
      )
      return records.filter((record) => record.name === 'Durable folder')
    } finally {
      db.close()
    }
  })
}

for (const entryPoint of ['toolbar', 'context menu'] as const) {
  test(`folder creation through ${entryPoint} keeps the failed form and waits for its retry transaction before closing`, async ({
    page
  }) => {
    await page.goto('/')
    await completeOnboarding(page)
    await page.goto('/#/files')
    if (entryPoint === 'toolbar') await page.getByLabel('New', { exact: true }).click()
    else await page.getByText('No files yet', { exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create New Folder' })
    const input = dialog.getByRole('textbox', { name: 'Folder Name' })
    await input.fill('Durable folder')
    await dialog.getByRole('button', { name: /Retention/ }).click()
    await page.getByRole('option', { name: 'Permanent', exact: true }).click()
    await page.evaluate(() => {
      const originalPut = IDBObjectStore.prototype.put
      const originalAdd = IDBObjectStore.prototype.add
      let attempt = 0
      const intercept = (
        store: IDBObjectStore,
        request: IDBRequest<IDBValidKey>,
        value: unknown
      ): IDBRequest<IDBValidKey> => {
        if (
          store.name === 'folder-records' &&
          typeof value === 'object' &&
          value !== null &&
          'name' in value &&
          value.name === 'Durable folder'
        ) {
          request.addEventListener(
            'success',
            () => {
              attempt++
              if (attempt === 1) {
                document.documentElement.dataset.createAborts = '1'
                store.transaction.abort()
                return
              }
              IDBObjectStore.prototype.put = originalPut
              IDBObjectStore.prototype.add = originalAdd
              const keepAlive = (): void => {
                if (document.documentElement.dataset.releaseCreate === '1') return
                store.get(request.result).onsuccess = keepAlive
              }
              keepAlive()
            },
            { once: true }
          )
        }
        return request
      }
      IDBObjectStore.prototype.put = function (
        value: unknown,
        key?: IDBValidKey
      ): IDBRequest<IDBValidKey> {
        return intercept(this, originalPut.call(this, value, key), value)
      }
      IDBObjectStore.prototype.add = function (
        value: unknown,
        key?: IDBValidKey
      ): IDBRequest<IDBValidKey> {
        return intercept(this, originalAdd.call(this, value, key), value)
      }
    })
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-create-aborts', '1')
    await expect(dialog).toBeVisible()
    await expect(input).toHaveValue('Durable folder')
    expect(await readCreatedFolders(page)).toEqual([])
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(input).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await page.evaluate(() => {
      document.documentElement.dataset.releaseCreate = '1'
    })
    await expect(dialog).toHaveCount(0)
    expect(await readCreatedFolders(page)).toEqual([
      expect.objectContaining({ name: 'Durable folder', expiresAt: null })
    ])
    await page.reload()
    await expect(page.getByText('Durable folder', { exact: true })).toBeVisible()
    expect(await readCreatedFolders(page)).toEqual([
      expect.objectContaining({ name: 'Durable folder', expiresAt: null })
    ])
  })
}
