import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'

test.use({
  launchOptions: {
    channel: 'chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  },
  permissions: ['camera']
})

async function selectCamera(page: Page): Promise<void> {
  await page.getByTestId('camera-source-selector').click()
  await expect(page.getByRole('option').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('option')).toHaveCount(0)
  await page.getByTestId('camera-source-selector').click()
  await page.getByRole('option').first().click()
}

test('projects one camera, restores framing after navigation, and releases capture outside Camera', async ({
  page,
  context
}) => {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    Reflect.set(window, '__cameraTracks', [])
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints)
      Reflect.get(window, '__cameraTracks').push(...stream.getTracks())
      return stream
    }
  })
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/camera')
  const workspace = page.locator('section').filter({ has: page.getByTestId('camera-editor') })
  await selectCamera(page)
  await expect
    .poll(() =>
      page
        .locator('[data-testid=camera-editor] video')
        .evaluate((video: HTMLVideoElement) => video.videoWidth)
    )
    .toBeGreaterThan(0)
  const popup = context.waitForEvent('page')
  await page
    .locator('header')
    .getByRole('button', { name: /^Start projection$|^開始投影$|^开始投影$/ })
    .click()
  let projection = await popup
  await expect(projection.getByTestId('camera-projection')).toBeVisible()
  await expect
    .poll(
      () => projection.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth),
      { timeout: 15000 }
    )
    .toBeGreaterThan(0)
  const editor = page.getByTestId('camera-editor')
  const bounds = await editor.boundingBox()
  if (!bounds) throw new Error('Camera editor is not visible')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height / 2)
  await page.mouse.up()
  await expect(workspace.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('192')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(workspace.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('202')
  await workspace.getByRole('spinbutton', { name: /Width|寬度|宽度/ }).fill('1200')
  const handle = await page.getByTestId('camera-resize-se').boundingBox()
  if (!handle) throw new Error('Resize handle is not visible')
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x - bounds.width * 0.1, handle.y - bounds.height * 0.1)
  await page.mouse.up()
  await expect(page.locator('[data-testid^="camera-resize-"]')).toHaveCount(8)
  const side = await page.getByTestId('camera-resize-e').boundingBox()
  if (!side) throw new Error('Side handle is not visible')
  await page.mouse.move(side.x + side.width / 2, side.y + side.height / 2)
  await page.mouse.down()
  await page.mouse.move(side.x - 30, side.y + side.height / 2)
  await page.mouse.up()
  const frame = JSON.parse((await editor.getByTestId('camera-stage').getAttribute('data-frame'))!)
  expect(frame.width).toBeLessThan(1920)
  expect(frame.width / frame.height).toBeCloseTo(16 / 9)
  await expect
    .poll(() => projection.getByTestId('camera-stage').getAttribute('data-frame'))
    .toBe(JSON.stringify(frame))
  const lock = workspace.getByRole('button', {
    name: /^(Lock|Unlock) framing$|^(鎖定|解鎖)取景$|^(锁定|解锁)取景$/
  })
  const sourceFrame = page.getByTestId('camera-frame')
  const unlockedColor = await sourceFrame.evaluate((node) => getComputedStyle(node).borderColor)
  await lock.click()
  await expect(sourceFrame).toBeVisible()
  await expect(sourceFrame).toHaveClass(/border-danger/)
  expect(await sourceFrame.evaluate((node) => getComputedStyle(node).borderColor)).not.toBe(
    unlockedColor
  )
  await expect(page.getByTestId('camera-lock-indicator')).toBeVisible()
  await expect(lock).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-testid^="camera-resize-"]')).toHaveCount(0)
  await expect(workspace.getByRole('button', { name: /^Reset$|^重設$|^重设$/ })).toBeDisabled()
  for (const input of await workspace.getByRole('spinbutton').all())
    await expect(input).toBeDisabled()
  await page.screenshot({ path: '/tmp/hhc-camera-locked.png' })
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height / 2)
  await page.mouse.up()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(editor.getByTestId('camera-stage')).toHaveAttribute(
    'data-frame',
    JSON.stringify(frame)
  )
  await expect(projection.getByTestId('camera-stage')).toHaveAttribute(
    'data-frame',
    JSON.stringify(frame)
  )
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-testid^="camera-resize-"]')).toHaveCount(8)
  await workspace.getByRole('button', { name: /^Reset$|^重設$|^重设$/ }).click()
  await expect(workspace.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('0')
  await workspace.getByRole('spinbutton', { name: 'X', exact: true }).fill('4000')
  const hiddenHandle = await page.getByTestId('camera-resize-e').boundingBox()
  expect(hiddenHandle!.x).toBeGreaterThan(bounds.x + bounds.width)
  await workspace.getByRole('button', { name: /^Reset$|^重設$|^重设$/ }).click()
  await workspace.getByRole('spinbutton', { name: /Width|寬度|宽度/ }).fill('1200')
  await workspace.getByRole('spinbutton', { name: 'X', exact: true }).fill('360')
  await workspace.getByRole('spinbutton', { name: 'Y', exact: true }).fill('200')
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
    await expect(page.locator('html')).toHaveCSS('color-scheme', dark ? 'dark' : 'light')
    await expect(editor).toHaveCSS('outline-style', 'solid')
    const foreground = await workspace.evaluate((element) => getComputedStyle(element).color)
    await expect(page.getByTestId('camera-source-selector')).toHaveCSS('color', foreground)
    await page.screenshot({ path: `/tmp/hhc-camera-${dark ? 'dark' : 'light'}.png` })
  }
  await workspace.getByRole('spinbutton', { name: 'X', exact: true }).fill('120')
  await expect
    .poll(() => projection.getByTestId('camera-stage').getAttribute('data-frame'))
    .toContain('"x":120')
  await workspace.getByRole('spinbutton', { name: /Width|寬度|宽度/ }).fill('960')
  await expect
    .poll(() => projection.getByTestId('camera-stage').getAttribute('data-frame'))
    .toContain('"width":960')
  const savedFrame = await editor.getByTestId('camera-stage').getAttribute('data-frame')
  await projection.reload()
  await expect
    .poll(
      () => projection.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth),
      { timeout: 15000 }
    )
    .toBeGreaterThan(0)
  await lock.click()
  await page.locator('nav a[href="#/files"]').click()
  await expect.poll(() => projection.isClosed()).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(window, '__cameraTracks').filter(
            (track: MediaStreamTrack) => track.readyState === 'live'
          ).length
      )
    )
    .toBe(0)
  await page.getByRole('link', { name: /^Camera$|^攝影機$|^摄像头$/, exact: true }).click()
  await expect
    .poll(() => editor.getByTestId('camera-stage').getAttribute('data-frame'))
    .toBe(savedFrame)
  await expect(lock).toHaveAttribute('aria-pressed', 'true')
  await lock.click()
  const restoredPopup = context.waitForEvent('page')
  await page
    .locator('header')
    .getByRole('button', { name: /^Start projection$|^開始投影$|^开始投影$/ })
    .click()
  projection = await restoredPopup
  await expect(projection.getByTestId('camera-projection')).toBeVisible()
  await page.evaluate(() => {
    for (const track of Reflect.get(window, '__cameraTracks') as MediaStreamTrack[]) {
      track.stop()
      track.dispatchEvent(new Event('ended'))
    }
  })
  await expect(workspace.getByRole('alert')).toBeVisible()
  await expect
    .poll(() =>
      projection.locator('video').evaluate((video: HTMLVideoElement) => video.srcObject === null)
    )
    .toBe(true)
  await workspace.getByRole('button', { name: /^Retry$|^重試$|^重试$/ }).click()
  await expect
    .poll(
      () => projection.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth),
      { timeout: 15000 }
    )
    .toBeGreaterThan(0)
  await page
    .locator('header')
    .getByRole('button', { name: /^Stop projection$|^停止投影$/ })
    .click()
  await expect.poll(() => projection.isClosed()).toBe(true)
  await expect
    .poll(() =>
      workspace
        .locator('video')
        .evaluate(
          (video: HTMLVideoElement) =>
            (video.srcObject as MediaStream)
              .getVideoTracks()
              .filter((track) => track.readyState === 'live').length
        )
    )
    .toBe(1)
  await page.locator('nav a[href="#/files"]').click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(window, '__cameraTracks').filter(
            (track: MediaStreamTrack) => track.readyState === 'live'
          ).length
      )
    )
    .toBe(0)
})

