import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { completeOnboarding } from './helpers'

test('imports a real PPTX as one editable deck with a cover thumbnail', async ({ page }) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')

  const fixture = resolve('src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx')
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(fixture)

  await expect(page.getByText('text-placeholder-layout.lpdeck', { exact: true })).toBeVisible()
  await expect(page.getByText('text-placeholder-layout.pptx', { exact: true })).toHaveCount(0)
  await expect(page.getByText('text-placeholder-layout.lpdeck', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('img', { name: 'text-placeholder-layout.lpdeck' })).toBeVisible()
})

const themeFixtures = [
  { name: 'theme-solid-fill', fill: 'rgb(255, 188, 188)', stroke: 'rgb(0, 0, 0)', width: '2px' },
  { name: 'theme-solid-line', fill: 'rgb(255, 0, 0)', stroke: 'rgb(255, 0, 0)', width: '10px' }
]

async function themeStyleSmoke(
  page: Page,
  waitForProjection: () => Promise<Page>,
  fixture: (typeof themeFixtures)[number]
): Promise<void> {
  await page.goto(page.url().replace(/#.*$/, '#/files'))
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles(resolve('src/renderer/src/lib/__fixtures__/pptx/' + fixture.name + '.pptx'))
  await page.getByText(fixture.name + '.lpdeck', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  const fill = page.locator('.presentation-stage [data-slide-element] > div').first()
  await expect(fill).toHaveCSS('background-color', fixture.fill)
  await expect(fill).toHaveCSS('border-top-color', fixture.stroke)
  await expect(fill).toHaveCSS('border-top-width', fixture.width)
  await page.reload()
  await expect(fill).toHaveCSS('background-color', fixture.fill)
  await expect(fill).toHaveCSS('border-top-color', fixture.stroke)
  await expect(fill).toHaveCSS('border-top-width', fixture.width)
  const pending = waitForProjection()
  await page.getByRole('button', { name: /Start projection|開始投影/ }).click()
  const projection = await pending
  try {
    await expect(projection.locator('[data-slide-element] > div').first()).toHaveCSS(
      'background-color',
      fixture.fill
    )
    await expect(projection.locator('[data-slide-element] > div').first()).toHaveCSS(
      'border-top-color',
      fixture.stroke
    )
    await expect(projection.locator('[data-slide-element] > div').first()).toHaveCSS(
      'border-top-width',
      fixture.width
    )
  } finally {
    await projection.close()
  }
}

for (const fixture of themeFixtures) {
  test(`imports ${fixture.name} and preserves its appearance after reopen and projection`, async ({
    page,
    context
  }) => {
    await page.goto('/')
    await completeOnboarding(page)
    await themeStyleSmoke(page, () => context.waitForEvent('page'), fixture)
  })
}

test('Electron theme solid styles survive import, reopen and projection', async ({
  browserName
}) => {
  test.setTimeout(90_000)
  test.skip(browserName !== 'chromium', 'Electron uses Chromium')
  const executablePath = process.env.HHC_ELECTRON_EXECUTABLE
  test.skip(!executablePath, 'Set HHC_ELECTRON_EXECUTABLE for isolated built-desktop acceptance')
  const userDataPath = await realpath(await mkdtemp(join(tmpdir(), 'hhc-theme-fill-electron-')))
  const app = await electron.launch({
    executablePath,
    args: [resolve('out/main/index.js'), '--user-data-dir=' + userDataPath]
  })
  try {
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userDataPath)
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await completeOnboarding(page)
    for (const fixture of themeFixtures)
      await themeStyleSmoke(page, () => app.waitForEvent('window'), fixture)
    expect(errors).toEqual([])
  } finally {
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
    await app
      .evaluate(({ app }) => app.exit(0))
      .catch((error: unknown) => {
        if (!(error instanceof Error) || !/closed/i.test(error.message)) throw error
      })
    await exited
    await rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
