import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
)

test.beforeEach(async ({ page }) => {
  await page.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await expect(page.locator('input[type="file"]').first()).toBeAttached()
})

test('shows running progress, stops remaining files and retains completed imports', async ({
  page
}) => {
  await page.evaluate(async () => {
    const request = indexedDB.open('hhc-file-explorer')
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('file-blobs', 'readwrite')
        let holding = true
        document.addEventListener(
          'release-import-storage',
          () => {
            holding = false
          },
          { once: true }
        )
        const hold = (): void => {
          if (!holding) return
          tx.objectStore('file-blobs').get('__import-test__').onsuccess = hold
        }
        tx.oncomplete = () => db.close()
        hold()
        resolve()
      }
    })
  })
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(
      Array.from({ length: 5 }, (_, index) => ({
        name: `photo-${index}.png`,
        mimeType: 'image/png',
        buffer: png
      }))
    )
  const status = page.getByRole('region', { name: 'Import files' })
  await expect(status.getByRole('status')).toHaveText('Imported 0 / 5 files')
  await expect(status).toContainText('photo-2.png')
  await status.getByRole('button', { name: 'Stop remaining files' }).click()
  await expect(status.getByRole('status')).toContainText('Finishing active files')
  await page.evaluate(() => document.dispatchEvent(new Event('release-import-storage')))
  await expect(status.getByRole('status')).toHaveText('3 imported · 0 failed · 2 skipped')
  await expect(status.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
})

test('reports a failed save and retries only that file without duplicating successes', async ({
  page
}) => {
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    let fail = true
    IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
      if (
        fail &&
        this.name === 'folder-items' &&
        typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        value.name === 'broken.png'
      ) {
        fail = false
        throw new DOMException('Storage is full', 'QuotaExceededError')
      }
      return key === undefined ? add.call(this, value) : add.call(this, value, key)
    }
  })
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(
      ['saved.png', 'broken.png'].map((name) => ({ name, mimeType: 'image/png', buffer: png }))
    )
  const status = page.getByRole('region', { name: 'Import files' })
  await expect(status.getByRole('status')).toHaveText('1 imported · 1 failed · 0 skipped')
  await expect(status.getByRole('list')).toContainText('broken.png')
  await status.getByRole('button', { name: 'Retry failed files', exact: true }).click()
  await expect(status.getByRole('status')).toHaveText('1 imported · 0 failed · 0 skipped')
  const names = await page.evaluate(
    async () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open('hhc-file-explorer')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('folder-items')
          const items = tx.objectStore('folder-items').getAll()
          items.onsuccess = () => resolve(items.result.map((item: { name: string }) => item.name))
          tx.oncomplete = () => db.close()
        }
      })
  )
  expect(names.filter((name) => name === 'saved.png')).toHaveLength(1)
  expect(names.filter((name) => name === 'broken.png')).toHaveLength(1)
})

test('another tab can purge the catalog while held media bytes survive until lock release', async ({
  page,
  context
}) => {
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'held.png',
    mimeType: 'image/png',
    buffer: png
  })
  await expect(page.getByRole('region', { name: 'Import files' }).getByRole('status')).toHaveText(
    '1 imported · 0 failed · 0 skipped'
  )
  const blobId = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hhc-file-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const id = await new Promise<string>((resolve, reject) => {
      const tx = db.transaction('folder-items')
      const request = tx.objectStore('folder-items').getAll()
      request.onsuccess = () =>
        resolve(request.result.find((item) => item.name === 'held.png').url.slice('blob:'.length))
      request.onerror = () => reject(request.error)
    })
    db.close()
    await new Promise<void>((resolve) => {
      void navigator.locks.request(`media-resource:${id}`, { mode: 'shared' }, async () => {
        resolve()
        await new Promise<void>((release) => {
          document.addEventListener('release-held-media', () => release(), { once: true })
        })
      })
    })
    return id
  })
  const other = await context.newPage()
  await other.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  await other.goto('/#/files')
  await other.getByText('held.png', { exact: true }).click({ button: 'right' })
  await other.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await other.getByRole('button', { name: 'Confirm', exact: true }).click()
  await other.goto('/#/trash')
  await other.getByText('held.png', { exact: true }).click({ button: 'right' })
  await other.getByRole('menuitem', { name: 'Delete Permanently', exact: true }).click()
  await other.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(other.getByText('held.png', { exact: true })).toHaveCount(0)
  await expect(page.getByText('held.png', { exact: true })).toHaveCount(0)
  const hasBlob = (): Promise<boolean> =>
    page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        indexedDB.open('hhc-file-explorer').onsuccess = (event) =>
          resolve((event.target as IDBOpenDBRequest).result)
      })
      const exists = await new Promise<boolean>((resolve) => {
        db.transaction('file-blobs').objectStore('file-blobs').get(id).onsuccess = (event) =>
          resolve(Boolean((event.target as IDBRequest).result))
      })
      db.close()
      return exists
    }, blobId)
  expect(await hasBlob()).toBe(true)
  await page.evaluate(() => document.dispatchEvent(new Event('release-held-media')))
  await expect.poll(hasBlob).toBe(false)
  await other.close()
})
