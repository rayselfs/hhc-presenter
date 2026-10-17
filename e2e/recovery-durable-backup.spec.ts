import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('failed upload recovery retries a real aborted backup and commits permanent retention before cancelling', async ({
  page,
  context
}) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZaoAAAAASUVORK5CYII=',
    'base64'
  )
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'qa-owner', roles: [], exp: 4102444800 })).toString('base64url')}.signature`
  await context.route('https://account.alive.org.tw/api/account/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    await route.fulfill({
      json: path.endsWith('/session')
        ? {
            authenticated: true,
            user: {
              id: 'qa-owner',
              email: 'backup-qa@example.com',
              display_name: 'Backup QA',
              avatar_url: null
            },
            permissions: ['presenter:cloud:manage'],
            permission_availability: { status: 'available' }
          }
        : path.endsWith('/csrf-token')
          ? { csrf_token: 'qa-csrf' }
          : { access_token: token, expires_in: 3600 }
    })
  })
  await context.route('https://www.alive.org.tw/api/assets/personal-space**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/changes'))
      await route.fulfill({
        json: {
          collection: { id: 'space', revision: 1 },
          items: [],
          nextCursor: 'cursor-1',
          hasMore: false,
          reset: true
        }
      })
    else if (path.endsWith('/usage'))
      await route.fulfill({
        json: {
          activeBytes: 0,
          trashBytes: 0,
          protectedBytes: 0,
          usedBytes: 0,
          quotaBytes: 100 * 1024 ** 3,
          overrideBytes: null
        }
      })
    else if (path.includes('/uploads'))
      await route.fulfill({
        json: {
          id: 'failed-upload',
          contentPath: '/api/assets/personal-space/uploads/failed-upload/content',
          expiresAt: '2099-01-01T00:00:00Z',
          uploadStatus: 'completed',
          scanStatus: 'failed',
          processingStatus: 'failed'
        }
      })
    else
      await route.fulfill({
        json: { id: 'space', revision: 1, usedBytes: 0, quotaBytes: 100 * 1024 ** 3 }
      })
  })
  await page.goto('/')
  await completeOnboarding(page)
  await page.getByRole('link', { name: 'Cloud documents', exact: true }).click()
  await expect(page.getByText('No files yet', { exact: true })).toBeVisible()
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name: 'Recovery.png', mimeType: 'image/png', buffer: png })
  const action = page.getByRole('button', {
    name: 'Back up locally and cancel upload',
    exact: true
  })
  await expect(action).toBeVisible({ timeout: 20000 })
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
        'parentId' in value &&
        value.parentId === 'file-root'
      ) {
        request.addEventListener(
          'success',
          () => {
            IDBObjectStore.prototype.add = originalAdd
            document.documentElement.dataset.backupAborts = '1'
            document.documentElement.dataset.backupInitialRetention =
              'expiresAt' in value && value.expiresAt === null ? 'permanent' : 'expiring'
            this.transaction.abort()
          },
          { once: true }
        )
      }
      return request
    }
  })
  const recover = async (): Promise<void> => {
    await action.click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Back up locally and cancel upload', exact: true })
      .click()
  }
  await recover()
  await expect(page.locator('html')).toHaveAttribute('data-backup-aborts', '1')
  await expect(page.locator('html')).toHaveAttribute('data-backup-initial-retention', 'permanent')
  await expect(action).toBeEnabled()
  const readState = async (): Promise<{
    personal: number
    outbox: number
    backups: Array<{ expiresAt: number | null; bytes: number[] }>
  }> =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('hhc-file-explorer')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const tx = db.transaction(['folder-items', 'personal-sync-outbox', 'file-blobs'])
      const read = <T>(request: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      try {
        const [items, operations, blobs] = await Promise.all([
          read(tx.objectStore('folder-items').getAll()),
          read(tx.objectStore('personal-sync-outbox').getAll()),
          read(tx.objectStore('file-blobs').getAll())
        ])
        const backups = await Promise.all(
          items
            .filter((item) => item.name === 'Recovery.png' && !item.personalOwnerId)
            .map(async (item) => {
              const blob = blobs.find((record) => record.id === item.url.slice(5))
              return {
                expiresAt: item.expiresAt,
                bytes: Array.from(new Uint8Array(await blob.blob.arrayBuffer()))
              }
            })
        )
        return {
          personal: items.filter((item) => item.name === 'Recovery.png' && item.personalOwnerId)
            .length,
          outbox: operations.length,
          backups
        }
      } finally {
        db.close()
      }
    })
  expect(await readState()).toEqual({ personal: 1, outbox: 1, backups: [] })
  await recover()
  await expect(action).toHaveCount(0)
  expect(await readState()).toEqual({
    personal: 0,
    outbox: 0,
    backups: [{ expiresAt: null, bytes: Array.from(png) }]
  })
  await page.reload()
  expect(await readState()).toEqual({
    personal: 0,
    outbox: 0,
    backups: [{ expiresAt: null, bytes: Array.from(png) }]
  })
})
