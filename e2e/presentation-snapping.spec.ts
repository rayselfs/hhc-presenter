import { expect, test } from '@playwright/test'
import { completeOnboarding } from './helpers'
import type { EditablePresentationDocument } from '../src/renderer/src/lib/editable-presentation'

test('snaps at two zoom levels, permits Alt and keeps group drag undo/save/reopen atomic', async ({
  page
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/#/files')
  await completeOnboarding(page)
  await page.goto('/#/files')
  const fixture: EditablePresentationDocument = {
    id: 'snap-deck',
    schemaVersion: 1,
    name: 'Snapping',
    width: 1280,
    height: 720,
    createdAt: 1,
    updatedAt: 1,
    assets: {},
    slideOrder: ['slide'],
    slides: {
      slide: {
        id: 'slide',
        name: 'Slide',
        notes: '',
        background: { type: 'solid', color: '#ffffff', transparency: 0 },
        elementOrder: ['first', 'second'],
        elements: Object.fromEntries(
          ['first', 'second'].map((id, i) => [
            id,
            {
              id,
              type: 'shape',
              shape: 'rectangle',
              x: 100 + i * 300,
              y: 100,
              width: 200,
              height: 100,
              rotation: 0,
              opacity: 1,
              fillColor: '#2563eb',
              strokeColor: '#111827',
              strokeWidth: 2
            }
          ])
        )
      }
    }
  }
  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles({
      name: 'Snapping.lpdeck',
      mimeType: 'application/vnd.hhc.presenter+json',
      buffer: Buffer.from(JSON.stringify(fixture))
    })
  await page.getByText('Snapping.lpdeck', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  const surface = page.locator('.presentation-stage [data-slide-surface]')
  const first = surface.locator('[data-slide-element]').nth(0)
  const second = surface.locator('[data-slide-element]').nth(1)
  const zoom = page.getByRole('slider', { name: /^(Zoom|縮放|缩放)$/ })
  for (const percent of [50, 100]) {
    await zoom.focus()
    await zoom.press('Home')
    for (let n = 25; n < percent; n++) await zoom.press('ArrowRight')
    await expect(zoom).toHaveValue(String(percent))
    const bounds = await surface.boundingBox()
    if (!bounds) throw new Error('Slide surface is hidden')
    const scale = bounds.width / 1280
    // Select both elements through the real marquee path.
    await page.mouse.move(bounds.x + 5 * scale, bounds.y + 5 * scale)
    await page.mouse.down()
    await page.mouse.move(bounds.x + 650 * scale, bounds.y + 250 * scale, { steps: 5 })
    await page.mouse.up()
    await expect(surface.locator('[data-selection-chrome]')).toHaveCount(2)
    await page.mouse.move(bounds.x + 200 * scale, bounds.y + 150 * scale)
    await page.mouse.down()
    await page.mouse.move(bounds.x + 644 * scale, bounds.y + 150 * scale, { steps: 5 })
    await expect(first).toHaveCSS('left', '540px')
    await expect(second).toHaveCSS('left', '840px')
    await expect(surface.locator('[data-snap-guide="x"]')).toHaveCount(1)
    await page.keyboard.down('Alt')
    await page.mouse.move(bounds.x + 645 * scale, bounds.y + 150 * scale)
    await expect(first).toHaveCSS('left', '545px')
    await expect(surface.locator('[data-snap-guide]')).toHaveCount(0)
    await page.keyboard.up('Alt')
    await page.mouse.move(bounds.x + 644 * scale, bounds.y + 150 * scale)
    await page.mouse.up()
    await expect(surface.locator('[data-snap-guide]')).toHaveCount(0)
    await page.getByRole('button', { name: /^(Undo|復原|撤銷|撤销)$/ }).click()
    await expect(first).toHaveCSS('left', '100px')
    await expect(second).toHaveCSS('left', '400px')
  }
  await page.getByRole('button', { name: /^(Redo|重做)$/ }).click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText(/^(Saved|已儲存|已保存)$/)).toBeVisible()
  await page.reload()
  await expect(first).toHaveCSS('left', '540px')
  await expect(second).toHaveCSS('left', '840px')
})
