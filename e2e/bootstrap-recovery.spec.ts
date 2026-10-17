import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('retries a failed initial IndexedDB open and reaches the control workspace', async ({
  page,
  context
}) => {
  await context.route('**/api/bible/v2/versions', (route) => route.fulfill({ json: [] }))
  await context.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB)
    let failOnce = true
    indexedDB.open = (name, version) => {
      if (name === 'hhc-file-explorer' && failOnce) {
        failOnce = false
        throw new DOMException('Synthetic initial open failure', 'UnknownError')
      }
      return open(name, version)
    }
  })
  await page.goto('/')
  await completeOnboarding(page)
  await expect(page.getByText('Synthetic initial open failure')).toBeVisible()
  await page.getByRole('button', { name: /Retry|重試|重试/ }).click()
  await expect(page.getByTestId('btn-start')).toBeVisible()
  await expect(page.getByText('Synthetic initial open failure')).not.toBeVisible()
})
