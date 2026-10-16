import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('rejects unsupported insertions without changing saved bytes and exports the original', async ({
  page
}) => {
  const recoveryGuide = await readFile('docs/operations/presentation-image-recovery.md', 'utf8')
  const exportScript = recoveryGuide.match(/```js\n([\s\S]*?)\n```/)![1]
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await page.getByLabel('New', { exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create Presentation', exact: true }).click()
  await expect(page).toHaveURL(/#\/presentations\//)
  const itemId = decodeURIComponent(page.url().split('/').at(-1)!)
  const readSource = (): Promise<{ body: string; revision?: number }> =>
    page.evaluate(async (id) => {
      const result = <T>(request: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const db = await result(indexedDB.open('hhc-file-explorer'))
      try {
        const tx = db.transaction(['folder-items', 'file-blobs'], 'readonly')
        const item = await result(tx.objectStore('folder-items').get(id))
        const record = await result(tx.objectStore('file-blobs').get(item.url.slice(5)))
        return { body: await record.blob.text(), revision: record.revision }
      } finally {
        db.close()
      }
    }, itemId)
  const before = await readSource()
  const input = page.locator('input[accept*="image/png"]')
  for (const mimeType of ['image/svg+xml', 'image/avif']) {
    await input.setInputFiles({ name: 'Unsupported', mimeType, buffer: Buffer.from('<svg/>') })
    await expect(
      page.getByText('Use a PNG, JPEG, GIF, BMP or WebP image no larger than 20 MiB').first()
    ).toBeVisible()
    expect(await readSource()).toEqual(before)
    await expect(page.locator('.presentation-stage [data-slide-element]')).toHaveCount(0)
  }
  const download = page.waitForEvent('download')
  await page.evaluate(
    `(async () => {${exportScript.replace('REPLACE_WITH_AFFECTED_ITEM_ID', itemId)}})()`
  )
  const saved = await download
  expect(await readFile((await saved.path())!, 'utf8')).toBe(before.body)
  expect(await readSource()).toEqual(before)

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZaoAAAAASUVORK5CYII=',
    'base64'
  )
  await input.setInputFiles({ name: 'Valid.png', mimeType: 'image/png', buffer: png })
  await expect(page.locator('.presentation-stage [data-slide-element]')).toHaveCount(1)
  await expect.poll(async () => JSON.parse((await readSource()).body).assets).not.toEqual({})
  const savedBody = await readSource()
  await page.reload()
  await expect(page.locator('.presentation-stage [data-slide-element]')).toHaveCount(1)
  expect(await readSource()).toEqual(savedBody)
})
