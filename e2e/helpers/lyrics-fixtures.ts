import { expect, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
const allLines = ['祂從災難中保護我們', '堅定腳步走過每一天', '在樹蔭邊彼此扶持']
async function setFixture(page: Page, background: string, lines: string[]): Promise<void> {
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

export async function verifyLyricsWorkflow(
  page: Page,
  testInfo: TestInfo,
  waitForProjection: () => Promise<Page>
): Promise<void> {
  await page.getByTestId('camera-source-selector').click()
  await page.getByRole('option').first().click()
  await page.getByRole('checkbox', { name: 'Lyrics subtitles', exact: true }).check()
  await expect(page.getByTestId('lyrics-output')).toBeVisible()
  const results: Array<{ background: string; lines: number; elapsedMs: number }> = []
  for (let cycle = 0; cycle < 5; cycle++) {
    for (const background of ['black', 'dark', 'bright']) {
      for (const count of [2, 3]) {
        const lines = allLines.slice(0, count),
          started = Date.now()
        await setFixture(page, background, lines)
        await expect
          .poll(() => page.getByTestId('lyrics-line').allTextContents(), {
            timeout: 40000,
            intervals: [100]
          })
          .toEqual(lines)
        results.push({ background, lines: count, elapsedMs: Date.now() - started })
      }
    }
  }
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
  const popup = waitForProjection()
  await page.getByRole('button', { name: 'Present source', exact: true }).click()
  const projection = await popup
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines)
  await expect(projection.locator('video')).toHaveCount(0)
  await testInfo.attach('three-line-projection', {
    body: await projection.screenshot(),
    contentType: 'image/png'
  })
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('48')
  await page.getByRole('spinbutton', { name: 'Line height', exact: true }).fill('1.4')
  await page.getByRole('spinbutton', { name: 'Bottom distance (%)', exact: true }).fill('8')
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
  await page.getByRole('button', { name: 'Hide subtitles', exact: true }).click()
  await expect(projection.getByTestId('lyrics-line')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show subtitles', exact: true }).click()
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines)
  await page.getByRole('button', { name: 'Correct text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Lyrics (one source line per row)', exact: true })
    .fill(allLines.join('\n'))
  await page.getByRole('button', { name: 'Apply correction', exact: true }).click()
  await setFixture(page, 'black', [])
  await expect(projection.getByTestId('lyrics-line')).toHaveText(allLines)
  await page.getByRole('button', { name: 'Resume recognition', exact: true }).click()
  await expect(projection.getByTestId('lyrics-line')).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Lyrics subtitles', exact: true }).uncheck()
  await expect
    .poll(() => projection.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), {
      timeout: 15000
    })
    .toBeGreaterThan(0)
}
