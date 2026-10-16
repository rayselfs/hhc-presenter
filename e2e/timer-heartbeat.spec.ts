import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('a real Worker keeps an extended countdown moving past its original deadline', async ({
  page,
  context
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/')
  await completeOnboarding(page)
  await page.locator('.timer-digits').first().click()
  const input = page.getByRole('textbox').filter({ visible: true })
  await input.fill('3s')
  await input.press('Enter')
  const popup = context.waitForEvent('page')
  await page.getByTestId('btn-start').click()
  await page.getByRole('button', { name: '+10', exact: true }).click()
  const projection = await popup
  await expect(page.locator('.timer-digits').first()).toHaveText(/00:0[1-9]/, { timeout: 15_000 })
  await expect(projection.locator('.timer-digits').first()).toHaveText(/00:0[1-9]/)
  await page.getByTestId('btn-pause').click()
  const paused = await page.locator('.timer-digits').first().textContent()
  await page.waitForTimeout(1200)
  await expect(page.locator('.timer-digits').first()).toHaveText(paused!)
  await page.getByTestId('btn-resume').click()
  await expect(page.locator('.timer-digits').first()).not.toHaveText(paused!)
  await page.getByTestId('btn-reset').click()
  await expect(page.locator('.timer-digits').first()).toHaveText('00:03')
  expect(errors).toEqual([])
})
