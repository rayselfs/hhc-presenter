import { expect, type Page } from '@playwright/test'

export async function completeOnboarding(page: Page): Promise<void> {
  await expect(page).toHaveURL(/#\/(welcome|timer)$/)
  if (!page.url().endsWith('#/welcome')) return

  await page
    .getByTestId('welcome-page')
    .getByRole('button', { name: /Get Started|開始使用|开始使用/ })
    .click()
  await expect(page).toHaveURL(/#\/timer$/)
}

// Keep legacy renderer coverage separate from the editable PPTX upload flow.
export async function seedRawPptx(page: Page, name: string, buffer: Buffer): Promise<string> {
  await expect(page.locator('input[type="file"]:not([webkitdirectory])').first()).toBeAttached()
  const id = await page.evaluate(
    async ({ name, bytes }) => {
      const request = indexedDB.open('hhc-file-explorer')
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const id = crypto.randomUUID()
      const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType })
      const tx = db.transaction(['folder-items', 'file-blobs'], 'readwrite')
      tx.objectStore('folder-items').put({
        id,
        parentId: 'file-root',
        type: 'file',
        name,
        mimeType,
        url: `blob:${id}`,
        size: blob.size,
        sortIndex: 0,
        createdAt: Date.now(),
        expiresAt: null
      })
      tx.objectStore('file-blobs').put({
        id,
        blob,
        storage: 'indexed-db',
        refCount: 1,
        revision: 0,
        size: blob.size
      })
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
      db.close()
      return id
    },
    { name, bytes: [...buffer] }
  )
  await page.reload()
  return id
}
