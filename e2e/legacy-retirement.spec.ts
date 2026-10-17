import { test } from '@playwright/test'
import { verifyLegacyRetirement } from './helpers/legacy-retirement'

test('retired Service and Soundboard stay dormant while legacy URLs and shared assets remain usable', async ({
  page
}) => {
  await page.goto('/')
  await verifyLegacyRetirement(page)
})
