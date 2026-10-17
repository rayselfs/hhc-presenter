import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('Bible folder paste rejects descendants and retains the clipboard for a valid copy', async ({
  page,
  context
}) => {
  await context.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  await context.route('**/api/bible/v2/versions', (route) => route.fulfill({ json: [] }))
  await page.goto('/')
  await completeOnboarding(page)
  await page.evaluate(async () => {
    const request = indexedDB.open('hhc-bible')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['folder-records', 'folder-items'], 'readwrite')
    const base = { createdAt: Date.now(), expiresAt: null, sortIndex: 0 }
    tx.objectStore('folder-records').put({
      ...base,
      id: 'source',
      name: 'Source',
      parentId: 'bible-root'
    })
    tx.objectStore('folder-records').put({
      ...base,
      id: 'child',
      name: 'Child',
      parentId: 'source'
    })
    tx.objectStore('folder-items').put({
      ...base,
      id: 'verse',
      parentId: 'child',
      type: 'verse',
      versionId: 1,
      bookNumber: 1,
      chapter: 1,
      verse: 1,
      text: 'Copied verse'
    })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.goto('/#/bible')
  await page.reload()
  await page.getByRole('tab', { name: /Custom|自訂|自定义/ }).click()
  const source = page.getByRole('option').filter({ hasText: 'Source' })
  await source.click()
  await page.keyboard.press('ControlOrMeta+c')
  await source.dblclick()
  await page.getByRole('option').filter({ hasText: 'Child' }).dblclick()
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByText('Cannot copy a folder into itself', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: /Home|首頁|首页/ }).click()
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByRole('option').filter({ hasText: 'Source 2' })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('hhc-bible')
        const db = await new Promise<IDBDatabase>((resolve) => {
          request.onsuccess = () => resolve(request.result)
        })
        const tx = db.transaction(['folder-records', 'folder-items'])
        const folders = tx.objectStore('folder-records').getAll()
        const items = tx.objectStore('folder-items').getAll()
        const values = await Promise.all([
          new Promise<number>((resolve) => {
            folders.onsuccess = () => resolve(folders.result.length)
          }),
          new Promise<number>((resolve) => {
            items.onsuccess = () => resolve(items.result.length)
          })
        ])
        db.close()
        return values
      })
    )
    .toEqual([5, 2])
})
