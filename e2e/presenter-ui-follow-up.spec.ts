import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/account/v1/session', (route) =>
    route.fulfill({
      headers: {
        'access-control-allow-origin': new URL(page.url()).origin,
        'access-control-allow-credentials': 'true'
      },
      json: { authenticated: false }
    })
  )
  await page.goto('/')
  await completeOnboarding(page)
})

for (const label of ['About', 'Keyboard Shortcuts', 'Preferences']) {
  test(`${label} leaves the account trigger in place`, async ({ page }) => {
    const account = page.getByRole('button', { name: 'Account menu for Guest' })
    await expect(account).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const before = await account.boundingBox()
    await account.click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    await expect(page.locator('[data-slot="modal-dialog"]')).toBeVisible()
    expect(before).not.toBeNull()
    await expect
      .poll(async () => {
        const after = await account.boundingBox()
        return Math.max(Math.abs(after!.y - before!.y), Math.abs(after!.x - before!.x))
      })
      .toBeLessThanOrEqual(1)
  })
}

test('outside right click dismisses the current menu before opening another', async ({ page }) => {
  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Account menu for Guest' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.locator('body').click({ button: 'right', position: { x: 800, y: 400 } })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.getByLabel('New', { exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.locator('body').click({ button: 'right', position: { x: 800, y: 400 } })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('formatting controls show selected and disabled states', async ({ page }) => {
  await page.goto('/#/files')
  await page.getByLabel('New', { exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create Presentation', exact: true }).click()
  const font = page.getByRole('button', { name: 'Font family', exact: true })
  await expect(font).toBeDisabled()
  await expect(font).toHaveCSS('opacity', '0.3')
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .locator('.presentation-stage [data-slide-surface]')
    .click({ position: { x: 160, y: 120 } })
  const text = page.locator('.presentation-stage [data-text-content][contenteditable="true"]')
  await text.pressSequentially('Selected text')
  await text.press('ControlOrMeta+A')
  const bold = page.getByRole('button', { name: 'Bold', exact: true })
  const before = await bold.evaluate((el) => getComputedStyle(el).backgroundColor)
  await bold.click()
  await expect(bold).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => bold.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(before)
  await text.press('Home')
  await text.press('Shift+ArrowRight')
  await bold.click()
  await text.press('ControlOrMeta+A')
  await expect(bold).toHaveAttribute('aria-pressed', 'mixed')
  await expect(bold).toHaveCSS('border-top-style', 'dashed')
  await text.press('Escape')
  await expect(page.locator('.presentation-stage [data-resize-handle]')).toHaveCount(6)
  await expect(page.getByRole('button', { name: 'Arrange', exact: true })).toBeVisible()
})

test('Delete removes a focused slide thumbnail and undo restores it', async ({ page }) => {
  await page.goto('/#/files')
  await page.getByLabel('New', { exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create Presentation', exact: true }).click()
  await page.getByRole('button', { name: 'New slide', exact: true }).click()
  const slides = page.locator('[data-slide-option]')
  await expect(slides).toHaveCount(2)
  await slides.last().click()
  await slides.last().press('Delete')
  await expect(slides).toHaveCount(1)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(slides).toHaveCount(2)
})

test('images have eight visible handles and preserve negative coordinates after reload', async ({
  page
}) => {
  await page.goto('/#/files')
  await page.getByLabel('New', { exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create Presentation', exact: true }).click()
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 160
    const context = canvas.getContext('2d')!
    context.fillStyle = '#123456'
    context.fillRect(0, 0, 160, 160)
    return canvas.toDataURL().split(',')[1]
  })
  await page
    .locator('input[accept="image/*"]')
    .setInputFiles({ name: 'Image.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  const handles = page.locator('.presentation-stage [data-resize-handle]')
  await expect(handles).toHaveCount(8)
  for (const handle of await handles.all()) {
    await expect(handle).toBeVisible()
    await expect(handle.locator('[data-resize-handle-visual]')).not.toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)'
    )
  }
  const element = page.locator('.presentation-stage [data-slide-element]').first()
  const surface = page.locator('.presentation-stage [data-slide-surface]')
  const frame = await surface.boundingBox()
  const box = await element.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(frame!.x + box!.width / 2 - 20, frame!.y + box!.height / 2 - 20, {
    steps: 10
  })
  await page.mouse.up()
  const position = (): Promise<{ x: number; y: number }> =>
    element.evaluate((el) => ({
      x: parseFloat((el as HTMLElement).style.left),
      y: parseFloat((el as HTMLElement).style.top)
    }))
  await expect.poll(async () => (await position()).x).toBeLessThan(0)
  await expect.poll(async () => (await position()).y).toBeLessThan(0)
  const moved = await position()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(async () => (await position()).x).toBeGreaterThanOrEqual(0)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect.poll(position).toEqual(moved)
  await page.waitForTimeout(1800)
  await page.reload()
  await expect.poll(position).toEqual(moved)
})

test('advancing past the end screen closes the browser projection window', async ({
  page,
  context
}) => {
  await page.goto('/#/files')
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles({
      name: 'End screen.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    })
  const opened = context.waitForEvent('page')
  await page.getByText('End screen.png', { exact: true }).dblclick()
  const projection = await opened
  await expect(page).toHaveURL(/#\/media$/)
  await page.getByRole('button', { name: 'Next', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByText('End of slides', { exact: true })).toHaveCount(2)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => projection.isClosed()).toBe(true)
  await expect(page).toHaveURL(/#\/files$/)
})
