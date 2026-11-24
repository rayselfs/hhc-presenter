import { _electron, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { completeOnboarding } from './helpers'
import { closePackaged } from './helpers/packaged-app'
import { parseWeeklyDocument, type WeeklyIssue } from '../src/shared/weekly-reader'

test.use({ serviceWorkers: 'block' })

const accountId = 'reader-fixture'
const issue: WeeklyIssue = {
  issueId: '00000000-0000-4000-8000-000000000001',
  documentId: '00000000-0000-4000-8000-000000000002',
  issueNumber: 1800,
  title: 'Testimony',
  issueDate: '2026-11-22',
  revision: 1,
  series: 'general',
  locale: 'zh-Hant'
}
const older = {
  ...issue,
  issueNumber: 1799,
  title: 'Earlier message',
  issueId: '00000000-0000-4000-8000-000000000003',
  documentId: '00000000-0000-4000-8000-000000000004',
  issueDate: '2026-11-15'
}

function documentFixture(): Record<string, unknown> {
  const pages = [
    ['Cover reading'],
    Array.from({ length: 42 }, (_, i) => 'Reading passage ' + (i + 1) + ' — 今天我們一起讀週報。'),
    ['Third printed page'],
    ['Back cover']
  ]
  const sentences = pages.flatMap((paragraphs, p) =>
    paragraphs.map((text, i) => ({
      id: 'p' + p + '-s' + i,
      spans: [{ text, fontRole: 'body' }]
    }))
  )
  const time = Date.now()
  return {
    document: {
      ...issue,
      contentLocale: issue.locale,
      canonicalMetadata: {
        title: issue.title,
        issueNumber: issue.issueNumber,
        subtitle: '',
        date: issue.issueDate
      },
      content: {
        schemaVersion: '1',
        templateVersion: 'v1',
        printedBodyPageCount: 2,
        pages: pages.map((_, i) => ({ id: 'paper-' + i, width: 420, height: 600 })),
        layoutManifest: {
          rendererVersion: 'v1',
          pages: pages.map((paragraphs, p) => ({
            pageId: 'paper-' + p,
            slots: paragraphs.map((text, i) => ({
              id: 'slot-' + p + '-' + i,
              blockId: 'block-' + p + '-' + i,
              componentId: 'body',
              box: { x: 0.05, y: i / paragraphs.length, width: 0.9, height: 0.015 },
              fragments: [
                { sentenceId: 'p' + p + '-s' + i, start: 0, end: Array.from(text).length }
              ]
            }))
          }))
        },
        components: [
          { id: 'body', type: 'bodySection', bodySection: { paragraphs: [{ sentences }] } }
        ]
      }
    },
    access: {
      accountId,
      documentId: issue.documentId,
      series: issue.series,
      contentLocale: issue.locale,
      revision: 1,
      currentRevision: 1,
      traceCode: 'TEST-RECEIPT',
      receiptId: '00000000-0000-4000-8000-000000000009',
      validatedAt: new Date(time).toISOString(),
      offlineValidUntil: new Date(time + 604800000).toISOString()
    }
  }
}

async function installBrowserApi(context: BrowserContext, hasPermission: boolean): Promise<void> {
  const token =
    'header.' +
    Buffer.from(JSON.stringify({ sub: accountId, roles: [], exp: 4102444800 })).toString(
      'base64url'
    ) +
    '.signature'
  await context.route('https://account.alive.org.tw/api/account/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    await route.fulfill({
      json: path.endsWith('/session')
        ? {
            authenticated: true,
            user: {
              id: accountId,
              display_name: 'Reader QA',
              email: 'reader@example.com',
              avatar_url: null
            },
            permissions: [],
            permission_availability: { status: 'available' }
          }
        : path.endsWith('/csrf-token')
          ? { csrf_token: 'csrf' }
          : { access_token: token, expires_in: 3600 }
    })
  })
  await context.route('https://www.alive.org.tw/api/operations/me/access', (route) =>
    route.fulfill({
      json: {
        entitlements: hasPermission ? [{ entitlementCode: 'bulletin.general.zh-Hant.access' }] : []
      }
    })
  )
  await context.route('https://www.alive.org.tw/api/member/bulletins/**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer ' + token)
    if (route.request().method() === 'POST') {
      const body = JSON.stringify({ data: documentFixture(), meta: {}, error: null })
      await route.fulfill({
        body,
        contentType: 'application/json',
        headers: {
          'Access-Control-Expose-Headers': 'X-HHC-Content-SHA256',
          'X-HHC-Content-SHA256': createHash('sha256').update(body).digest('hex')
        }
      })
      return
    }
    const items = [older, issue].map((row) => ({
      ...row,
      canonicalMetadata: { title: row.title },
      contentLocale: row.locale,
      onlineRevision: row.revision
    }))
    await route.fulfill({
      json: {
        data: {
          items: [
            ...items,
            { ...items[0], onlineRevision: null, canonicalMetadata: { title: 'PDF only' } }
          ],
          offset: 0,
          limit: 20,
          total: 3
        }
      }
    })
  })
}

