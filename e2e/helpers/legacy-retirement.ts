import { expect, type Page } from '@playwright/test'
import { completeOnboarding } from '../helpers'

export async function verifyLegacyRetirement(page: Page): Promise<void> {
  await completeOnboarding(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const pageCount = page.context().pages().length
  const newPages: Page[] = []
  page.context().on('page', (opened) => newPages.push(opened))
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
    const audioBytes = new Uint8Array(44 + 16000)
    const header = new DataView(audioBytes.buffer)
    const text = (offset: number, value: string): void => {
      audioBytes.set(new TextEncoder().encode(value), offset)
    }
    text(0, 'RIFF')
    header.setUint32(4, audioBytes.length - 8, true)
    text(8, 'WAVEfmt ')
    header.setUint32(16, 16, true)
    header.setUint16(20, 1, true)
    header.setUint16(22, 1, true)
    header.setUint32(24, 8000, true)
    header.setUint32(28, 16000, true)
    header.setUint16(32, 2, true)
    header.setUint16(34, 16, true)
    text(36, 'data')
    header.setUint32(40, audioBytes.length - 44, true)
    const pad = {
      id: 'legacy-pad',
      label: 'Legacy audio',
      color: '#ef4444',
      asset: {
        assetId: 'legacy-shared-audio',
        name: 'Legacy audio.wav',
        mimeType: 'audio/wav',
        size: audioBytes.length
      },
      triggerMode: 'one-shot',
      loop: false,
      volume: 1,
      midiNote: null,
      midiVolume: null
    }
    const scene = {
      id: 'legacy-scene',
      name: 'Legacy scene',
      pads: {
        [pad.id]: pad,
        'missing-pad': {
          ...pad,
          id: 'missing-pad',
          asset: { ...pad.asset, assetId: 'missing-audio' }
        }
      },
      padOrder: [pad.id, 'missing-pad']
    }
    const board = {
      id: 'legacy-board',
      name: 'Legacy board',
      scenes: { [scene.id]: scene },
      sceneOrder: [scene.id]
    }
    const soundboard = JSON.stringify({
      state: {
        boards: { [board.id]: board },
        boardOrder: [board.id],
        selectedBoardId: board.id,
        selectedSceneId: scene.id,
        mode: 'performance',
        settings: {
          defaultTriggerMode: 'one-shot',
          defaultLoop: false,
          globalFadeMs: 1000,
          masterVolume: 1,
          midiEnabled: true,
          preferredMidiInputId: null
        }
      },
      version: 0
    })
    localStorage.setItem('hhc-service-playlist', legacy)
    localStorage.setItem('hhc-soundboard', soundboard)
    const request = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const tx = db.transaction(['folder-records', 'folder-items', 'file-blobs'], 'readwrite')
    tx.objectStore('folder-records').put({
      id: 'legacy-audio-folder',
      parentId: 'file-root',
      name: 'Legacy audio folder',
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    })
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
    const audioBlob = new Blob([audioBytes], { type: 'audio/wav' })
    tx.objectStore('folder-items').put({
      id: 'legacy-shared-audio',
      parentId: 'legacy-audio-folder',
      type: 'file',
      name: 'Legacy audio.wav',
      mimeType: audioBlob.type,
      url: 'blob:legacy-shared-audio',
      size: audioBlob.size,
      sortIndex: 0,
      createdAt: Date.now(),
      expiresAt: null
    })
    tx.objectStore('file-blobs').put({
      id: 'legacy-shared-audio',
      blob: audioBlob,
      storage: 'indexed-db',
      revision: 0,
      refCount: 1,
      size: audioBlob.size
    })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
    return { legacy, soundboard, bytes, audioBytes: Array.from(audioBytes) }
  })
  await page.addInitScript(() => {
    const keys = new Set(['hhc-service-playlist', 'hhc-soundboard'])
    const accesses: string[] = []
    Reflect.set(window, '__legacyStorageAccesses', accesses)
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = function (key: string): string | null {
      if (keys.has(key)) accesses.push(`get:${key}`)
      return getItem.call(this, key)
    }
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (keys.has(key)) accesses.push(`set:${key}`)
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
  await page.goto(`${baseURL}#/files`)
  await expect(
    page.getByRole('button', { name: 'Legacy shared image.png', exact: true })
  ).toBeVisible()
  const folder = page.getByText('Legacy audio folder', { exact: true })
  await expect(folder).toBeVisible()
  await folder.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByText('This action cannot be undone.', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(folder).toBeVisible()
  await folder.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(folder).toHaveCount(0)
  await page.goto(`${baseURL}#/trash`)
  await expect(folder).toBeVisible()
  const stored = await page.evaluate(async () => {
    const accesses = [...(Reflect.get(window, '__legacyStorageAccesses') as string[])]
    const legacy = localStorage.getItem('hhc-service-playlist')
    const soundboard = localStorage.getItem('hhc-soundboard')
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
    const audio = await new Promise<{ blob: Blob }>((resolve, reject) => {
      const read = db.transaction('file-blobs').objectStore('file-blobs').get('legacy-shared-audio')
      read.onsuccess = () => resolve(read.result)
      read.onerror = () => reject(read.error)
    })
    db.close()
    const audioBytes = Array.from(new Uint8Array(await audio.blob.arrayBuffer()))
    const bytes = Array.from(new Uint8Array(await source.blob.arrayBuffer()))
    return { accesses, legacy, soundboard, bytes, audioBytes }
  })
  expect(stored.accesses).toEqual([])
  expect(stored.legacy).toBe(profile.legacy)
  expect(stored.soundboard).toBe(profile.soundboard)
  expect(stored.audioBytes).toEqual(profile.audioBytes)
  expect(stored.bytes).toEqual(profile.bytes)
  expect(page.context().pages()).toHaveLength(pageCount)
  expect(newPages).toEqual([])
  expect(errors).toEqual([])
}
