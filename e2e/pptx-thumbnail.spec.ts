import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { completeOnboarding } from './helpers'

test('imports a real PPTX as one editable deck with a cover thumbnail', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')

  const fixture = resolve('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx')
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(fixture)

  await expect(page.getByText('text-placeholder-layout.lpdeck', { exact: true })).toBeVisible()
  await expect(page.getByText('text-placeholder-layout.pptx', { exact: true })).toHaveCount(0)
  await expect(page.getByText('text-placeholder-layout.lpdeck', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('img', { name: 'text-placeholder-layout.lpdeck' })).toBeVisible()
})
