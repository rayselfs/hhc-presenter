import { test } from '@playwright/test'
import { runPptxSourceSmoke } from './helpers/pptx-source-smoke'

test('preserves original hymn source through edit, copy, undo, projection and reopen', async ({
  page,
  context
}) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await runPptxSourceSmoke(page, () => context.waitForEvent('page'))
})
