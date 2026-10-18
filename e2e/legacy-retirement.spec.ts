import { test } from '@playwright/test'
import { verifyLegacyRetirement } from './helpers/legacy-retirement'

for (const width of [1280, 1000]) {
  test(`retired Service and Soundboard stay dormant while legacy URLs and shared assets remain usable at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 768 })
    await page.goto('/')
    await verifyLegacyRetirement(page)
  })
}
