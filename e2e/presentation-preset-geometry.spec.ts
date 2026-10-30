import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import type {
  EditablePresentationDocument,
  EditableShapeElement,
  EditableTextElement,
  EditableTextStyle
} from '../src/renderer/src/lib/editable-presentation'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '../src/renderer/src/lib/presentation-media'
import { completeOnboarding } from './helpers'

const presets = [
  'roundRect',
  'triangle',
  'rtTriangle',
  'diamond',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow'
] as const
const mainPaths = {
  roundRect:
    'M50 0 L150 0 A50 50 0 0 1 200 50 L200 50 A50 50 0 0 1 150 100 L50 100 A50 50 0 0 1 0 50 L0 50 A50 50 0 0 1 50 0 Z',
  triangle: 'M0 100 L60 0 L200 100 Z',
  rtTriangle: 'M0 0 L0 100 L200 100 Z',
  diamond: 'M100 0 L200 50 L100 100 L0 50 Z',
  rightArrow: 'M0 35 L125 35 L125 0 L200 50 L125 100 L125 65 L0 65 Z',
  leftArrow: 'M200 35 L75 35 L75 0 L0 50 L75 100 L75 65 L200 65 Z',
  upArrow: 'M70 100 L70 75 L0 75 L100 0 L200 75 L130 75 L130 100 Z',
  downArrow: 'M70 0 L70 25 L0 25 L100 100 L200 25 L130 25 L130 0 Z'
}
const exportButton = /Export PPTX|匯出 PPTX|导出 PPTX/
type Download = (name: string) => Promise<Buffer>

function geometryFixture(): EditablePresentationDocument {
  const style: EditableTextStyle = {
    fontFamily: 'Noto Sans TC',
    fontSize: 32,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    baseline: 'normal',
    characterSpacing: 0,
    highlightColor: null,
    color: '#111827'
  }
  return {
    schemaVersion: 3,
    id: 'preset-geometry',
    name: 'Preset geometry',
    width: 1280,
    height: 720,
    createdAt: 1,
    updatedAt: 1,
    assets: {},
    slideOrder: presets.map((preset) => preset),
    slides: Object.fromEntries(
      presets.map((preset) => {
        const adjustments =
          preset === 'roundRect' || preset === 'triangle'
            ? [30000]
            : preset.endsWith('Arrow')
              ? [30000, 75000]
              : undefined
        const shapes: EditableShapeElement[] = [
          { id: 'main', x: 120, y: 140, width: 200, height: 100, rotation: 35 },
          { id: 'wide', x: 60, y: 420, width: 1000, height: 2, rotation: 0 },
          { id: 'tall', x: 1140, y: 160, width: 2, height: 480, rotation: 0 }
        ].map((frame) => ({
          ...frame,
          type: 'shape',
          shape: preset,
          opacity: 1,
          fillColor: '#2563EB',
          strokeColor: '#111827',
          strokeWidth: 2,
          ...(adjustments === undefined
            ? {}
            : {
                adjustments: adjustments.map((value, index) =>
                  frame.id === 'wide' && index === adjustments.length - 1 ? 2147483647 : value
                )
              })
        }))
        const run = { text: '主愛永不止息 · ' + preset, ...style }
        const label: EditableTextElement = {
          id: 'label',
          type: 'text',
          x: 40,
          y: 30,
          width: 1100,
          height: 70,
          rotation: 0,
          opacity: 1,
          autoWidth: false,
          autoSize: 'fixed',
          verticalAlign: 'top',
          textInsets: { top: 0, left: 0, bottom: 0, right: 0 },
          ...style,
          text: run.text,
          align: 'left',
          lineHeight: 1.15,
          paragraphs: [
            {
              runs: [run],
              typingStyle: run,
              align: 'left',
              list: null,
              lineSpacing: { kind: 'multiple', value: 1.15 },
              marginLeft: 0,
              textIndent: 0
            }
          ]
        }
        return [
          preset,
          {
            id: preset,
            name: preset,
            notes: 'Explicit v3 preset consumer fixture',
            background: { type: 'solid', color: '#FFFFFF', transparency: 0 },
            elementOrder: ['main', 'wide', 'tall', 'label'],
            elements: Object.fromEntries([...shapes, label].map((element) => [element.id, element]))
          }
        ]
      })
    )
  }
}

