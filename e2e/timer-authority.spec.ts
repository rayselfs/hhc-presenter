import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test.beforeEach(async ({ context, page }) => {
  await context.route('**/api/bible/v2/versions', (route) => route.fulfill({ json: [] }))
  await context.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  await page.goto('/')
  await completeOnboarding(page)
})

test('the real Worker stops at zero and restarts the configured countdown', async ({
  page,
  context
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.timer-digits').first().click()
  const input = page.getByRole('textbox').filter({ visible: true })
  await input.fill('3s')
  await input.press('Enter')
  const opened = context.waitForEvent('page')
  await page.getByTestId('btn-start').click()
  const projection = await opened
  await expect(page.getByTestId('btn-start')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.timer-digits').first()).toHaveText('00:00')
  await expect(projection.locator('.timer-digits').first()).toHaveText('00:00')
  await page.getByTestId('btn-start').click()
  await expect(page.getByTestId('btn-pause')).toBeVisible()
  await expect(page.locator('.timer-digits').first()).not.toHaveText('00:00')
  await page.getByTestId('btn-reset').click()
  await expect(page.locator('.timer-digits').first()).toHaveText('00:03')
  expect(errors).toEqual([])
})

test('the real Worker owns stopwatch pause, resume and reset', async ({ page }) => {
  const display = page.getByTestId('stopwatch-display')
  await page.getByTestId('mode-stopwatch').click()
  await expect(display).toHaveText('00:00')
  await page.getByTestId('btn-start').click()
  await expect(display).not.toHaveText('00:00')
  await page.getByTestId('btn-pause').click()
  await expect(page.getByTestId('btn-resume')).toBeVisible()
  const paused = await display.textContent()
  await page.waitForTimeout(1200)
  await expect(display).toHaveText(paused!)
  await page.getByTestId('btn-resume').click()
  await expect(display).not.toHaveText(paused!)
  await page.getByTestId('btn-reset').click()
  await expect(display).toHaveText('00:00')
  await expect(page.getByTestId('btn-start')).toBeVisible()
})