test('allows retry after camera permission is denied', async ({ page }) => {
  await page.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    let denied = false
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!denied) {
        denied = true
        throw new DOMException('Denied by test', 'NotAllowedError')
      }
      return capture(constraints)
    }
  })
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/camera')
  const workspace = page.locator('section').filter({ has: page.getByTestId('camera-editor') })
  await selectCamera(page)
  await expect(workspace.getByRole('alert')).toBeVisible()
  await expect(
    page.locator('header').getByRole('button', { name: /^Start projection$|^開始投影$|^开始投影$/ })
  ).toBeDisabled()
  await workspace.getByRole('button', { name: /^Retry$|^重試$|^重试$/ }).click()
  await expect(workspace.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(() => workspace.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth))
    .toBeGreaterThan(0)
})

test('remembers the camera across page reload without starting projection', async ({
  page,
  context
}) => {
  await page.goto('/')
  await completeOnboarding(page)
  await page.getByRole('link', { name: /^Camera$|^攝影機$|^摄像头$/, exact: true }).click()
  await expect(page.getByTestId('camera-editor')).toBeVisible()
  await selectCamera(page)
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth))
    .toBeGreaterThan(0)
  const deviceId = await page
    .locator('video')
    .evaluate(
      (video: HTMLVideoElement) =>
        (video.srcObject as MediaStream).getVideoTracks()[0].getSettings().deviceId
    )
  expect(deviceId).not.toBe('')
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('123')
  await page.getByRole('spinbutton', { name: /Width|寬度|宽度/ }).fill('960')
  const savedFrame = await page.getByTestId('camera-stage').getAttribute('data-frame')
  await page.reload()
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth))
    .toBeGreaterThan(0)
  expect(
    await page
      .locator('video')
      .evaluate(
        (video: HTMLVideoElement) =>
          (video.srcObject as MediaStream).getVideoTracks()[0].getSettings().deviceId
      )
  ).toBe(deviceId)
  await expect(page.getByTestId('camera-stage')).toHaveAttribute('data-frame', savedFrame!)
  expect(context.pages()).toHaveLength(1)
  await page.locator('nav a[href="#/files"]').click()
  await page.getByRole('link', { name: /^Camera$|^攝影機$|^摄像头$/, exact: true }).click()
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth))
    .toBeGreaterThan(0)
  await page.addInitScript(() => {
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    navigator.mediaDevices.enumerateDevices = async () =>
      (await enumerate()).filter((device) => device.kind !== 'videoinput')
  })
  await page.reload()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect
    .poll(() =>
      page.locator('video').evaluate((video: HTMLVideoElement) => video.srcObject === null)
    )
    .toBe(true)
})
