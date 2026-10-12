import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '../src/renderer/src/lib/presentation-media'
import { completeOnboarding, seedRawPptx } from './helpers'
import type { EditablePresentationDocument } from '../src/renderer/src/lib/editable-presentation'
import { prepareSourceHymn } from './helpers/pptx-source-smoke'

const mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const exportButton = /Export PPTX|匯出 PPTX|导出 PPTX/
type DownloadPptx = (name: string) => Promise<Buffer>

async function openFile(page: Page, name: string): Promise<void> {
  await page.getByText(name, { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
}

async function catalogSnapshot(
  page: Page
): Promise<{ items: unknown[]; blobs: unknown[]; drafts: unknown[] }> {
  return page.evaluate(async () => {
    const request = indexedDB.open('hhc-file-explorer')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const tx = db.transaction(['folder-items', 'file-blobs', 'presentation-drafts'])
    const [items, blobs, drafts] = await Promise.all([
      read<import('../src/shared/types/folder').FileItemRecord[]>(
        tx.objectStore('folder-items').getAll()
      ),
      read<import('../src/renderer/src/lib/file-explorer-db').FileBlobRecord[]>(
        tx.objectStore('file-blobs').getAll()
      ),
      read<unknown[]>(tx.objectStore('presentation-drafts').getAll())
    ])
    db.close()
    return {
      items: items.map(
        ({ id, name, url, parentId, mimeType, size, personalOwnerId, sharedRecipientId }) => ({
          id,
          name,
          url,
          parentId,
          mimeType,
          size,
          personalOwnerId,
          sharedRecipientId
        })
      ),
      blobs: await Promise.all(
        blobs.map(async ({ blob, ...record }) => ({
          ...record,
          sha256: blob
            ? Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
              )
                .map((value) => value.toString(16).padStart(2, '0'))
                .join('')
            : null
        }))
      ),
      drafts
    }
  })
}

async function copyCompatibility(
  page: Page,
  bytes: Buffer,
  animated: Buffer,
  download: DownloadPptx
): Promise<void> {
  await page.goto(page.url().replace(/#.*$/, '#/files'))
  const rawId = await seedRawPptx(page, 'Unsupported original.pptx', animated)
  await page.getByText('Unsupported original.pptx', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  await expect(page.getByRole('complementary').getByRole('button')).toHaveCount(22)
  await expect(page.locator('[data-pptx-slide-surface] > *').first()).toBeVisible()
  const before = await catalogSnapshot(page)
  await page.getByRole('button', { name: /Edit a copy|編輯副本|编辑副本/ }).click()
  await expect(page.getByText(/animation|動畫|动画/).first()).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#/presentations/${rawId}$`))
  await expect(page.getByRole('button', { name: /Edit a copy|編輯副本|编辑副本/ })).toBeEnabled()
  expect(await catalogSnapshot(page)).toEqual(before)
  await page.goto(page.url().replace(/#.*$/, '#/files'))
  const supportedRawId = await seedRawPptx(page, 'Supported original.pptx', bytes)
  const supportedBefore = await catalogSnapshot(page)
  await page.getByText('Supported original.pptx', { exact: true }).click({ button: 'right' })
  await page
    .getByRole('menuitem', {
      name: /Convert to Editable Presentation|轉成可編輯簡報|转换为可编辑演示文稿/
    })
    .click()
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
  await expect(page).not.toHaveURL(new RegExp(`#/presentations/${supportedRawId}$`))
  const after = await catalogSnapshot(page)
  expect(after.items).toHaveLength(supportedBefore.items.length + 1)
  expect(after.blobs).toHaveLength(supportedBefore.blobs.length + 1)
  expect(after.drafts).toEqual(supportedBefore.drafts)
  for (const item of supportedBefore.items) expect(after.items).toContainEqual(item)
  for (const blob of supportedBefore.blobs) expect(after.blobs).toContainEqual(blob)
  const exported = await JSZip.loadAsync(await download('copy-native-hymn'))
  expect(
    Object.keys(exported.files).filter((name) => /^ppt\/slides\/[^/]+\.xml$/.test(name))
  ).toHaveLength(22)
  await page.keyboard.press('ControlOrMeta+s')
  await page.reload()
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
  await expect(
    page.locator('.presentation-stage').getByText('主愛永不止息', { exact: true })
  ).toBeVisible()
}

async function nativeHymn(page: Page, download: DownloadPptx): Promise<void> {
  await completeOnboarding(page)
  await page.goto(page.url().replace(/#.*$/, '#/files'))
  const bytes = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const sourceZip = await JSZip.loadAsync(bytes)
  const slidePath = 'ppt/slides/slide1.xml'
  sourceZip.file(
    slidePath,
    (await sourceZip.file(slidePath)!.async('string')).replace(
      '</p:sld>',
      '<p:timing><p:tnLst/></p:timing></p:sld>'
    )
  )
  const animated = await sourceZip.generateAsync({ type: 'nodebuffer' })
  const before = await catalogSnapshot(page)
  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name: 'Unsupported upload.pptx', mimeType: mime, buffer: animated })
  await expect(page.getByText(/animation|動畫|动画/).first()).toBeVisible()
  expect(await catalogSnapshot(page)).toEqual(before)
  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name: 'Export hymn.pptx', mimeType: mime, buffer: bytes })
  await expect(page.getByText('Export hymn.lpdeck', { exact: true })).toBeVisible()
  await openFile(page, 'Export hymn.lpdeck')
  const output = await download('native-hymn')
  const zip = await JSZip.loadAsync(output)
  expect(
    Object.keys(zip.files).filter((name) => /^ppt\/slides\/[^/]+\.xml$/.test(name))
  ).toHaveLength(22)
  expect(await zip.file('ppt/slideMasters/slideMaster1.xml')!.async('string')).not.toContain(
    'buChar'
  )
  await page.goto(page.url().replace(/#.*$/, '#/files'))
  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name: 'Round trip.pptx', mimeType: mime, buffer: output })
  await expect(page.getByText('Round trip.lpdeck', { exact: true })).toBeVisible()
  await openFile(page, 'Round trip.lpdeck')
  await expect(
    page.locator('.presentation-stage').getByText('主愛永不止息', { exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
  await expect(
    page.locator('.presentation-stage').getByText('主愛永不止息', { exact: true })
  ).toBeVisible()
  await copyCompatibility(page, bytes, animated, download)
}

async function sourceHymn(
  page: Page,
  download: DownloadPptx,
  openProjection: () => Promise<Page>
): Promise<void> {
  if (!/#\/(welcome|timer)$/.test(page.url()))
    await page.goto(page.url().replace(/#.*$/, '#/timer'))
  const { id, source } = await prepareSourceHymn(page)
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
  const original = Buffer.from(source.base64, 'base64')
  expect(await download('source-noop')).toEqual(original)
  const stage = page.locator('.presentation-stage')
  await stage.locator('[data-text-content]').first().dblclick()
  await stage.locator('[contenteditable="true"]').fill('主愛永不改變')
  const output = await download('source-edited')
  const before = await JSZip.loadAsync(original)
  const after = await JSZip.loadAsync(output)
  for (const [name, member] of Object.entries(before.files)) {
    if (name === 'ppt/slides/slide1.xml' || member.dir) continue
    expect(await after.file(name)!.async('uint8array'), name).toEqual(
      await member.async('uint8array')
    )
  }
  expect(await after.file('ppt/slides/slide1.xml')!.async('string')).toContain('主愛永不改變')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(stage.getByText('主愛永不止息', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(stage.getByText('主愛永不改變', { exact: true })).toBeVisible()
  const opened = openProjection()
  await page.keyboard.press('F5')
  const projection = await opened
  await expect(projection.getByText('主愛永不改變', { exact: true })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(projection.getByText('Amazing grace', { exact: true })).toBeVisible()
  await page.goto(page.url().replace(/#.*$/, `#/presentations/${id}`))
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
  await download('source-with-projection')
  await expect(projection.getByText('Amazing grace', { exact: true })).toBeVisible()
  await page.goto(page.url().replace(/#.*$/, '#/bible'))
  await expect(projection.getByText('Amazing grace', { exact: true })).toBeVisible()
  await page.goto(page.url().replace(/#.*$/, '#/media'))
  await expect(page.locator('.presenter-current')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(new RegExp(`#/presentations/${id}$`))
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText(/^(Saved|已儲存|已保存)$/)).toBeVisible()
  await page.reload()
  await expect(page.locator('[data-slide-option]')).toHaveCount(22)
  await page.locator('[data-slide-option]').first().click()
  await expect(stage.getByText('主愛永不改變', { exact: true })).toBeVisible()
}

function browserDownload(page: Page, outputPath: (name: string) => string): DownloadPptx {
  return async (name) => {
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: exportButton }).click()
    const download = await pending
    expect(download.suggestedFilename()).toMatch(/\.pptx$/)
    const path = outputPath(`${name}.pptx`)
    await download.saveAs(path)
    return readFile(path)
  }
}

test('downloads a native hymn and reopens all 22 slides', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await nativeHymn(
    page,
    browserDownload(page, (name) => testInfo.outputPath(name))
  )
  expect(errors).toEqual([])
})

test('downloads preserved source with edits, undo and unchanged projection ownership', async ({
  page,
  context
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await sourceHymn(
    page,
    browserDownload(page, (name) => testInfo.outputPath(name)),
    () => context.waitForEvent('page')
  )
  expect(errors).toEqual([])
})

test('downloads current image crop, rotation, gradients, text and notes for independent inspection', async ({
  page
}, testInfo) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  const png = await readFile('e2e/fixtures/pptx-export-quadrants.png')
  const style = {
    fontFamily: 'Noto Sans TC',
    fontSize: 40,
    bold: false,
    italic: false,
    underline: false,
    color: '#111827'
  }
  const document: EditablePresentationDocument = {
    schemaVersion: 1,
    id: 'focus-export',
    name: 'Export focus',
    width: 1280,
    height: 720,
    slideOrder: ['focus-slide'],
    createdAt: 1,
    updatedAt: 1,
    assets: {
      quadrants: {
        id: 'quadrants',
        name: 'Quadrants.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${png.toString('base64')}`
      }
    },
    slides: {
      'focus-slide': {
        id: 'focus-slide',
        name: 'Focus',
        background: { type: 'gradient', from: '#000000', to: '#ffffff', direction: 'left-right' },
        notes: 'Focus notes\nSecond note',
        elementOrder: ['text', 'image', 'rectangle', 'ellipse', 'line'],
        elements: {
          text: {
            id: 'text',
            type: 'text',
            x: 80,
            y: 70,
            width: 1000,
            height: 160,
            rotation: 0,
            opacity: 1,
            ...style,
            text: 'PPTX Export\n\n文字與圖片',
            align: 'left',
            lineHeight: 1.15,
            autoWidth: false,
            autoSize: 'fixed',
            paragraphs: [
              {
                runs: [{ text: 'PPTX Export', ...style, bold: true, highlightColor: '#ffff80' }],
                align: 'left',
                lineSpacing: { kind: 'multiple', value: 1.15 },
                marginLeft: 0,
                textIndent: 0,
                list: null
              },
              {
                runs: [],
                typingStyle: style,
                align: 'left',
                lineSpacing: { kind: 'multiple', value: 1.15 },
                marginLeft: 0,
                textIndent: 0,
                list: null
              },
              {
                runs: [{ text: '文字與圖片', ...style, italic: true, underline: true }],
                align: 'left',
                lineSpacing: { kind: 'multiple', value: 1.15 },
                marginLeft: 0,
                textIndent: 0,
                list: null
              }
            ]
          },
          image: {
            id: 'image',
            type: 'image',
            assetId: 'quadrants',
            x: 80,
            y: 320,
            width: 240,
            height: 160,
            rotation: 0,
            opacity: 1,
            crop: { left: 0.25, right: 0.25, top: 0, bottom: 0.25 },
            borderColor: '#000000',
            borderWidth: 6,
            shadow: 'medium'
          },
          rectangle: {
            id: 'rectangle',
            type: 'shape',
            shape: 'rectangle',
            x: 480,
            y: 320,
            width: 220,
            height: 120,
            rotation: 30,
            opacity: 0.8,
            fillColor: '#ffcc00',
            strokeColor: '#000000',
            strokeWidth: 6
          },
          ellipse: {
            id: 'ellipse',
            type: 'shape',
            shape: 'ellipse',
            x: 850,
            y: 320,
            width: 180,
            height: 120,
            rotation: 0,
            opacity: 1,
            fillColor: '#0099ff',
            strokeColor: '#000000',
            strokeWidth: 4
          },
          line: {
            id: 'line',
            type: 'line',
            x: 80,
            y: 580,
            width: 950,
            height: 1,
            rotation: 0,
            opacity: 1,
            strokeColor: '#9900ff',
            strokeWidth: 5
          }
        }
      }
    }
  }
  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles({
      name: 'Export focus.lpdeck',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE,
      buffer: Buffer.from(JSON.stringify(document))
    })
  await expect(page.getByText('Export focus.lpdeck', { exact: true })).toBeVisible()
  await page.getByText('Export focus.lpdeck', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  await expect(page.locator('[data-slide-option]')).toHaveCount(1)
  await expect(page.locator('.presentation-stage img')).toBeVisible()
  const output = await browserDownload(page, (name) => testInfo.outputPath(name))('focus')
  const zip = await JSZip.loadAsync(output)
  expect(await zip.file('ppt/media/image1.png')!.async('uint8array')).toEqual(new Uint8Array(png))
  expect(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')).toContain(
    'Focus notes'
  )
  await page.screenshot({ path: testInfo.outputPath('focus-editor.png') })
})

test('downloads an edited 50 point font without consumer autofit recalculation', async ({
  page
}, testInfo) => {
  const original = await readFile(
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  const zip = await JSZip.loadAsync(original)
  const part = 'ppt/slides/slide1.xml'
  const xml = await zip.file(part)!.async('string')
  expect(xml).toContain('<a:bodyPr')
  const scaled = xml.replace(
    /<a:bodyPr([^>]*)\/>/,
    '<a:bodyPr$1><a:normAutofit fontScale="50000"/></a:bodyPr>'
  )
  expect(scaled).not.toBe(xml)
  zip.file(part, scaled)
  await page.goto('/')
  await prepareSourceHymn(page, await zip.generateAsync({ type: 'nodebuffer' }))
  const stage = page.locator('.presentation-stage')
  await stage.locator('[data-text-content]').first().dblclick()
  await stage.locator('[contenteditable="true"]').press('ControlOrMeta+a')
  const input = page.getByRole('textbox', { name: /^(Font size|字型大小|字体大小)$/ })
  await input.fill('50')
  await input.press('Enter')
  const output = await browserDownload(page, (name) => testInfo.outputPath(name))(
    'source-scaled-font'
  )
  const patched = await (await JSZip.loadAsync(output)).file(part)!.async('string')
  expect(patched).not.toContain('normAutofit')
  expect(patched).toContain('noAutofit')
  expect(
    [...patched.matchAll(/<a:rPr\b[^>]*\bsz="([^"]+)"/g)].map((match) => Number(match[1]))
  ).toEqual([5000, 5000])
  expect([...patched.matchAll(/<a:t(?:\s[^>]*)?>/g)]).toHaveLength(2)
})

test('Electron PPTX downloads use isolated data and download paths', async ({
  browserName
}, testInfo) => {
  test.setTimeout(180_000)
  test.skip(browserName !== 'chromium', 'Electron uses Chromium')
  const executablePath = process.env.HHC_ELECTRON_EXECUTABLE
  test.skip(!executablePath, 'Set HHC_ELECTRON_EXECUTABLE for isolated built-desktop acceptance')
  const userDataPath = await realpath(await mkdtemp(join(tmpdir(), 'hhc-pptx-export-electron-')))
  const app = await electron.launch({
    executablePath,
    args: [resolve('out/main/index.js'), `--user-data-dir=${userDataPath}`]
  })
  try {
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userDataPath)
    await app.evaluate(
      ({ session }, path) => session.defaultSession.setDownloadPath(path),
      join(userDataPath, 'downloads')
    )
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const download: DownloadPptx = async (name) => {
      const path = testInfo.outputPath(`${name}.pptx`)
      const pending = app.evaluate(
        ({ session }, path) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('PPTX download timed out')), 30_000)
            session.defaultSession.once('will-download', (_event, item) => {
              item.setSavePath(path)
              item.once('done', (_event, state) => {
                clearTimeout(timer)
                if (state === 'completed') resolve(item.getSavePath())
                else reject(new Error(`PPTX download ${state}`))
              })
            })
          }),
        path
      )
      await page.getByRole('button', { name: exportButton }).click()
      expect(await pending).toBe(path)
      return readFile(path)
    }
    await nativeHymn(page, download)
    await sourceHymn(page, download, () => app.waitForEvent('window'))
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('electron-pptx-export.png') })
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
