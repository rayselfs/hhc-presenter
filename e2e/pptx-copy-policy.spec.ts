import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { expect, test } from '@playwright/test'
import { completeOnboarding, seedRawPptx } from './helpers'

test('unsupported PPTX stays original after upload and Edit a copy rejection', async ({ page }) => {
  const zip = await JSZip.loadAsync(
    await readFile('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx')
  )
  const path = 'ppt/slides/slide1.xml'
  zip.file(
    path,
    (await zip.file(path)!.async('string')).replace(
      '</p:sld>',
      '<p:timing><p:tnLst/></p:timing></p:sld>'
    )
  )
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  const id = await seedRawPptx(page, 'Animated.pptx', buffer)
  await page.goto(`/#/presentations/${id}`)
  await page.getByRole('button', { name: /^Edit a copy$|^編輯副本$/ }).click()
  const failure =
    'Slide 1: PowerPoint animation is not supported for editable import yet. Open the original PPTX to view it; the source file has not been changed.'
  await expect(page.getByText(failure, { exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/presentations/${id}$`))
  await page.goto('/#/files')
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({
    name: 'Animated.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer
  })
  await expect(page.getByText('Animated.lpdeck', { exact: true })).toHaveCount(0)
  await expect(page.getByText(`Animated.pptx: ${failure}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Animated.pptx', exact: true })).toBeVisible()
  const records = await page.evaluate(async (id) => {
    const request = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['folder-items', 'file-blobs', 'presentation-drafts'], 'readonly')
    const read = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const [items, blobs, drafts, source] = await Promise.all([
      read(tx.objectStore('folder-items').getAllKeys()),
      read(tx.objectStore('file-blobs').getAllKeys()),
      read(tx.objectStore('presentation-drafts').count()),
      read(tx.objectStore('file-blobs').get(id))
    ])
    db.close()
    return { items, blobs, drafts, bytes: [...new Uint8Array(await source.blob.arrayBuffer())] }
  }, id)
  expect(records).toEqual({ items: [id], blobs: [id], drafts: 0, bytes: [...buffer] })
})
