import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test('keeps larger media controls inside compact and wide windows', async ({ page, context }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name: 'Layout.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByText('Layout.png')).toBeVisible()
  const projectionPromise = context.waitForEvent('page')
  await page.getByText('Layout.png').dblclick()
  await projectionPromise
  await expect(page).toHaveURL(/#\/media$/)
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [1024, 768],
    [910, 512]
  ]) {
    await page.setViewportSize({ width, height })
    const controls = page.locator('.presenter-control-button')
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
    await page.screenshot({ path: `/tmp/presenter-controls-${width}x${height}.png` })
  }
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
