import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('date groups preserve days, persist disabled grouping, and support extra-large icons', async ({
  page
}) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.evaluate(async () => {
    const open = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const tx = db.transaction('folder-items', 'readwrite')
    for (let index = 0; index < 6; index++) {
      tx.objectStore('folder-items').put({
        id: `date-fixture-${index}`,
        parentId: 'file-root',
        type: 'file',
        name: `Date fixture ${index}.txt`,
        url: `blob:date-fixture-${index}`,
        mimeType: 'text/plain',
        size: 0,
        sortIndex: index,
        createdAt: Date.parse(index < 3 ? '2026-09-03T10:00:00Z' : '2026-09-04T10:00:00Z'),
        expiresAt: null
      })
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.reload()
  await page.goto('/#/files')
  await expect(page.locator('[data-file-item][role="button"]')).toHaveCount(6)
  await page.getByRole('button', { name: 'Sort', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Group', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Date', exact: true }).click()
  await expect(page.locator('[data-date-group]')).toHaveText(['2026/09/04', '2026/09/03'])
  const cards = page.locator('[data-file-item][role="button"]')
  const initialOrder = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-item-id'))
  )
  const firstCard = await cards.nth(0).boundingBox()
  const otherDay = await cards.nth(4).boundingBox()
  if (!firstCard || !otherDay) throw new Error('Grouped cards are not visible')
  await page.mouse.move(firstCard.x + 32, firstCard.y + 32)
  await page.mouse.down()
  await page.mouse.move(otherDay.x + 32, otherDay.y + 32, { steps: 20 })
  await page.mouse.up()
  await expect
    .poll(() =>
      cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-item-id')))
    )
    .toEqual(initialOrder)
  expect(
    await page.evaluate(() => localStorage.getItem('hhc-file-explorer-custom-order'))
  ).toBeNull()
  await page.getByRole('button', { name: 'View', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Extra Large Icons', exact: true }).click()
  await expect(page.locator('[data-file-item][role="button"]').first()).toHaveCSS('width', '256px')
  await page.getByRole('button', { name: 'View', exact: true }).click()
  await page.getByRole('menuitem', { name: 'List', exact: true }).click()
  await expect(page.locator('[data-date-group]')).toHaveText(['2026/09/04', '2026/09/03'])
  await page.getByRole('button', { name: 'Sort', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Group', exact: true }).hover()
  await page
    .getByRole('menu', { name: 'Group', exact: true })
    .getByRole('menuitem', { name: 'None', exact: true })
    .click()
  await page.reload()
  await expect(page.locator('[data-file-item][role="button"]')).toHaveCount(6)
  await expect(page.locator('[data-date-group]')).toHaveCount(0)
})

test('shares selection across Files paste and Favorites/Trash keyboard actions', async ({
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await completeOnboarding(page)
  await page.evaluate(async () => {
    const request = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction('folder-records', 'readwrite')
    for (let index = 0; index < 4; index++) {
      tx.objectStore('folder-records').put({
        id: `selection-${index}`,
        parentId: 'file-root',
        name: `Selection ${index}`,
        sortIndex: index,
        createdAt: Date.now(),
        expiresAt: null,
        isFavorited: index < 2,
        ...(index >= 2 ? { deletedAt: Date.now(), originalParentId: 'file-root' } : {})
      })
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.reload()
  await page.goto('/#/files')
  const cards = page.locator('[data-file-item][role="button"]')
  const selected = page.locator('[data-file-item].bg-surface')
  await expect(cards).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+a')
  await expect(selected).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+x')
  await page.keyboard.press('ControlOrMeta+v')
  await expect(selected).toHaveCount(0)
  await expect(cards).toHaveCount(2)

  await cards.first().click({ button: 'right' })
  await expect(selected).toHaveCount(1)
  await page.keyboard.press('Escape')
  await cards.first().dblclick()
  await expect(cards).toHaveCount(0)
  await expect(selected).toHaveCount(0)

  for (const route of ['favorites', 'trash']) {
    await page.goto(`/#/${route}`)
    await expect(page.locator('[data-file-item]')).toHaveCount(2)
    await page.locator('[data-file-item]').first().click()
    await expect(selected).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+a')
    await expect(selected).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(selected).toHaveCount(0)
  }
  expect(errors).toEqual([])
})
