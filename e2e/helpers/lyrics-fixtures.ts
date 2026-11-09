import { expect, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
const allLines = ['祂從災難中保護我們', '堅定腳步走過每一天', '在樹蔭邊彼此扶持']
export async function setFixture(page: Page, background: string, lines: string[]): Promise<void> {
  await page.waitForFunction(() =>
    Array.from(document.fonts).some((font) => font.family.includes('Noto Sans TC'))
  )
  await page.evaluate(
    async ({ background, lines }) => {
      const draw = Reflect.get(window, '__drawLyricsFixture') as (
        background: string,
        lines: string[]
      ) => Promise<void>
      await draw(background, lines)
    },
    { background, lines }
  )
}

export async function installLyricsFixture(page: Page): Promise<void> {
  const photos: Record<string, string> = {}
  for (const name of ['dark', 'bright'])
    photos[name] =
      'data:image/jpeg;base64,' +
      (await readFile(`e2e/fixtures/lyrics/${name}.jpg`)).toString('base64')
  await page.addInitScript(
    ({ photos }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 1600
      canvas.height = 900
      const ctx = canvas.getContext('2d')!
      setInterval(() => ctx.drawImage(canvas, 0, 0), 100)
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      Reflect.set(window, '__drawLyricsFixture', async (background: string, lines: string[]) => {
        await document.fonts.load('600 76px "Noto Sans TC Variable"', lines.join(''))
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        if (photos[background]) {
          const image = new Image()
          image.src = photos[background]
          await image.decode()
          ctx.drawImage(image, 0, 0, 1600, 900)
        }
        ctx.font = '600 76px "Noto Sans TC Variable"'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = background === 'bright' ? '#000' : '#fff'
        lines.forEach((line, index) => ctx.fillText(line, 800, 32 + index * 130))
      })
      navigator.mediaDevices.getUserMedia = async (constraints) =>
        constraints?.audio ? original(constraints) : canvas.captureStream(10)
    },
    { photos }
  )
}

export async function setLyricsMode(page: Page, enabled: boolean): Promise<void> {
  const toggle = page.getByRole('switch', { name: 'Lyrics subtitles', exact: true })
  await expect(toggle).toBeEnabled()
  if ((await toggle.isChecked()) !== enabled)
    await page.locator('header').getByText('Lyrics subtitles', { exact: true }).click()
  await expect(toggle).toBeChecked({ checked: enabled })
}

export async function verifyLyricsWorkflow(
  page: Page,
  testInfo: TestInfo,
  waitForProjection: () => Promise<Page>
): Promise<void> {
  if (!page.url().startsWith('file:')) await page.context().grantPermissions(['local-fonts'])
  const runtimeMessages: string[] = []
  page.on('console', (message) => {
    if (message.text().startsWith('[lyrics] OCR initialized')) runtimeMessages.push(message.text())
  })
  await page.getByTestId('camera-source-selector').click()
  await page.getByRole('option').first().click()
  await setLyricsMode(page, true)
  await expect(page.getByTestId('lyrics-source-preview')).toBeVisible()
  const popup = waitForProjection()
  await page.getByRole('button', { name: 'Present source', exact: true }).click()
  const projection = await popup
  await expect(projection.getByTestId('lyrics-output')).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('40')
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('camera-editor')).toHaveCount(0)
  await expect(page.locator('video')).toHaveCount(1)
  await expect(page.getByTestId('lyrics-crop-overlay')).toHaveAttribute('style', /height: 40%/)
  const height = page.getByRole('slider', { name: 'Height', exact: true })
  await height.focus()
  await height.press('Home')
  for (let step = 5; step < 60; step++) await height.press('ArrowRight')
  await expect(page.getByTestId('lyrics-crop-overlay')).toHaveAttribute('style', /height: 60%/)
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('60')
  await page.getByRole('spinbutton', { name: 'Height', exact: true }).fill('40')
  const results: Array<{ background: string; lines: number; elapsedMs: number }> = []
  for (let cycle = 0; cycle < 5; cycle++) {
    for (const background of ['black', 'dark', 'bright']) {
      for (const count of [2, 3]) {
        const lines = allLines.slice(0, count),
          started = Date.now()
        await setFixture(page, background, lines)
        await expect
          .poll(() => projection.getByTestId('lyrics-line').allTextContents(), {
            timeout: 40000,
            intervals: [100]
          })
          .toEqual(lines)
        results.push({ background, lines: count, elapsedMs: Date.now() - started })
      }
    }
  }
  const spaced = ['耶穌 耶穌 無人能像祢']
  await setFixture(page, 'black', spaced)
  await expect(projection.getByTestId('lyrics-line')).toHaveText([/^耶穌\s*耶穌\s*無人能像祢$/], {
    timeout: 40000
  })
  await setFixture(page, 'bright', allLines)
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines, { timeout: 40000 })
  await setFixture(page, 'black', ['耶稣 耶稣 无人能像祢'])
  await expect(projection.getByTestId('lyrics-line')).toHaveText([/^耶穌\s*耶穌\s*無人能像祢$/], {
    timeout: 40000
  })
  await setFixture(page, 'bright', allLines)
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines, { timeout: 40000 })
  const initializations = runtimeMessages.length
  await height.focus()
  await height.press('Home')
  for (let step = 5; step < 60; step++) await height.press('ArrowRight')
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines, { timeout: 15000 })
  await page.getByRole('spinbutton', { name: 'Height', exact: true }).fill('40')
  await expect(height).toHaveValue('40')
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines, { timeout: 15000 })
  expect(runtimeMessages).toHaveLength(initializations)
  await testInfo.attach('lyrics-mode-controls', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png'
  })
  await testInfo.attach('ocr-runtime', {
    body: runtimeMessages.join('\n'),
    contentType: 'text/plain'
  })
  console.log('LYRICS_RUNTIME', runtimeMessages.join('\n'))
  const times = results.map((result) => result.elapsedMs).sort((a, b) => a - b)
  console.log(
    'LYRICS_METRICS',
    JSON.stringify({
      platform: process.platform,
      changes: results.length,
      medianMs: times[15],
      p95Ms: times[28]
    })
  )
  await testInfo.attach('real-ocr-results', {
    body: JSON.stringify(
      { platform: process.platform, medianMs: times[15], p95Ms: times[28], results },
      null,
      2
    ),
    contentType: 'application/json'
  })
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines)
  await expect(projection.locator('video')).toHaveCount(0)
  await testInfo.attach('three-line-projection', {
    body: await projection.screenshot(),
    contentType: 'image/png'
  })
  const font = page.getByRole('combobox', { name: 'Font', exact: true })
  await font.scrollIntoViewIfNeeded()
  await font.fill('Roboto')
  const fontPopover = page.locator('.combo-box__popover')
  await expect(fontPopover).toBeVisible()
  await expect(fontPopover).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await page.getByRole('option', { name: 'Roboto', exact: true }).click()
  await page.getByRole('button', { name: 'Bold', exact: true }).click()
  await expect(projection.getByTestId('lyrics-lines')).toHaveCSS('font-weight', '400')
  await expect(projection.getByTestId('lyrics-lines')).toHaveCSS('font-family', /Roboto Variable/)
  if (await page.evaluate(() => 'queryLocalFonts' in window)) {
    await font.fill('')
    await font.click()
    await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(5)
    const bundled = ['Noto Sans TC', 'Noto Sans SC', 'Inter', 'Roboto', 'System sans serif']
    const installed = (await page.getByRole('option').allTextContents()).find(
      (name) => !bundled.includes(name.trim())
    )
    expect(installed).toBeTruthy()
    await page.getByRole('option', { name: installed!.trim(), exact: true }).click()
    await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines)
  }
  await font.scrollIntoViewIfNeeded()
  await testInfo.attach('lyrics-font-controls', {
    body: await page.screenshot(),
    contentType: 'image/png'
  })
  await font.fill('Noto Sans TC')
  await page.getByRole('option', { name: 'Noto Sans TC', exact: true }).click()
  await page.getByRole('button', { name: 'Bold', exact: true }).click()
  await expect(projection.getByTestId('lyrics-lines')).toHaveCSS('font-weight', '700')
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('160')
  await page.getByRole('spinbutton', { name: 'Line height', exact: true }).fill('2')
  await page.getByRole('spinbutton', { name: 'Bottom distance (%)', exact: true }).fill('50')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(projection.getByTestId('lyrics-line')).toHaveCount(0)
  await page.evaluate(() => {
    location.hash = '/files'
  })
  await setFixture(page, 'bright', allLines.slice(0, 1))
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines.slice(0, 1), {
    timeout: 40000
  })
  await page.evaluate(() => {
    location.hash = '/camera'
  })
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('48')
  await page.getByRole('spinbutton', { name: 'Line height', exact: true }).fill('1.4')
  await page.getByRole('spinbutton', { name: 'Bottom distance (%)', exact: true }).fill('8')
  await setFixture(page, 'bright', allLines)
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines)
  await setFixture(page, 'bright', [])
  await expect(projection.getByTestId('lyrics-line')).toHaveCount(0, { timeout: 10000 })
  await setFixture(page, 'bright', allLines)
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines, { timeout: 40000 })
  await expect
    .poll(() =>
      projection
        .getByTestId('lyrics-lines')
        .evaluate((node) => parseFloat(getComputedStyle(node).bottom))
    )
    .toBeCloseTo(86.4, 1)
  await expect(page.getByRole('button', { name: 'Hide subtitles', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Correct text', exact: true })).toHaveCount(0)
  if (await page.evaluate(() => !!navigator.serviceWorker?.controller)) {
    await page.context().setOffline(true)
    await setLyricsMode(page, false)
    await setLyricsMode(page, true)
    await setFixture(page, 'dark', allLines)
    await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines, { timeout: 40000 })
    await page.context().setOffline(false)
  }
  await setLyricsMode(page, false)
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveCount(0)
  await expect
    .poll(() => projection.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), {
      timeout: 15000
    })
    .toBeGreaterThan(0)
}
