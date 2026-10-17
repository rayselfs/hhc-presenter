import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('a failed cut paste retains its clipboard and waits for durable retry before showing the moved file', async ({
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
    const tx = db.transaction(['folder-records', 'folder-items', 'file-blobs'], 'readwrite')
    tx.objectStore('folder-records').put({
      id: 'move-target',
      name: 'Move target',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    })
    tx.objectStore('folder-items').put({
      id: 'move-file',
      name: 'Move.txt',
      parentId: 'file-root',
      type: 'file',
      url: 'blob:move-file',
      mimeType: 'text/plain',
      size: 3,
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    })
    tx.objectStore('file-blobs').put({
      id: 'move-file',
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
  const file = page.locator('[data-item-id="move-file"]').first()
  await expect(file).toBeVisible()
  await file.click()
  await page.keyboard.press('ControlOrMeta+x')
  await page.locator('[data-item-id="move-target"]').first().dblclick()
  await expect(file).toHaveCount(0)
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    let attempt = 0
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
        value.id === 'move-file' &&
        'parentId' in value &&
        value.parentId === 'move-target'
      ) {
        request.addEventListener(
          'success',
          () => {
            attempt++
            if (attempt === 1) {
              document.documentElement.dataset.moveAborts = '1'
              this.transaction.abort()
              return
            }
            IDBObjectStore.prototype.put = originalPut
            document.documentElement.dataset.movePending = '1'
            const keepAlive = (): void => {
              if (document.documentElement.dataset.releaseMove === '1') return
              this.get('move-file').onsuccess = keepAlive
            }
            keepAlive()
          },
          { once: true }
        )
      }
      return request
    }
  })
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.locator('html')).toHaveAttribute('data-move-aborts', '1')
  await expect(page.getByText(/aborted|AbortError/i).first()).toBeVisible()
  await expect(file).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.locator('html')).toHaveAttribute('data-move-pending', '1')
  await expect(file).toHaveCount(0)
  await page.evaluate(() => {
    document.documentElement.dataset.releaseMove = '1'
  })
  await expect(file).toBeVisible()
  await page.reload()
  await page.locator('[data-item-id="move-target"]').first().dblclick()
  await expect(file).toBeVisible()
  expect(
    await page.evaluate(async () => {
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
        const [item, blob] = await Promise.all([
          read(tx.objectStore('folder-items').get('move-file')),
          read(tx.objectStore('file-blobs').get('move-file'))
        ])
        return { parentId: item.parentId, size: blob.blob.size, refs: blob.refCount }
      } finally {
        db.close()
      }
    })
  ).toEqual({ parentId: 'move-target', size: 3, refs: 1 })
})
