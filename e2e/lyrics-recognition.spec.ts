import { test, expect } from '@playwright/test'
import { completeOnboarding } from './helpers'
import {
  installLyricsFixture,
  setFixture,
  setLyricsMode,
  verifyLyricsWorkflow
} from './helpers/lyrics-fixtures'
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

test.describe('CPU fallback', () => {
  test.use({ serviceWorkers: 'block' })
  test('recognizes all rows with CPU fallback when WebGPU is unavailable', async ({ page }) => {
    test.setTimeout(90000)
    await page.context().route('**/lyrics-runtime/ocr-worker.js', async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body:
          'Object.defineProperty(self.navigator, "gpu", { value: undefined });\n' +
          (await response.text())
      })
    })
    await installLyricsFixture(page)
    await page.goto('/')
    await completeOnboarding(page)
    await page.goto('/#/camera')
    await page.getByTestId('camera-source-selector').click()
    await page.getByRole('option').first().click()
    const initialized = page.waitForEvent('console', {
      predicate: (message) => message.text().startsWith('[lyrics] OCR initialized')
    })
    await setLyricsMode(page, true)
    const runtime = (await initialized).text()
    expect(runtime).toContain('"detProvider":"wasm"')
    expect(runtime).toContain('"recProvider":"wasm"')
    const lines = ['祂從災難中保護我們', '堅定腳步走過每一天', '在樹蔭邊彼此扶持']
    const popup = page.context().waitForEvent('page')
    await page.getByRole('button', { name: 'Present source', exact: true }).click()
    const projection = await popup
    await setFixture(page, 'bright', lines)
    await expect
      .poll(() => projection.getByTestId('lyrics-line').allTextContents(), { timeout: 40000 })
      .toEqual(lines)
    await setLyricsMode(page, false)
    await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toBeVisible()
  })
})

test('remembers the subtitle preference across navigation and reload', async ({ page }) => {
  await installLyricsFixture(page)
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/camera')
  await page.getByTestId('camera-source-selector').click()
  await page.getByRole('option').first().click()
  await setLyricsMode(page, true)
  await page.goto('/#/files')
  await page.goto('/#/camera')
  await expect(page.getByRole('switch', { name: 'Lyrics subtitles', exact: true })).toBeChecked()
  await page.reload()
  await expect(page.getByRole('switch', { name: 'Lyrics subtitles', exact: true })).toBeChecked()
  await setLyricsMode(page, false)
  await page.reload()
  await expect(
    page.getByRole('switch', { name: 'Lyrics subtitles', exact: true })
  ).not.toBeChecked()
})
