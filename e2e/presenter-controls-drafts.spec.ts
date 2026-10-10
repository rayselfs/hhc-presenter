import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { completeOnboarding, seedRawPptx } from './helpers'

test('a readonly PPTX copy stays recoverable and unsaved until a writable destination is chosen', async ({
  page,
  context
}) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await seedRawPptx(
    page,
    'text-placeholder-layout.pptx',
    await readFile(resolve('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'))
  )
  await expect(page.getByText('text-placeholder-layout.pptx')).toBeVisible()
  const sourceId = await page.evaluate(async () => {
    const request = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((done) => {
      request.onsuccess = () => done(request.result)
    })
    const tx = db.transaction(['folder-items', 'folder-records'], 'readwrite')
    const items = tx.objectStore('folder-items').getAll()
    const source = await new Promise<{ id: string; parentId: string }>((done) => {
      items.onsuccess = () =>
        done(items.result.find((entry) => entry.name === 'text-placeholder-layout.pptx'))
    })
    tx.objectStore('folder-records').put({
      id: 'readonly',
      name: 'Read only sync',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: { providerType: 'local-fs', providerConnectionId: 'test', remoteFolderId: 'test' }
    })
    tx.objectStore('folder-items').put({ ...source, parentId: 'readonly' })
    await new Promise<void>((done) => {
      tx.oncomplete = () => done()
    })
    db.close()
    return source.id
  })
  await page.goto(`/#/presentations/${sourceId}`)
  await page.reload()
  await page.getByRole('button', { name: /^Edit a copy$|^編輯副本$/ }).click()
  await expect(page.getByRole('button', { name: /^Save$|^儲存$/ })).toBeVisible()
  const draftUrl = page.url()
  await page.reload()
  await expect(page.getByRole('button', { name: /^Save$|^儲存$/ })).toBeVisible()
  const projectionPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: /^Start projection$|^開始投影$/ }).click()
  const projection = await projectionPromise
  await expect(projection.locator('[data-editable-projection-frame]')).toBeVisible()
  await page.getByTestId('media-back-to-files').click()
  await page.goto(draftUrl)
  await expect(page.getByRole('button', { name: /^Save$|^儲存$/ })).toBeVisible()
  await page
    .getByRole('button', { name: /^Close tab$|^關閉分頁$/ })
    .last()
    .click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: /Keep editing|繼續編輯/ }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+s')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('option', { hasText: 'Read only sync' })).toHaveCount(0)
  await dialog.getByRole('button', { name: /Cancel|取消/ }).click()
  await expect(page).toHaveURL(draftUrl)
  await page.getByRole('button', { name: /^Save$|^儲存$/ }).click()
  await dialog.getByRole('textbox').fill('Saved copy')
  await dialog.getByRole('button', { name: /^Save$|^儲存$/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Save$|^儲存$/ })).toHaveCount(0)
  await expect(page.getByText('Saved copy', { exact: true })).toBeVisible()
})
