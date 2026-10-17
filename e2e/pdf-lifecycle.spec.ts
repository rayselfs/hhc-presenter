import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'
import { multiPagePdf } from './helpers/pdf-fixtures'

async function expectSinglePage(page: Page, selector: string, number: number): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate((canvas: HTMLCanvasElement) => {
          return canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1)
            .data[0]
        })
    )
    .toBe(Math.round((number / 40) * 255))
}

test('keeps a real 40-page PDF synchronized through navigation, continuous scrolling and remount', async ({
  page,
  context
}) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles({
      name: 'Forty pages.pdf',
      mimeType: 'application/pdf',
      buffer: multiPagePdf(40)
    })
  await expect(page.getByText('Forty pages.pdf')).toBeVisible()
  let delayedWorkers = 0
  await context.route('**/*pdf.worker*', async (route) => {
    delayedWorkers++
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await route.continue()
  })
  const opened = context.waitForEvent('page')
  await page.getByText('Forty pages.pdf').dblclick()
  const projection = await opened
  const operatorCanvas = '.presenter-preview-stage canvas'
  await expectSinglePage(page, operatorCanvas, 1)
  await page.getByRole('img', { name: 'page 17', exact: true }).click()
  await expectSinglePage(page, operatorCanvas, 17)
  await expectSinglePage(projection, 'canvas', 17)
  expect(delayedWorkers).toBeGreaterThan(0)
  // Rapid real button input exercises overlapping PDF.js render work.
  const next = page.getByRole('button', { name: 'Next page', exact: true }).first()
  for (let i = 0; i < 4; i++) await next.click()
  await expectSinglePage(page, operatorCanvas, 21)
  await expectSinglePage(projection, 'canvas', 21)
  await projection.reload()
  await expectSinglePage(projection, 'canvas', 21)
  await page.evaluate(() => {
    location.hash = '#/files'
  })
  await expect(page).toHaveURL(/#\/files$/)
  await page.evaluate(() => {
    location.hash = '#/media'
  })
  await expectSinglePage(page, operatorCanvas, 21)
  await page.getByRole('button', { name: 'Continuous pages', exact: true }).first().click()
  const target = page.locator('canvas[data-page-index="26"]')
  await expect(target).toBeAttached()
  await target.evaluate((canvas) => {
    canvas.parentElement!.scrollTop = (canvas as HTMLElement).offsetTop + canvas.clientHeight * 0.3
  })
  await expect(projection.locator('[data-pdf-canvas-host="27"] canvas')).toBeAttached()
  const before = await projection.locator('[data-pdf-canvas-host="27"]').boundingBox()
  expect(before).not.toBeNull()
  await projection.reload()
  await expect(projection.locator('[data-pdf-canvas-host="27"] canvas')).toBeAttached()
  await expect
    .poll(async () => (await projection.locator('[data-pdf-canvas-host="27"]').boundingBox())?.y)
    .toBeLessThan(0)
  await expect
    .poll(async () => {
      const after = await projection.locator('[data-pdf-canvas-host="27"]').boundingBox()
      return Math.abs((after?.y ?? Infinity) - before!.y)
    })
    .toBeLessThan(4)
  await page.evaluate(() => {
    location.hash = '#/files'
  })
  await expect(page).toHaveURL(/#\/files$/)
  await page.evaluate(() => {
    location.hash = '#/media'
  })
  await expect(page.getByRole('button', { name: 'Single page', exact: true })).toBeVisible()
  await expect
    .poll(() =>
      page
        .locator('canvas[data-page-index="26"]')
        .evaluate((canvas) => canvas.parentElement!.scrollTop)
    )
    .toBeGreaterThan(5000)
})
