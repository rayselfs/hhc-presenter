import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('a local copy keeps its bytes when the sync cache is replaced and removed', async ({
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
      id: 'sync-copy-root',
      parentId: 'file-root',
      name: 'Snapshot source',
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'snapshot-test',
        remoteFolderId: 'remote',
        providerType: 'local-fs'
      }
    })
    const blob = new Blob(['Original snapshot'], { type: 'text/plain' })
    tx.objectStore('folder-items').put({
      id: 'sync-copy-source',
      parentId: 'sync-copy-root',
      type: 'file',
      name: 'Snapshot.txt',
      mimeType: 'text/plain',
      size: blob.size,
      url: 'blob:sync-copy-source',
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    })
    tx.objectStore('file-blobs').put({ id: 'sync-copy-source', blob, refCount: 1 })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.goto('/#/files')
  await page.reload()
  await page.getByText('Snapshot source', { exact: true }).dblclick()
  await page.getByText('Snapshot.txt', { exact: true }).click()
  await page.keyboard.press('ControlOrMeta+c')
  await page
    .getByRole('navigation', { name: /Folder path|資料夾路徑|文件夹路径/ })
    .getByRole('button')
    .first()
    .click()
  await expect(page.getByText('Snapshot source', { exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByText('Snapshot.txt', { exact: true })).toBeVisible()
  const content = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hhc-file-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['folder-items', 'file-blobs'], 'readwrite')
    const items = await new Promise<
      Array<{ id: string; parentId: string; url: string; name: string }>
    >((resolve) => {
      const request = tx.objectStore('folder-items').getAll()
      request.onsuccess = () => resolve(request.result)
    })
    const copy = items.find(
      (item) => item.parentId === 'file-root' && item.name === 'Snapshot.txt'
    )!
    tx.objectStore('file-blobs').put({
      id: 'sync-copy-source',
      blob: new Blob(['Replacement']),
      refCount: 1
    })
    tx.objectStore('file-blobs').delete('sync-copy-source')
    const record = await new Promise<{ blob: Blob } | undefined>((resolve) => {
      const request = tx.objectStore('file-blobs').get(copy.url.slice(5))
      request.onsuccess = () => resolve(request.result)
    })
    db.close()
    return record?.blob.text()
  })
  expect(content).toBe('Original snapshot')
})