async function openFixture(
  page: Page,
  document: EditablePresentationDocument,
  name: string
): Promise<void> {
  await page.goto(page.url().replace(/#.*$/, '#/files'))
  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles({
      name: name + '.lpdeck',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE,
      buffer: Buffer.from(JSON.stringify(document))
    })
  await page.getByText(name + '.lpdeck', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  await expect(page.locator('[data-slide-option]')).toHaveCount(8)
}

async function savedDocument(page: Page): Promise<EditablePresentationDocument> {
  const id = decodeURIComponent(page.url().split('/').at(-1)!)
  return page.evaluate(async (id) => {
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
    const item = await read<{ url: string }>(
      db.transaction('folder-items').objectStore('folder-items').get(id)
    )
    const record = await read<{ blob: Blob }>(
      db.transaction('file-blobs').objectStore('file-blobs').get(item.url.slice(5))
    )
    db.close()
    return JSON.parse(await record.blob.text()) as EditablePresentationDocument
  }, id)
}

async function retainSource(
  bytes: Buffer,
  document: EditablePresentationDocument
): Promise<{ bytes: Buffer; document: EditablePresentationDocument }> {
  const zip = await JSZip.loadAsync(bytes)
  for (let index = 0; index < document.slideOrder.length; index++) {
    const part = 'ppt/slides/slide' + (index + 1) + '.xml'
    const xml = await zip.file(part)!.async('string')
    expect(xml).toContain('<a:prstGeom')
    zip.file(
      part,
      xml
        .replace(/<a:prstGeom /g, '<a:prstGeom xmlns:q="urn:hhc:preset-evidence" q:retained="yes" ')
        .replace(
          /<\/a:prstGeom>/g,
          '<a:extLst><a:ext uri="preset-evidence"><q:payload xmlns:q="urn:hhc:preset-evidence" value="untouched"/></a:ext></a:extLst></a:prstGeom>'
        )
    )
  }
  zip.file('custom/preset-opaque.bin', Buffer.from([11, 22, 33, 44]))
  zip.file(
    '[Content_Types].xml',
    (await zip.file('[Content_Types].xml')!.async('string')).replace(
      '</Types>',
      '<Default Extension="bin" ContentType="application/octet-stream"/></Types>'
    )
  )
  const original = await zip.generateAsync({ type: 'nodebuffer' })
  const retained = structuredClone(document)
  retained.id = 'source-' + retained.id
  retained.name = 'Preset source'
  retained.pptxSource = {
    version: 1,
    base64: original.toString('base64'),
    sha256: createHash('sha256').update(original).digest('hex')
  }
  retained.slideOrder.forEach((id, index) => {
    const slide = retained.slides[id]
    slide.pptxSourcePart = 'ppt/slides/slide' + (index + 1) + '.xml'
    slide.elementOrder.forEach((id, ordinal) => {
      const element = slide.elements[id]
      element.pptxSourceNode = {
        id: String(ordinal + 2),
        role: element.type === 'text' ? 'text' : 'geometry'
      }
    })
  })
  return { bytes: original, document: retained }
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText(/^(Saved|已儲存|已保存)$/)).toBeVisible()
}

async function runGeometrySmoke(
  page: Page,
  download: Download,
  openProjection: () => Promise<Page>,
  outputPath: (name: string) => string
): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await completeOnboarding(page)
  await openFixture(page, geometryFixture(), 'Preset geometry')
  const stage = page.locator('.presentation-stage')
  const slides = page.locator('[data-slide-option]')
  await expect(stage.locator('[data-slide-element]')).toHaveCount(4)
  await page.getByRole('button', { name: /^(Shapes|形狀|形状)$/ }).click()
  await expect(
    page.getByRole('menuitem', { name: /^(Rounded rectangle|圓角矩形|圆角矩形)$/ })
  ).toBeVisible()
  await page.getByRole('menuitem', { name: /^(Triangle|三角形)$/ }).click()
  await expect(stage.locator('[data-slide-element]')).toHaveCount(5)
  await page.getByRole('button', { name: /^(Undo|復原|撤銷|撤销)$/ }).click()
  await expect(stage.locator('[data-slide-element]')).toHaveCount(4)
  await stage.locator('svg[data-shape-kind="roundRect"]').first().click()
  const radius = page.getByRole('spinbutton', {
    name: /^(Corner radius|圓角半徑|圆角半径) \(%\)$/,
    includeHidden: true
  })
  const openParameters = async (): Promise<void> => {
    if (!(await radius.isVisible())) {
      await page.getByRole('button', { name: /^(Shape parameters|形狀參數|形状参数)$/ }).click()
    }
    await expect(radius).toBeVisible()
  }
  const closeParameters = async (): Promise<void> => {
    const close = page.getByRole('button', {
      name: /^Close (Shape parameters|形狀參數|形状参数)$/
    })
    if (await close.isVisible()) await close.click()
  }
  await openParameters()
  await expect(radius).toHaveValue('30')
  await radius.fill('40')
  await closeParameters()
  await page.getByRole('button', { name: /^(Undo|復原|撤銷|撤销)$/ }).click()
  await expect(radius).toHaveValue('30')
  await page.getByRole('button', { name: /^(Redo|重做)$/ }).click()
  await expect(radius).toHaveValue('40')
  const handle = page.getByRole('button', {
    name: /Adjust corner radius|調整圓角半徑|调整圆角半径/
  })
  const box = await handle.boundingBox()
  const surface = await stage.locator('[data-slide-surface]').boundingBox()
  if (!box || !surface) throw new Error('Adjustment surface is not visible')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const scale = surface.width / 1280
  const angle = (35 * Math.PI) / 180
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 20 * scale * Math.cos(angle), y + 20 * scale * Math.sin(angle), {
    steps: 5
  })
  await page.mouse.up()
  await expect(radius).toHaveValue('50')
  await page.getByRole('button', { name: /^(Undo|復原|撤銷|撤销)$/ }).click()
  await expect(radius).toHaveValue('40')
  await page.getByRole('button', { name: /^(Redo|重做)$/ }).click()
  await expect(radius).toHaveValue('50')
  const cancelBox = await handle.boundingBox()
  if (!cancelBox) throw new Error('Adjustment handle disappeared')
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    cancelBox.x + cancelBox.width / 2 - 20 * scale * Math.cos(angle),
    cancelBox.y + cancelBox.height / 2 - 20 * scale * Math.sin(angle),
    { steps: 5 }
  )
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(radius).toHaveValue('50')
  await save(page)
  const current = await savedDocument(page)
  expect(current.schemaVersion).toBe(3)
  expect(current.slides[current.slideOrder[0]].elements.main).toMatchObject({
    adjustments: [50000]
  })
  await writeFile(outputPath('native-fixture.lpdeck'), JSON.stringify(current, null, 2))
  await page.reload()
  await expect(slides).toHaveCount(8)
  for (let index = 0; index < presets.length; index++) {
    await slides.nth(index).click()
    await expect(stage.locator('svg[data-shape-kind="' + presets[index] + '"] path')).toHaveCount(3)
    await expect(
      stage.locator('svg[data-shape-kind="' + presets[index] + '"] path').first()
    ).toHaveAttribute('d', mainPaths[presets[index]])
    await expect(
      stage.locator('svg[data-shape-kind="' + presets[index] + '"] path').first()
    ).toHaveAttribute(
      'stroke-linejoin',
      ['rightArrow', 'upArrow', 'downArrow'].includes(presets[index]) ? 'miter' : 'round'
    )
    await expect(
      stage.locator('svg[data-shape-kind="' + presets[index] + '"] path').first()
    ).toHaveAttribute('stroke-miterlimit', '8')
    await expect(stage.getByText('主愛永不止息 · ' + presets[index], { exact: true })).toBeVisible()
    await stage.screenshot({ path: outputPath('stage-' + presets[index] + '.png') })
  }
  await slides.first().click()
  const editorUrl = page.url()
  const pending = openProjection()
  await page.keyboard.press('F5')
  const projection = await pending
  projection.on('pageerror', (error) => errors.push(error.message))
  try {
    const projected = projection.locator('svg[data-shape-kind="roundRect"] path').first()
    await expect(projected).toHaveAttribute('d', mainPaths.roundRect)
    await page.goto(page.url().replace(/#.*$/, '#/files'))
    await expect(
      page.locator('input[type="file"][multiple]:not([webkitdirectory])').first()
    ).toBeAttached()
    await expect(projected).toHaveAttribute('d', mainPaths.roundRect)
    await page.goto(editorUrl)
    await expect(slides).toHaveCount(8)
    const native = await download('native-presets')
    const nativeZip = await JSZip.loadAsync(native)
    for (let index = 0; index < presets.length; index++) {
      const xml = await nativeZip.file('ppt/slides/slide' + (index + 1) + '.xml')!.async('string')
      expect(xml.match(new RegExp('prst="' + presets[index] + '"', 'g'))).toHaveLength(3)
      expect(xml).toContain('rot="2100000"')
    }
    const source = await retainSource(native, current)
    await writeFile(outputPath('original-presets.pptx'), source.bytes)
    await writeFile(outputPath('source-fixture.lpdeck'), JSON.stringify(source.document, null, 2))
    await openFixture(page, source.document, 'Preset source')
    expect(Buffer.compare(await download('source-no-op-presets'), source.bytes)).toBe(0)
    await stage.locator('svg[data-shape-kind="roundRect"]').first().click()
    await openParameters()
    await radius.fill('25')
    await closeParameters()
    await expect(projected).toHaveAttribute('d', mainPaths.roundRect)
    await save(page)
    await writeFile(
      outputPath('source-adjusted-fixture.lpdeck'),
      JSON.stringify(await savedDocument(page), null, 2)
    )
    const adjusted = await download('source-adjusted-presets')
    const before = await JSZip.loadAsync(source.bytes)
    const after = await JSZip.loadAsync(adjusted)
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort())
    for (const [name, entry] of Object.entries(before.files)) {
      if (entry.dir || name === 'ppt/slides/slide1.xml') continue
      expect(await after.file(name)!.async('uint8array'), name).toEqual(
        await entry.async('uint8array')
      )
    }
    const changed = await after.file('ppt/slides/slide1.xml')!.async('string')
    expect(changed).toContain('fmla="val 25000"')
    expect(changed.match(/q:retained="yes"/g)).toHaveLength(4)
    expect(changed.match(/value="untouched"/g)).toHaveLength(4)
    expect(errors).toEqual([])
    await page.screenshot({ path: outputPath('source-adjusted-editor.png') })
    await projection.screenshot({ path: outputPath('projection-owner-preserved.png') })
  } finally {
    await projection.close()
  }
}

