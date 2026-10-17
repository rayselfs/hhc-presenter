import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

const verses = [
  { id: 4300316, number: 16, text: '神愛世人，甚至將他的獨生子賜給他們。' },
  { id: 4300317, number: 17, text: '因為神差他的兒子降世，不是要定世人的罪。' },
  { id: 4300318, number: 18, text: '信他的人，不被定罪。' }
]

test('a real Bible Worker searches Chinese text and projects the selected and next verse', async ({
  page,
  context
}) => {
  const workers: string[] = []
  const errors: string[] = []
  let contentRequests = 0
  page.on('worker', (worker) => workers.push(worker.url()))
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await context.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  await context.route('**/api/bible/v2/versions', (route) =>
    route.fulfill({
      json: [{ id: 1, code: 'CUV', name: 'Fixture Chinese', locale: 'zh-TW', updatedAt: 1 }]
    })
  )
  await context.route('**/api/bible/v1/content/1', (route) => {
    contentRequests++
    const events = [
      { type: 'start' },
      { version_id: 1, version_code: 'CUV', version_name: 'Fixture Chinese' },
      {
        id: 43,
        number: 43,
        name: '約翰福音',
        abbreviation: '約',
        chapters: [{ number: 3, verses }]
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
  await page.getByRole('link', { name: /Bible|聖經|圣经/i }).click()
  const search = page.getByTestId('bible-search-bar')
  await expect(search.getByRole('button')).toBeEnabled()
  await search.getByRole('button').click()
  await search.locator('[data-bible-search]').fill('神愛世人')
  await search.locator('[data-bible-search]').press('Enter')
  const result = page.getByRole('button', { name: /神愛世人/ })
  await expect(result).toHaveCount(1)
  await expect(page.getByRole('button', { name: /不是要定世人的罪/ })).toHaveCount(0)
  expect(workers.some((url) => /bible-search\.worker[^/]*\.js/.test(url))).toBe(true)
  expect(contentRequests).toBe(1)
  await result.click()

  const opened = context.waitForEvent('page')
  await page.locator('[data-verse-number="16"]').click()
  const audience = await opened
  const projection = audience.getByTestId('bible-projection')
  await expect(projection).toContainText(verses[0].text)
  const reference = projection.locator(':scope > div').first()
  await expect(reference).toContainText('3:16')
  await page.keyboard.press('ArrowDown')
  await expect(reference).toContainText('3:17')
  await expect(projection.locator('[data-verse="17"]')).toContainText(verses[1].text)
  expect(errors).toEqual([])
})
