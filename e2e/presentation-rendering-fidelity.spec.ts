import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { completeOnboarding } from './helpers'

async function mediaDeck(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(
    await readFile(resolve('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'))
  )
  const presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const slides = presentation.match(/<p:sldId\b[^>]*\/>/g)!.slice(0, 2)
  zip.file(
    'ppt/presentation.xml',
    presentation.replace(
      /<p:sldIdLst>.*?<\/p:sldIdLst>/s,
      `<p:sldIdLst>${slides.join('')}</p:sldIdLst>`
    )
  )
  zip.file(
    'ppt/media/lifecycle.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  )
  zip.file('ppt/media/lifecycle.mp4', await readFile(resolve('e2e/fixtures/vlc/healthy.mp4')))
  let types = await zip.file('[Content_Types].xml')!.async('string')
  types = types.replace(
    '</Types>',
    '<Default Extension="png" ContentType="image/png"/><Default Extension="mp4" ContentType="video/mp4"/></Types>'
  )
  zip.file('[Content_Types].xml', types)
  for (const index of [1, 2]) {
    const path = `ppt/slides/slide${index}.xml`
    const xml = await zip.file(path)!.async('string')
    const video = index === 2 ? '<a:videoFile r:link="rIdLifecycleVideo"/>' : ''
    const picture = `<p:pic><p:nvPicPr><p:cNvPr id="900" name="Lifecycle ${index === 2 ? 'video' : 'image'}"/><p:cNvPicPr/><p:nvPr>${video}</p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rIdLifecycleImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="4572000"/><a:ext cx="1828800" cy="1028700"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    zip.file(path, xml.replace('</p:spTree>', `${picture}</p:spTree>`))
    const relPath = `ppt/slides/_rels/slide${index}.xml.rels`
    const relationships = await zip.file(relPath)!.async('string')
    const additions =
      '<Relationship Id="rIdLifecycleImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/lifecycle.png"/>' +
      (index === 2
        ? '<Relationship Id="rIdLifecycleVideo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/lifecycle.mp4"/>'
        : '')
    zip.file(relPath, relationships.replace('</Relationships>', `${additions}</Relationships>`))
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('renders real PPTX fonts, image geometry, pages and embedded-video surface', async ({
  page,
  context
}, testInfo) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles({
      name: 'Lifecycle fidelity.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: await mediaDeck()
    })
  const file = page.getByText('Lifecycle fidelity.pptx', { exact: true })
  await expect(file).toBeVisible()
  await file.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  const opened = context.waitForEvent('page')
  await page.getByRole('button', { name: /Start projection|開始投影/ }).click()
  const projection = await opened
  await expect(projection.getByText('主愛永不止息', { exact: true }).first()).toBeVisible()
  const text = projection.getByText('主愛永不止息', { exact: true }).first()
  const typography = await text.evaluate((element) => ({
    font: getComputedStyle(element).fontFamily,
    bounds: element.getBoundingClientRect().toJSON(),
    fontReady: document.fonts.status
  }))
  expect(typography.font).toContain('Noto Sans TC')
  const images = projection.locator('img')
  await expect(images.first()).toBeVisible()
  await expect
    .poll(() =>
      images.first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
    )
    .toBe(true)
  const imageBounds = await images.first().boundingBox()
  expect(imageBounds).not.toBeNull()
  expect(imageBounds!.width / imageBounds!.height).toBeCloseTo(16 / 9, 1)
  await testInfo.attach('pptx-image-fonts.png', {
    body: await projection.screenshot(),
    contentType: 'image/png'
  })
  await page.keyboard.press('ArrowRight')
  await expect(page.getByText('Amazing grace', { exact: true }).first()).toBeVisible()
  await expect(projection.getByText('Amazing grace', { exact: true }).first()).toBeVisible()
  // The current renderer keeps embedded media as a static poster in this imported deck.
  await expect(projection.getByText('▶', { exact: true })).toBeVisible()
  await expect(page.getByText('▶', { exact: true })).toBeVisible()
  await expect(projection.locator('video')).toHaveCount(0)
  const media = { surface: 'poster', synchronizedPlayback: false }
  await testInfo.attach('pptx-fidelity-observations.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          typography,
          imageBounds,
          embeddedVideo: media,
          scope:
            'Rendering only; PowerPoint animation and synchronized embedded-media transport are not claimed.'
        },
        null,
        2
      )
    ),
    contentType: 'application/json'
  })
  await testInfo.attach('pptx-embedded-video.png', {
    body: await projection.screenshot(),
    contentType: 'image/png'
  })
})