test('browser v3 preset geometry survives editing, projection, native/source downloads and reopen', async ({
  page,
  context
}, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/')
  const download: Download = async (name) => {
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: exportButton }).click()
    const artifact = await pending
    const path = testInfo.outputPath(name + '.pptx')
    await artifact.saveAs(path)
    return readFile(path)
  }
  await runGeometrySmoke(
    page,
    download,
    () => context.waitForEvent('page'),
    (name) => testInfo.outputPath(name)
  )
})

test('Electron v3 preset geometry uses isolated data and native/source downloads', async ({
  browserName
}, testInfo) => {
  test.setTimeout(180_000)
  test.skip(browserName !== 'chromium', 'Electron uses Chromium')
  const executablePath = process.env.HHC_ELECTRON_EXECUTABLE
  test.skip(!executablePath, 'Set HHC_ELECTRON_EXECUTABLE for isolated built-desktop acceptance')
  const userDataPath = await realpath(
    await mkdtemp(join(tmpdir(), 'hhc-preset-geometry-electron-'))
  )
  const app = await electron.launch({
    executablePath,
    args: [resolve('out/main/index.js'), '--user-data-dir=' + userDataPath]
  })
  try {
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userDataPath)
    const page = await app.firstWindow()
    const download: Download = async (name) => {
      const path = testInfo.outputPath(name + '.pptx')
      const pending = app.evaluate(
        ({ session }, path) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('PPTX download timed out')), 30_000)
            session.defaultSession.once('will-download', (_event, item) => {
              item.setSavePath(path)
              item.once('done', (_event, state) => {
                clearTimeout(timer)
                if (state === 'completed') resolve(item.getSavePath())
                else reject(new Error('PPTX download ' + state))
              })
            })
          }),
        path
      )
      await page.getByRole('button', { name: exportButton }).click()
      expect(await pending).toBe(path)
      return readFile(path)
    }
    await runGeometrySmoke(
      page,
      download,
      () => app.waitForEvent('window'),
      (name) => testInfo.outputPath(name)
    )
  } catch (error) {
    await Promise.allSettled(
      app
        .windows()
        .map((page, index) =>
          page.screenshot({ path: testInfo.outputPath('electron-failure-' + index + '.png') })
        )
    )
    throw error
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
