import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { completeOnboarding } from './helpers'

test('keeps the toolbar against the preview and navigation compact in all window sizes', async ({
  page,
  context
}) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1920
      canvas.height = 1080
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#111111'
      ctx.font = '64px sans-serif'
      ctx.fillText('1920 x 1080 preview', 80, 120)
      ctx.font = '28px sans-serif'
      for (let y = 200; y < 1000; y += 70) ctx.fillText('Readable text ABCDEFG 123456789', 80, y)
      return canvas.toDataURL('image/png').split(',')[1]
    }),
    'base64'
  )
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles([
      { name: 'Layout.png', mimeType: 'image/png', buffer: png },
      { name: 'Next.png', mimeType: 'image/png', buffer: png }
    ])
  await expect(page.getByText('Layout.png')).toBeVisible()
  const projectionPromise = context.waitForEvent('page')
  await page.getByText('Layout.png').dblclick()
  await projectionPromise
  await expect(page).toHaveURL(/#\/media$/)
  const nextImage = page.getByRole('img', { name: 'Next.png', exact: true })
  await expect
    .poll(() => nextImage.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1920)
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [1024, 768],
    [910, 512]
  ]) {
    await page.setViewportSize({ width, height })
    const controls = page.locator('.presenter-control-button, .presenter-navigation-button')
    await expect(controls).toHaveCount(4)
    for (const button of await controls.all()) {
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThanOrEqual(48)
      expect(box!.width).toBeLessThanOrEqual(64)
      expect(box!.y + box!.height).toBeLessThanOrEqual(height)
    }
    const stage = await page.locator('.presenter-preview-stage').boundingBox()
    expect(stage!.width).toBeGreaterThan(100)
    expect(Math.abs(stage!.width / stage!.height - 16 / 9)).toBeLessThan(0.02)
    const toolbar = await page
      .getByRole('button', { name: /Grid|格狀|格状/, exact: true })
      .locator('..')
      .boundingBox()
    expect(Math.abs(toolbar!.y - (stage!.y + stage!.height))).toBeLessThanOrEqual(1)
    const navigation = page.locator('.presenter-navigation-button')
    await expect(navigation).toHaveCount(2)
    for (const button of await navigation.all()) {
      expect((await button.boundingBox())!.width).toBe(48)
    }
    await page.screenshot({ path: `/tmp/presenter-controls-${width}x${height}.png` })
  }
})

test('renders a sharp first-page PDF preview before advancing to it', async ({ page, context }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  const content = 'BT /F1 48 Tf 80 600 Td (Sharp next PDF preview) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1280 720] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles([
      {
        name: 'Current.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64'
        )
      },
      { name: 'Next.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) }
    ])
  await expect(page.getByText('Current.png')).toBeVisible()
  const projectionPromise = context.waitForEvent('page')
  await page.getByText('Current.png').dblclick()
  await projectionPromise
  const canvas = page.locator('canvas[aria-label="Next.pdf"]')
  await expect(canvas).toBeVisible()
  expect(await canvas.evaluate((node: HTMLCanvasElement) => [node.width, node.height])).toEqual([
    1280, 720
  ])
  await page.getByRole('button', { name: /Next|下一張|下一张/, exact: true }).click()
  await expect(page.locator('.presenter-preview-stage canvas')).toBeVisible()
})

test('decodes a native next-video frame while keeping it paused', async ({ page, context }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles([
      {
        name: 'Current.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64'
        )
      },
      {
        name: 'Next.mp4',
        mimeType: 'video/mp4',
        buffer: await readFile(resolve('e2e/fixtures/vlc/healthy.mp4'))
      }
    ])
  await expect(page.getByText('Current.png')).toBeVisible()
  const projectionPromise = context.waitForEvent('page')
  await page.getByText('Current.png').dblclick()
  await projectionPromise
  const video = page.locator('video[aria-label="Next.mp4"]')
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
    .toBeGreaterThanOrEqual(2)
  expect(
    await video.evaluate((node: HTMLVideoElement) => ({
      paused: node.paused,
      muted: node.muted,
      width: node.videoWidth > 0
    }))
  ).toEqual({ paused: true, muted: true, width: true })
  await page.getByTestId('media-back-to-files').click()
  await expect(video).toHaveCount(0)
})

test('opens the bottom action menu above its trigger without clipping items', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  const trigger = page.getByRole('button').filter({
    has: page.locator('[aria-label="New"], [aria-label="新增"]')
  })

  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [910, 512]
  ]) {
    await page.setViewportSize({ width, height })
    await trigger.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const popover = page.locator('.dropdown__popover').filter({ has: menu })
    await expect(popover).toHaveAttribute('data-placement', 'top')
    await expect(popover).not.toHaveAttribute('data-entering', 'true')
    const bounds = (await popover.boundingBox())!
    const anchor = (await trigger.boundingBox())!
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(anchor.y)
    for (const item of await menu.getByRole('menuitem').all()) {
      const box = (await item.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(bounds.y)
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height)
    }
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  }
})
