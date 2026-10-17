import { expect, type Page } from '@playwright/test'
import { completeOnboarding } from '../helpers'

export async function verifyLegacyRetirement(page: Page): Promise<void> {
  await completeOnboarding(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const pageCount = page.context().pages().length
  const profile = await page.evaluate(async () => {
    const sourceId = 'legacy-shared-source'
    const bytes = Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      ),
      (character) => character.charCodeAt(0)
    )
    const cue = {
      id: 'legacy-cue',
      type: 'media',
      title: 'Legacy cue',
      completed: false,
      fileItemId: sourceId,
      fileName: 'Legacy shared image.png',
      createdAt: 1,
      updatedAt: 1
    }
    const legacy = JSON.stringify({
      state: {
        cues: [cue, { ...cue, id: 'missing-cue', fileItemId: 'missing-source' }],
        currentCueId: cue.id,
        selectedCueId: cue.id,
        previewCueId: cue.id
      },
      version: 0
    })
    localStorage.setItem('hhc-service-playlist', legacy)
    const request = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const tx = db.transaction(['folder-items', 'file-blobs'], 'readwrite')
    tx.objectStore('folder-items').put({
      id: sourceId,
      parentId: 'file-root',
      type: 'file',
      name: cue.fileName,
      mimeType: blob.type,
      url: `blob:${sourceId}`,
      size: blob.size,
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    })
    tx.objectStore('file-blobs').put({
      id: sourceId,
      blob,
      storage: 'indexed-db',
      revision: 0,
      refCount: 1,
      size: blob.size
    })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
    return { legacy, bytes }
  })
  await page.addInitScript(() => {
    const accesses: string[] = []
    Reflect.set(window, '__legacyStorageAccesses', accesses)
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = function (key: string): string | null {
      if (key === 'hhc-service-playlist') accesses.push(`get:${key}`)
      return getItem.call(this, key)
    }
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'hhc-service-playlist') accesses.push(`set:${key}`)
      setItem.call(this, key, value)
    }
  })
  await page.reload()
  await expect(page.getByTestId('btn-start')).toBeVisible()
  const baseURL = page.url().split('#')[0]
  for (const path of ['/service', '/soundboard']) {
    await page.goto(`${baseURL}#${path}`)
    await expect(page).toHaveURL(/#\/timer$/)
    await expect(page.getByTestId('btn-start')).toBeVisible()
  }
  await expect(page.getByRole('link', { name: 'SERVICE', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'SOUNDBOARD', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'FILES', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Legacy shared image.png', exact: true })
  ).toBeVisible()
  const stored = await page.evaluate(async () => {
    const accesses = [...(Reflect.get(window, '__legacyStorageAccesses') as string[])]
    const legacy = localStorage.getItem('hhc-service-playlist')
    const request = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const source = await new Promise<{ blob: Blob }>((resolve, reject) => {
      const read = db
        .transaction('file-blobs')
        .objectStore('file-blobs')
        .get('legacy-shared-source')
      read.onsuccess = () => resolve(read.result)
      read.onerror = () => reject(read.error)
    })
    db.close()
    const bytes = Array.from(new Uint8Array(await source.blob.arrayBuffer()))
    return { accesses, legacy, bytes }
  })
  expect(stored.accesses).toEqual([])
  expect(stored.legacy).toBe(profile.legacy)
  expect(stored.bytes).toEqual(profile.bytes)
  expect(page.context().pages()).toHaveLength(pageCount)
  expect(errors).toEqual([])
}
