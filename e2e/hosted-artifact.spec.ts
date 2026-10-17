import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding, seedRawPptx } from './helpers'
import { pageDeck } from './helpers/presentation-fixtures'
import { multiPagePdf } from './helpers/pdf-fixtures'

async function openRawPresentation(page: Page): Promise<void> {
  await page.getByText('Warm deck.pptx', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  await expect(page.locator('[data-pptx-slide-surface] > *').first()).toBeVisible()
}

async function expectPdfPage(page: Page): Promise<void> {
  const canvas = page.locator('canvas').first()
  await expect(canvas).toBeVisible()
  await expect
    .poll(() =>
      canvas.evaluate((canvas: HTMLCanvasElement) => {
        if (!canvas.width || !canvas.height) return null
        return canvas.getContext('2d')?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1)
          .data[0]
      })
    )
    .toBe(128)
}

test('hosted artifact projects and reloads PDF/PPTX with a warm service-worker cache offline', async ({
  page,
  context
}) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await completeOnboarding(page)
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true)
  await page.goto('/#/files')
  await seedRawPptx(page, 'Warm deck.pptx', await pageDeck(2))
  await openRawPresentation(page)
  const firstPopup = context.waitForEvent('page')
  await page.getByRole('button', { name: /Start projection|開始投影/ }).click()
  const warmProjection = await firstPopup
  await expect(warmProjection.getByText('Presenter page 1', { exact: true }).first()).toBeVisible()
  await warmProjection.reload()
  await expect(warmProjection.getByText('Presenter page 1', { exact: true }).first()).toBeVisible()
  await page.goto('/#/files')
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles({
      name: 'Warm pages.pdf',
      mimeType: 'application/pdf',
      buffer: multiPagePdf(2)
    })
  await page.getByText('Warm pages.pdf', { exact: true }).dblclick()
  await expectPdfPage(warmProjection)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const urls = (await (await caches.open('hhc-optional-assets')).keys()).map(
          (request) => request.url
        )
        return (
          urls.some((url) => /pdf.worker-/.test(url)) &&
          urls.some((url) => /aiden0z-pptx-renderer/.test(url))
        )
      })
    )
    .toBe(true)
  await warmProjection.close()
  await page.goto('/#/files')
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText('Warm pages.pdf', { exact: true })).toBeVisible()
  const offlinePopup = context.waitForEvent('page')
  await page.getByText('Warm pages.pdf', { exact: true }).dblclick()
  const projection = await offlinePopup
  await expectPdfPage(projection)
  await projection.reload()
  await expectPdfPage(projection)
  await projection.close()
  await page.goto('/#/files')
  await openRawPresentation(page)
  const offlinePptxPopup = context.waitForEvent('page')
  await page.getByRole('button', { name: /Start projection|開始投影/ }).click()
  const pptxProjection = await offlinePptxPopup
  await expect(pptxProjection.getByText('Presenter page 1', { exact: true }).first()).toBeVisible()
  await pptxProjection.reload()
  await expect(pptxProjection.getByText('Presenter page 1', { exact: true }).first()).toBeVisible()
})