async function verifyReader(page: Page, waitForProjection: () => Promise<Page>): Promise<void> {
  test.setTimeout(90_000)
  await completeOnboarding(page)
  await page.locator('a[href="#/bulletins"]').click()
  const row = page.getByRole('button', { name: /1800-Testimony/ })
  await expect(row).toBeVisible()
  await expect(page.getByRole('button', { name: /PDF only/ })).toHaveCount(0)
  const search = page.getByRole('searchbox')
  await search.fill('1799')
  await expect(page.getByRole('button', { name: /1799-Earlier message/ })).toBeVisible()
  await expect(row).toHaveCount(0)
  await search.fill('Testimony')
  const projectionReady = waitForProjection()
  await row.dblclick()
  const projection = await projectionReady
  await expect(projection.getByText('Cover reading', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Next page|下一頁|下一页/ }).click()
  const source = page
    .locator('[role="region"]')
    .filter({ has: page.locator('[data-bulletin-sentence="p1-s3"]') })
  const target = projection.locator('[role="region"]')
  await expect(target.locator('[data-bulletin-sentence="p1-s0"]')).toBeVisible()
  await expect(source).toHaveCSS('user-select', 'none')
  await page.getByRole('button', { name: /Highlight mode|螢光|畫重點|笔记|筆記/ }).click()
  const sentence = source.locator('[data-bulletin-sentence="p1-s0"]')
  const box = await sentence.boundingBox()
  if (!box) throw new Error('Missing first sentence')
  await page.mouse.move(box.x + 1, box.y + 5)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + 5, { steps: 8 })
  await page.mouse.up()
  const mark = sentence.locator('mark').first()
  await expect(mark).toBeVisible()
  const marked = await mark.innerText()
  await expect(target.locator('mark').first()).toHaveText(marked)
  await source.evaluate((node) => {
    node.scrollTop = node.scrollHeight / 2
  })
  await expect.poll(() => target.evaluate((node) => node.scrollTop)).toBeGreaterThan(50)
  await page.getByRole('button', { name: /Previous page|上一頁|上一页/ }).click()
  await expect(target.getByText('Cover reading', { exact: true })).toBeVisible()
  await projection.close()
  await page.reload()
  await expect(page).toHaveURL(/#\/bulletins$/)
  const reopened = waitForProjection()
  await row.dblclick()
  const nextProjection = await reopened
  await page.getByRole('button', { name: /Next page|下一頁|下一页/ }).click()
  await expect(nextProjection.locator('mark').first()).toHaveText(marked)
}

test('weekly archive searches authorized online issues and follows paper pages, highlights and scroll', async ({
  page,
  context
}) => {
  await installBrowserApi(context, true)
  await page.goto('/')
  await verifyReader(page, () => context.waitForEvent('page'))
})

test('weekly archive denies a signed-in account without a bulletin edition', async ({
  page,
  context
}) => {
  await installBrowserApi(context, false)
  await page.goto('/')
  await completeOnboarding(page)
  await expect(page.getByRole('button', { name: 'Bulletins', exact: true })).toBeDisabled()
  await page.goto('/#/bulletins')
  await expect(page.getByRole('searchbox')).toHaveCount(0)
  await expect(page.getByText('Bulletins require an authorized ministry account.')).toBeVisible()
})

test('Electron bulletin presenter synchronizes preview and projection and retains local highlights', async () => {
  const executable = process.env.HHC_ELECTRON_EXECUTABLE
  test.skip(!executable, 'Set HHC_ELECTRON_EXECUTABLE for built-desktop acceptance')
  if (!executable) return
  const profile = await mkdtemp(join(tmpdir(), 'hhc-bulletins-'))
  const app = await _electron.launch({
    executablePath: executable,
    chromiumSandbox: true,
    args: [resolve('out/main/index.js'), '--user-data-dir=' + profile]
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(
      ({ ipcMain }, fixture) => {
        const handlers = {
          'hhc-auth:get-session': {
            userId: fixture.accountId,
            displayName: 'Reader QA',
            roles: [],
            permissions: [],
            permissionAvailability: { status: 'available' }
          },
          'weekly:editions': [{ series: 'general', locale: 'zh-Hant' }],
          'weekly:list': { items: fixture.issues, total: 2, offset: 0, limit: 20 },
          'weekly:open': fixture.document
        }
        for (const [channel, response] of Object.entries(handlers)) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, () => response)
        }
      },
      {
        accountId,
        issues: [older, issue],
        document: parseWeeklyDocument(documentFixture(), issue, accountId)
      }
    )
    await page.reload()
    await verifyReader(page, () => app.waitForEvent('window'))
  } finally {
    await closePackaged(app)
    await rm(profile, { recursive: true, force: true })
  }
})
