import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'

function multiPagePdf(count: number): Buffer {
  const fontId = 3 + count * 2
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`
  ]
  for (let i = 0; i < count; i++) {
    const content = `${(i + 1) / count} 0.2 0.4 rg 0 0 640 360 re f BT /F1 32 Tf 1 1 1 rg 40 280 Td (Page ${i + 1}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 360] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

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
