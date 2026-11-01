import { test } from '@playwright/test'
import { completeOnboarding } from './helpers'
import { installLyricsFixture, verifyLyricsWorkflow } from './helpers/lyrics-fixtures'
test.use({
  launchOptions: {
    channel: 'chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  },
  permissions: ['camera']
})
test('recognizes picture backgrounds and preserves all rows through subtitle projection', async ({
  page,
  context
}, testInfo) => {
  test.setTimeout(300000)
  await installLyricsFixture(page)
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/camera')
  await verifyLyricsWorkflow(page, testInfo, () => context.waitForEvent('page'))
})
