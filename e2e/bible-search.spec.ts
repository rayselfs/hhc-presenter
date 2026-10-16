import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

const versions = [1, 2, 3].map((id) => ({
  id,
  code: `fixture-${id}`,
  name: `Fixture ${id}`,
  locale: 'zh-TW',
  updatedAt: 1
}))
const words = ['恩典', '盼望', '喜樂']

test('three cold Bible indexes stay isolated through version switching and reload', async ({
  page,
  context
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await context.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  await context.route('**/api/bible/v2/versions', (route) => route.fulfill({ json: versions }))
  await context.route('**/api/bible/v1/content/*', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const events = [
      { type: 'start' },
      {
        id: 1,
        number: 1,
        name: 'Genesis',
        abbreviation: 'Gen',
        chapters: [
          {
            number: 1,
            verses: [
              { id: id * 100 + 1, number: 1, text: `${words[id - 1]}充滿生命` },
              { id: id * 100 + 2, number: 2, text: `${words[id - 1]}直到永遠` }
            ]
          }
        ]
      },
      { type: 'complete', total_books: 1 }
    ]
    return route.fulfill({
      contentType: 'text/event-stream',
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    })
  })
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/bible')
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('hhc-bible')
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const count = db.transaction('flexsearch').objectStore('flexsearch').count()
        const value = await new Promise<number>((resolve) => {
          count.onsuccess = () => resolve(count.result)
        })
        db.close()
        return value
      })
    )
    .toBe(3)

  for (const version of [2, 3, 1]) {
    await page
      .getByRole('button', { name: /Select Bible version|選擇聖經版本|选择圣经版本/ })
      .click()
    await page.getByRole('option', { name: `Fixture ${version}`, exact: true }).click()
    await page.getByTestId('bible-search-bar').getByRole('button').click()
    await page.locator('[data-bible-search]').fill(words[version - 1])
    await page.locator('[data-bible-search]').press('Enter')
    await expect(
      page.getByRole('button').filter({ hasText: `${words[version - 1]}充滿生命` })
    ).toBeVisible()
  }
  await page.reload()
  await page.getByTestId('bible-search-bar').getByRole('button').click()
  await page.locator('[data-bible-search]').fill(words[0])
  await page.locator('[data-bible-search]').press('Enter')
  await page
    .getByRole('button')
    .filter({ hasText: `${words[0]}充滿生命` })
    .click()
  const popup = context.waitForEvent('page')
  await page.locator('[data-verse-number="1"]').click()
  const projection = await popup
  await expect(projection.getByText(`${words[0]}充滿生命`, { exact: true })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(projection.getByText(`${words[0]}直到永遠`, { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
