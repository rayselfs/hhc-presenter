import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { completeOnboarding } from './helpers'

async function tenPagePptx(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(
    await readFile(resolve('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'))
  )
  const presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const slides = presentation.match(/<p:sldId\b[^>]*\/>/g)!.slice(0, 10)
  zip.file(
    'ppt/presentation.xml',
    presentation.replace(
      /<p:sldIdLst>.*?<\/p:sldIdLst>/s,
      `<p:sldIdLst>${slides.join('')}</p:sldIdLst>`
    )
  )
  const relationships = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  for (let index = 0; index < slides.length; index++) {
    const id = slides[index].match(/r:id="([^"]+)"/)![1]
    const relationship = relationships
      .match(/<Relationship\b[^>]*\/>/g)!
      .find((entry) => entry.includes(`Id="${id}"`))!
    const target = relationship.match(/Target="([^"]+)"/)![1]
    const path = `ppt/${target}`
    const xml = await zip.file(path)!.async('string')
    zip.file(path, xml.replace(/<a:t>[^<]*<\/a:t>/g, `<a:t>Presenter page ${index + 1}</a:t>`))
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

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
    await page
      .locator('input[type="file"]:not([webkitdirectory])')
      .first()
      .setInputFiles({
        name: 'Ten pages.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        buffer: await tenPagePptx()
      })
    const file = page.getByText('Ten pages.pptx', { exact: true })
    await expect(file).toBeVisible()
    await file.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
    await expect(page.locator('[data-pptx-slide-surface] > *').first()).toBeVisible()
    if (editable) {
      await page.getByRole('button', { name: /Edit a copy|編輯副本/ }).click()
      await expect(page.getByTestId('presentation-ribbon-frame')).toBeVisible()
    }
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
              const container = element.parentElement!.getBoundingClientRect()
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
