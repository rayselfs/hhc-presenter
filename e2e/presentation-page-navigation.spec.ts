import { expect, test } from '@playwright/test'
import { completeOnboarding, seedRawPptx } from './helpers'
import { pageDeck } from './helpers/presentation-fixtures'

for (const editable of [false, true]) {
  test(`projects all ten ${editable ? 'editable' : 'PPTX'} pages and selects pages from G`, async ({
    page,
    context
  }) => {
    test.setTimeout(90_000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await completeOnboarding(page)
    await page.goto('/#/files')
    if (editable) {
      await page
        .locator('input[type="file"]:not([webkitdirectory])')
        .first()
        .setInputFiles({
          name: 'Ten pages.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          buffer: await pageDeck()
        })
    } else {
      await seedRawPptx(page, 'Ten pages.pptx', await pageDeck())
    }
    const file = page.getByText(editable ? 'Ten pages.lpdeck' : 'Ten pages.pptx', { exact: true })
    await expect(file).toBeVisible()
    await file.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
    await expect(
      page
        .locator(
          editable ? '.presentation-stage [data-slide-surface]' : '[data-pptx-slide-surface] > *'
        )
        .first()
    ).toBeVisible()
    if (editable) await expect(page.getByTestId('presentation-ribbon-frame')).toBeVisible()
    const popup = context.waitForEvent('page')
    await page.getByRole('button', { name: /Start projection|開始投影/ }).click()
    const projection = await popup
    projection.on('pageerror', (error) => errors.push(error.message))
    await expect(page).toHaveURL(/#\/media$/)
    for (let number = 1; number <= 10; number++) {
      if (number > 1) await page.keyboard.press('ArrowRight')
      await expect(
        page.getByText(`Presenter page ${number}`, { exact: true }).first()
      ).toBeVisible()
      await expect(
        projection.getByText(`Presenter page ${number}`, { exact: true }).first()
      ).toBeVisible()
    }
    await page.keyboard.press('g')
    await expect(page.locator('[data-testid^="grid-slide-"]')).toHaveCount(10)
    if (!editable) {
      for (const width of [1024, 1366]) {
        await page.setViewportSize({ width, height: 768 })
        const thumbnail = page.getByTestId('grid-slide-0').locator('[data-pptx-thumbnail]')
        await expect(thumbnail).toBeVisible()
        await expect
          .poll(async () =>
            thumbnail.evaluate((element) => {
              const rendered = element.getBoundingClientRect()
              const container = element.parentElement?.getBoundingClientRect()
              if (!container) return false
              return (
                rendered.width <= container.width + 1 && rendered.height <= container.height + 1
              )
            })
          )
          .toBe(true)
      }
    }
    await page.getByTestId('grid-slide-6').click()
    await expect(projection.getByText('Presenter page 7', { exact: true }).first()).toBeVisible()
    await page.keyboard.press('Home')
    await expect(projection.getByText('Presenter page 1', { exact: true }).first()).toBeVisible()
    await page.keyboard.press('End')
    await expect(projection.getByText('Presenter page 10', { exact: true }).first()).toBeVisible()
    expect(errors).toEqual([])
  })
}

test('imports 22 editable pages, projects a focused edit with F5 and saves across reopen', async ({
  page,
  context
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles({
      name: 'Twenty two pages.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: await pageDeck(22)
    })
  const file = page.getByText('Twenty two pages.lpdeck', { exact: true })
  await expect(file).toHaveCount(1)
  await file.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
  const editorUrl = page.url()
  await page.locator('.presentation-stage [data-text-content]').first().dblclick()
  const focusedText = page.locator('.presentation-stage [contenteditable="true"]')
  await focusedText.fill('Edited opening page')
  await expect(focusedText).toBeFocused()
  const popup = context.waitForEvent('page')
  await page.keyboard.press('F5')
  const projection = await popup
  projection.on('pageerror', (error) => errors.push(error.message))
  await expect(page).toHaveURL(/#\/media$/)
  await expect(projection.getByText('Edited opening page', { exact: true })).toBeVisible()
  for (let number = 2; number <= 22; number++) {
    await page.keyboard.press('ArrowRight')
    await expect(page.getByText(`Presenter page ${number}`, { exact: true }).first()).toBeVisible()
    await expect(
      projection.getByText(`Presenter page ${number}`, { exact: true }).first()
    ).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect.poll(() => projection.isClosed()).toBe(true)
  await page.goto(editorUrl)
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText(/^(Saved|已儲存|已保存)$/)).toBeVisible()
  await page.reload()
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
  await page.locator('[data-slide-option]').first().click()
  await expect(
    page.locator('.presentation-stage').getByText('Edited opening page', { exact: true })
  ).toBeVisible()
  expect(errors).toEqual([])
})
