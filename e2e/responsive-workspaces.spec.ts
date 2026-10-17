import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { completeOnboarding } from './helpers'

async function expectProjectionActionGeometry(action: Locator): Promise<void> {
  await expect(action).toBeVisible()
  await expect(async () => {
    const box = await action.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBe(40)
    expect(box!.height).toBe(40)
    expect(Math.abs(box!.y - 8)).toBeLessThanOrEqual(1)
    expect(Math.abs(1200 - box!.x - box!.width - 8)).toBeLessThanOrEqual(1)
  }).toPass({ timeout: 5_000 })
}

type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const HANDLE_DIRECTIONS: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const HANDLE_LABELS: Record<ResizeHandle, string> = {
  nw: 'top left',
  n: 'top',
  ne: 'top right',
  e: 'right',
  se: 'bottom right',
  s: 'bottom',
  sw: 'bottom left',
  w: 'left'
}

type GeometryChange = Record<'x' | 'y' | 'width' | 'height', boolean>

const FIXED_GEOMETRY_CHANGES: Record<ResizeHandle, GeometryChange> = {
  nw: { x: true, y: true, width: true, height: true },
  n: { x: false, y: true, width: false, height: true },
  ne: { x: false, y: true, width: true, height: true },
  e: { x: false, y: false, width: true, height: false },
  se: { x: false, y: false, width: true, height: true },
  s: { x: false, y: false, width: false, height: true },
  sw: { x: true, y: false, width: true, height: true },
  w: { x: true, y: false, width: true, height: false }
}

const CONTENT_HEIGHT_GEOMETRY_CHANGES: Record<ResizeHandle, GeometryChange> = {
  nw: { x: true, y: false, width: true, height: false },
  n: { x: false, y: false, width: false, height: false },
  ne: { x: false, y: false, width: true, height: false },
  e: { x: false, y: false, width: true, height: false },
  se: { x: false, y: false, width: true, height: false },
  s: { x: false, y: false, width: false, height: false },
  sw: { x: true, y: false, width: true, height: false },
  w: { x: true, y: false, width: true, height: false }
}

async function selectSlideElement(element: Locator): Promise<void> {
  await element.scrollIntoViewIfNeeded()
  await element.evaluate((target) => (target as HTMLElement).click())
}

async function expectEffectiveHandleTarget(
  handle: Locator,
  expectedDirection: ResizeHandle
): Promise<void> {
  await expect(handle).toBeVisible()
  await handle.evaluate(async (element) => {
    const viewport = element.closest('[data-testid="presentation-canvas-viewport"]')
    if (!(viewport instanceof HTMLElement)) return
    const rect = element.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const inset = 13
    if (rect.left < viewportRect.left + inset) {
      viewport.scrollLeft += rect.left - viewportRect.left - inset
    } else if (rect.right > viewportRect.right - inset) {
      viewport.scrollLeft += rect.right - viewportRect.right + inset
    }
    if (rect.top < viewportRect.top + inset) {
      viewport.scrollTop += rect.top - viewportRect.top - inset
    } else if (rect.bottom > viewportRect.bottom - inset) {
      viewport.scrollTop += rect.bottom - viewportRect.bottom + inset
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  })
  const effective = await handle.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const clips: Array<{ tag: string; className: string; rect: DOMRect; overflow: string }> = []
    let left = rect.left
    let top = rect.top
    let right = rect.right
    let bottom = rect.bottom
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      const clip = ancestor.getBoundingClientRect()
      if (/hidden|clip/.test(style.overflowX) || /hidden|clip/.test(style.overflowY)) {
        clips.push({
          tag: ancestor.tagName,
          className: ancestor.className,
          rect: clip,
          overflow: `${style.overflowX}/${style.overflowY}`
        })
      }
      if (/hidden|clip/.test(style.overflowX)) {
        left = Math.max(left, clip.left)
        right = Math.min(right, clip.right)
      }
      if (/hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, clip.top)
        bottom = Math.min(bottom, clip.bottom)
      }
    }
    left = Math.max(0, left)
    top = Math.max(0, top)
    right = Math.min(innerWidth, right)
    bottom = Math.min(innerHeight, bottom)
    const centerX = (rect.left + rect.right) / 2
    const centerY = (rect.top + rect.bottom) / 2
    return {
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      hitHandle: document
        .elementFromPoint(centerX, centerY)
        ?.closest<HTMLElement>('[data-resize-handle]')?.dataset.resizeHandle,
      rect,
      clips,
      surface: element.closest('[data-slide-surface]')?.getBoundingClientRect(),
      chrome: element.closest('[data-selection-chrome]')?.getBoundingClientRect(),
      chromeStyle: element.closest('[data-selection-chrome]')?.getAttribute('style'),
      handleStyle: element.getAttribute('style'),
      layerStyle: element.closest('[data-selection-layer]')?.getAttribute('style'),
      viewport: element
        .closest('[data-testid="presentation-canvas"]')
        ?.parentElement?.parentElement?.getBoundingClientRect(),
      zoom: document.querySelector<HTMLInputElement>('input[type="range"]')?.value
    }
  })
  expect(effective.width, JSON.stringify(effective)).toBeGreaterThanOrEqual(24)
  expect(effective.height).toBeGreaterThanOrEqual(24)
  expect(effective.hitHandle).toBe(expectedDirection)
}

async function setEditorZoom(
  page: Page,
  slider: Locator,
  value: Locator,
  zoomPercent: string
): Promise<void> {
  await expect(async () => {
    await slider.evaluate((element, nextValue) => {
      const input = element as HTMLInputElement
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, nextValue)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, zoomPercent)
    await slider.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await expect(slider).toHaveValue(zoomPercent)
    await expect(value).toHaveText(`${zoomPercent}%`)
    await expect
      .poll(async () => (await page.getByTestId('presentation-canvas').boundingBox())?.width)
      .toBeCloseTo((1024 * Number(zoomPercent)) / 100, 0)
  }).toPass()
}

async function dragResizeHandle(
  page: Page,
  handle: Locator,
  direction: ResizeHandle,
  horizontalOnly = false,
  inward = true,
  pointerSource: 'target' | 'indicator' = 'target'
): Promise<void> {
  await expectEffectiveHandleTarget(handle, direction)
  const chrome = page.locator('[data-selection-chrome]').first()
  const before = await chrome.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height)
  }))
  const pointerTarget =
    pointerSource === 'indicator' ? handle.locator('[data-resize-handle-indicator]') : handle
  if (pointerSource === 'indicator') await expect(pointerTarget).toHaveCSS('pointer-events', 'auto')
  const target = await pointerTarget.boundingBox()
  expect(target).not.toBeNull()
  const sign = inward ? 1 : -1
  const orthogonalDelta = 11
  const dx = direction.includes('w')
    ? 24 * sign
    : direction.includes('e')
      ? -24 * sign
      : orthogonalDelta
  const dy = horizontalOnly
    ? orthogonalDelta
    : direction.includes('n')
      ? 24 * sign
      : direction.includes('s')
        ? -24 * sign
        : orthogonalDelta
  const x = target!.x + target!.width / 2
  const y = target!.y + target!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy)
  await page.mouse.up()
  if (direction.includes('w') || direction.includes('e')) {
    await expect
      .poll(() =>
        chrome.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width))
      )
      .not.toBe(before.width)
  } else {
    await expect
      .poll(() =>
        chrome.evaluate((element) => Number.parseFloat((element as HTMLElement).style.height))
      )
      .not.toBe(before.height)
  }
  const after = await chrome.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height)
  }))
  const expectedChanges = horizontalOnly
    ? CONTENT_HEIGHT_GEOMETRY_CHANGES[direction]
    : FIXED_GEOMETRY_CHANGES[direction]
  for (const property of ['x', 'y', 'width', 'height'] as const) {
    // Content height may change when a width adjustment reflows the text.
    if (horizontalOnly && property === 'height') {
      expect(after.height).toBeGreaterThan(0)
      continue
    }
    if (expectedChanges[property]) {
      expect(after[property], `${direction} ${property}`).not.toBe(before[property])
    } else {
      expect(after[property], `${direction} ${property}`).toBe(before[property])
    }
  }
  if (direction.includes('w')) {
    if (inward) expect(after.x, direction).toBeGreaterThan(before.x)
    else expect(after.x, direction).toBeLessThan(before.x)
  }
  if (direction.includes('e')) {
    if (inward) {
      expect(after.x + after.width, direction).toBeLessThan(before.x + before.width)
    } else {
      expect(after.x + after.width, direction).toBeGreaterThan(before.x + before.width)
    }
  }
  if (!horizontalOnly && direction.includes('n')) {
    if (inward) expect(after.y, direction).toBeGreaterThan(before.y)
    else expect(after.y, direction).toBeLessThan(before.y)
  }
  if (!horizontalOnly && direction.includes('s')) {
    if (inward) {
      expect(after.y + after.height, direction).toBeLessThan(before.y + before.height)
    } else {
      expect(after.y + after.height, direction).toBeGreaterThan(before.y + before.height)
    }
  }
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() =>
      chrome.evaluate((element) => {
        const style = (element as HTMLElement).style
        return [style.left, style.top, style.width, style.height]
      })
    )
    .toEqual([`${before.x}px`, `${before.y}px`, `${before.width}px`, `${before.height}px`])
}

async function dragWithTouch(
  page: Page,
  handle: Locator,
  dx: number,
  dy: number,
  finish: 'end' | 'cancel' = 'end'
): Promise<string[]> {
  const direction = await handle.getAttribute('data-resize-handle')
  expect(direction).not.toBeNull()
  await expectEffectiveHandleTarget(handle, direction as ResizeHandle)
  const target = await handle.boundingBox()
  expect(target).not.toBeNull()
  await page.evaluate(() => {
    const trackedWindow = window as Window & { __presentationTouchEvents?: string[] }
    trackedWindow.__presentationTouchEvents = []
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      document.addEventListener(type, () => trackedWindow.__presentationTouchEvents?.push(type), {
        capture: true,
        once: true
      })
    }
  })
  const x = target!.x + target!.width / 2
  const y = target!.y + target!.height / 2
  const session = await page.context().newCDPSession(page)
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1 }]
  })
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x + dx, y: y + dy, id: 1 }]
  })
  await session.send('Input.dispatchTouchEvent', {
    type: finish === 'end' ? 'touchEnd' : 'touchCancel',
    touchPoints: []
  })
  await session.detach()
  return page.evaluate(
    () =>
      (window as Window & { __presentationTouchEvents?: string[] }).__presentationTouchEvents ?? []
  )
}

async function expectTextInteriorAndFrameMove(page: Page, element: Locator): Promise<void> {
  const content = await element.boundingBox()
  expect(content).not.toBeNull()
  const contentPoint = {
    x: content!.x + content!.width / 2,
    y: content!.y + content!.height / 2
  }
  expect(
    await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return {
        element: Boolean(hit?.closest('[data-slide-element]')),
        handle: Boolean(hit?.closest('[data-resize-handle]')),
        edge: Boolean(hit?.closest('[data-text-frame-edge]'))
      }
    }, contentPoint)
  ).toEqual({ element: true, handle: false, edge: false })

  await page.mouse.dblclick(contentPoint.x, contentPoint.y)
  await expect(element.locator('[data-text-content]')).toHaveAttribute('contenteditable', 'true')
  await expect(element.locator('[data-text-content]')).toBeFocused()
  await page.keyboard.press('Escape')
  await selectSlideElement(element)

  const edge = page.getByTestId('text-frame-edge-top')
  await expect(edge).toHaveCSS('touch-action', 'none')
  const edgeBox = await edge.boundingBox()
  expect(edgeBox).not.toBeNull()
  const edgePoint = {
    x: edgeBox!.x + edgeBox!.width / 2,
    y: edgeBox!.y + edgeBox!.height / 2
  }
  expect(
    await page.evaluate(({ x, y }) => {
      return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-text-frame-edge]')
        ?.dataset.textFrameEdge
    }, edgePoint)
  ).toBe('top')

  const chrome = page.locator('[data-selection-chrome]')
  const readPosition = (): Promise<number[]> =>
    chrome.evaluate((selection) => {
      const style = (selection as HTMLElement).style
      return [Number.parseFloat(style.left), Number.parseFloat(style.top)]
    })
  const before = await readPosition()
  await page.mouse.move(edgePoint.x, edgePoint.y)
  await page.mouse.down()
  await page.mouse.move(edgePoint.x + 24, edgePoint.y + 24)
  await page.mouse.up()
  await expect.poll(readPosition).not.toEqual(before)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(readPosition).toEqual(before)
}

async function installResizeFixture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const open = indexedDB.open('hhc-file-explorer')
    const db = await requestResult(open)
    const read = db.transaction(['folder-items', 'file-blobs'], 'readonly')
    const items = (await requestResult(read.objectStore('folder-items').getAll())) as Array<{
      id: string
      mimeType?: string
    }>
    const item = items.find(
      (candidate) => candidate.mimeType === 'application/vnd.hhc.presenter+json'
    )
    if (!item) throw new Error('editable presentation fixture item not found')
    const record = (await requestResult(read.objectStore('file-blobs').get(item.id))) as {
      id: string
      blob: Blob
      revision?: number
      [key: string]: unknown
    }
    const document = JSON.parse(await record.blob.text()) as {
      width: number
      height: number
      slideOrder: string[]
      slides: Record<
        string,
        {
          elementOrder: string[]
          elements: Record<string, unknown>
        }
      >
      assets: Record<string, unknown>
      updatedAt: number
    }
    const slide = document.slides[document.slideOrder[0]]
    const textBase = {
      type: 'text',
      rotation: 0,
      opacity: 1,
      fontFamily: 'Arial',
      fontSize: 24,
      bold: false,
      italic: false,
      underline: false,
      color: '#000000',
      align: 'left',
      lineHeight: 1.15
    }
    slide.elementOrder = ['content-text', 'fixed-text', 'corner-image', 'corner-shape']
    slide.elements = {
      'content-text': {
        ...textBase,
        id: 'content-text',
        autoWidth: false,
        autoSize: 'content',
        x: 0,
        y: 0,
        width: 60,
        height: 32,
        text: 'Corner'
      },
      'fixed-text': {
        ...textBase,
        id: 'fixed-text',
        autoWidth: false,
        autoSize: 'fixed',
        x: document.width - 60,
        y: document.height - 24,
        width: 60,
        height: 24,
        text: 'Fixed'
      },
      'corner-image': {
        id: 'corner-image',
        type: 'image',
        assetId: 'corner-asset',
        x: 0,
        y: document.height - 20,
        width: 20,
        height: 20,
        rotation: 0,
        opacity: 1
      },
      'corner-shape': {
        id: 'corner-shape',
        type: 'shape',
        shape: 'rectangle',
        x: document.width - 20,
        y: 0,
        width: 20,
        height: 20,
        rotation: 0,
        opacity: 1,
        fillColor: '#2563eb',
        strokeColor: '#000000',
        strokeWidth: 0
      }
    }
    document.assets = {
      'corner-asset': {
        id: 'corner-asset',
        name: 'Corner image',
        mimeType: 'image/png',
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      }
    }
    document.updatedAt = Date.now()
    const blob = new Blob([JSON.stringify(document)], {
      type: 'application/vnd.hhc.presenter+json'
    })
    const write = db.transaction('file-blobs', 'readwrite')
    write.objectStore('file-blobs').put({
      ...record,
      blob,
      size: blob.size,
      revision: (record.revision ?? 0) + 1
    })
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve()
      write.onerror = () => reject(write.error)
      write.onabort = () => reject(write.error)
    })
    db.close()
  })
  await page.reload()
}

test('keeps the editable presentation stage primary at the 900px breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/')
  await completeOnboarding(page)
  await page.evaluate(() => localStorage.setItem('hhc-language', 'zh-TW'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW')

  await page.goto('/#/files')
  await expect(page).toHaveURL(/#\/files$/)
  const projectionAction = page.getByRole('button', {
    name: /Start projection|開始投影|开始投影/
  })
  await expectProjectionActionGeometry(projectionAction)
  await page.getByLabel(/New|新增/).click()
  await page.getByRole('menuitem', { name: /Create Presentation|建立簡報|创建演示文稿/ }).click()
  await expect(page).toHaveURL(/#\/presentations\//)

  const fit = page.getByRole('button', { name: '符合視窗' })
  await expect(page.getByRole('button', { name: 'Fit', exact: true })).toHaveCount(0)
  const zoomSlider = page.getByRole('slider', { name: /Zoom|縮放/ })
  await expect(fit).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: /^(Text|文字)$/ }).click()
  await page
    .locator('.presentation-stage [data-slide-surface]')
    .click({ position: { x: 160, y: 120 } })
  const textBox = page.locator('[data-text-content][contenteditable="true"]')
  await textBox.pressSequentially('Supercalifragilisticexpialidocious')
  await textBox.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const textMetrics = await textBox.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      scrollHeight: element.scrollHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
      verticalPadding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    }
  })
  expect(textMetrics.scrollHeight).toBeLessThanOrEqual(
    textMetrics.lineHeight + textMetrics.verticalPadding + 3
  )
  const shapes = page.getByRole('button', { name: /^(Shapes|圖案|形状)$/ })
  const shapesBox = await shapes.boundingBox()
  expect(shapesBox).not.toBeNull()
  await shapes.focus()
  await shapes.press('Enter')
  const shapeMenu = page.getByRole('menu')
  await expect(shapeMenu).toBeVisible()
  const shapeMenuBox = await shapeMenu.boundingBox()
  expect(shapeMenuBox).not.toBeNull()
  expect(shapeMenuBox!.x).toBeCloseTo(shapesBox!.x, 0)
  expect(shapeMenuBox!.y).toBeCloseTo(shapesBox!.y + shapesBox!.height, 0)
  await expect(page.getByRole('menuitem').first()).toBeFocused()
  await shapeMenu.press('Escape')
  await expect(shapes).toBeFocused()

  const ribbonPanel = page.locator('#presentation-ribbon-panel')
  await expect(ribbonPanel).toHaveCSS('height', '96px')
  await expect(page.getByRole('tablist')).toHaveCount(0)

  await page.setViewportSize({ width: 1470, height: 726 })
  const stageSlot = page.locator('.workspace-stage-slot')
  const presentationStage = page.locator('.presentation-stage')
  const notes = page.getByRole('button', { name: /Toggle Notes|顯示或隱藏備忘稿/ })
  const zoom = page.getByRole('button', { name: /Reset zoom|重設縮放/ })
  const ribbon = page.locator('[data-ribbon-surface]')
  const viewport = page.getByTestId('presentation-canvas-viewport')
  const canvas = page.getByTestId('presentation-canvas')
  await expect(notes).toBeVisible()
  await expect(notes).toHaveAttribute('aria-controls', 'presentation-notes-region')
  await expect(notes).toHaveAttribute('aria-expanded', 'false')
  await expect(zoom).toBeVisible()
  expect(await ribbon.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  const resizeHandle = page
    .locator('.presentation-stage')
    .getByRole('button', { name: /Resize text box right|調整文字方塊大小（右）/ })
  for (const zoomPercent of ['25', '100', '200']) {
    await zoomSlider.fill(zoomPercent)
    const handleBox = await resizeHandle.boundingBox()
    expect(handleBox).not.toBeNull()
    expect(handleBox!.width).toBeGreaterThanOrEqual(24)
    expect(handleBox!.height).toBeGreaterThanOrEqual(24)
  }
  await fit.click()

  const expectedFitZoom = async (): Promise<number> =>
    viewport.evaluate((element) =>
      Math.max(
        25,
        Math.min(
          200,
          Math.floor(
            Math.min((element.clientWidth - 64) / 1024, (element.clientHeight - 64) / 576) * 100
          )
        )
      )
    )
  const expectExactFitGeometry = async (): Promise<number> => {
    const expected = await expectedFitZoom()
    await expect(zoomSlider).toHaveValue(String(expected))
    await expect(zoom).toHaveText(`${expected}%`)
    await expect
      .poll(async () => (await canvas.boundingBox())?.width)
      .toBeCloseTo((1024 * expected) / 100, 0)
    return expected
  }

  const fitZoom = await expectExactFitGeometry()
  await notes.click()
  const notesEditor = page.getByRole('textbox', { name: /Notes|備忘稿/ })
  await expect(notes).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#presentation-notes-region')).toBeVisible()
  await notesEditor.fill('Responsive speaker note')
  await expect.poll(async () => Number(await zoomSlider.inputValue())).toBeLessThan(fitZoom)
  await expectExactFitGeometry()
  await notes.click()
  await expect(notes).toHaveAttribute('aria-expanded', 'false')
  await notes.click()
  await expect(notesEditor).toHaveValue('Responsive speaker note')
  await notes.click()

  await zoomSlider.fill('150')
  await expect(zoomSlider).toHaveValue('150')
  await viewport.evaluate((element) => {
    element.scrollLeft = 220
    element.scrollTop = 140
  })
  const viewportBox = await viewport.boundingBox()
  const canvasBeforeWheel = await canvas.boundingBox()
  const pointer = {
    x: viewportBox!.x + viewportBox!.width * 0.31,
    y: viewportBox!.y + viewportBox!.height * 0.37
  }
  const logicalBeforeWheel = {
    x: ((pointer.x - canvasBeforeWheel!.x) * 1024) / canvasBeforeWheel!.width,
    y: ((pointer.y - canvasBeforeWheel!.y) * 576) / canvasBeforeWheel!.height
  }
  const zoomBeforeWheel = await zoom.textContent()
  const ctrlWheelPrevented = await viewport.evaluate((element, position) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: position.x,
      clientY: position.y,
      ctrlKey: true,
      deltaY: -100
    })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }, pointer)
  expect(ctrlWheelPrevented).toBe(true)
  await expect.poll(() => zoom.textContent()).not.toBe(zoomBeforeWheel)
  const canvasAfterWheel = await canvas.boundingBox()
  expect(((pointer.x - canvasAfterWheel!.x) * 1024) / canvasAfterWheel!.width).toBeCloseTo(
    logicalBeforeWheel.x,
    0
  )
  expect(((pointer.y - canvasAfterWheel!.y) * 576) / canvasAfterWheel!.height).toBeCloseTo(
    logicalBeforeWheel.y,
    0
  )

  await zoomSlider.fill('200')
  await expect(zoomSlider).toHaveValue('200')
  const overflow = await viewport.evaluate((element) => {
    element.scrollLeft = 0
    element.scrollTop = 0
    return {
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight
    }
  })
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth)
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight)
  const [viewportAtStart, canvasAtStart] = await Promise.all([
    viewport.boundingBox(),
    canvas.boundingBox()
  ])
  expect(canvasAtStart!.x - viewportAtStart!.x).toBeCloseTo(32, 0)
  expect(canvasAtStart!.y - viewportAtStart!.y).toBeCloseTo(32, 0)
  await viewport.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth
    element.scrollTop = element.scrollHeight - element.clientHeight
  })
  const [viewportAtEnd, canvasAtEnd] = await Promise.all([
    viewport.boundingBox(),
    canvas.boundingBox()
  ])
  expect(viewportAtEnd!.x + viewportAtEnd!.width - canvasAtEnd!.x - canvasAtEnd!.width).toBeCloseTo(
    32,
    0
  )
  expect(
    viewportAtEnd!.y + viewportAtEnd!.height - canvasAtEnd!.y - canvasAtEnd!.height
  ).toBeCloseTo(32, 0)
  const statusBar = page.getByTestId('presentation-status-bar')
  const [statusBox, customStageBox] = await Promise.all([
    statusBar.boundingBox(),
    presentationStage.boundingBox()
  ])
  expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(
    customStageBox!.y + customStageBox!.height
  )

  const [slotBox, stageBox] = await Promise.all([
    stageSlot.boundingBox(),
    presentationStage.boundingBox()
  ])
  expect(stageBox!.height).toBeLessThanOrEqual(slotBox!.height)
  expect(stageBox!.y + stageBox!.height).toBeLessThanOrEqual(726)
  await page.setViewportSize({ width: 1200, height: 800 })

  const navigator = page.locator('.workspace-navigator-slot')
  const stage = page.locator('.workspace-stage-slot')
  const slidesTrigger = page.getByRole('button', { name: /^(Slides|投影片|幻灯片)$/ })

  const presentationProjectionAction = page.getByRole('button', {
    name: /Start projection|開始投影|开始投影/
  })
  await expectProjectionActionGeometry(presentationProjectionAction)
  expect(await ribbon.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )

  await page.setViewportSize({ width: 900, height: 800 })
  expect(await ribbon.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await expect(navigator).toBeHidden()
  await expect(slidesTrigger).toBeVisible()
  await expect(stage).toBeVisible()
  await expect(presentationStage).toBeVisible()
  await expect(statusBar).toBeVisible()
  const viewportBoxes = await Promise.all([
    stage.boundingBox(),
    presentationStage.boundingBox(),
    statusBar.boundingBox()
  ])
  for (const box of viewportBoxes) {
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.height).toBeGreaterThan(0)
    expect(box!.x).toBeLessThan(900)
    expect(box!.y).toBeLessThan(800)
    expect(box!.x + box!.width).toBeGreaterThan(0)
    expect(box!.y + box!.height).toBeGreaterThan(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(900)
    expect(box!.y + box!.height).toBeLessThanOrEqual(800)
  }
  await expect(ribbon).toHaveCSS('overflow-x', 'auto')
  const ribbonMetrics = await ribbon.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }))
  expect(ribbonMetrics.scrollWidth).toBeGreaterThan(ribbonMetrics.clientWidth)

  await viewport.evaluate((element) => {
    element.scrollLeft = 0
    element.scrollTop = 0
  })
  await expect
    .poll(() => viewport.evaluate((element) => [element.scrollLeft, element.scrollTop]))
    .toEqual([0, 0])
  await page
    .locator('.presentation-stage [data-slide-surface]')
    .click({ button: 'right', position: { x: 20, y: 20 } })
  await page
    .getByRole('menuitem', { name: /Format Background|設定背景格式/ })
    .click({ force: true })
  const inspectorOverlay = page.getByRole('dialog', {
    name: /Format Background|設定背景格式/
  })
  const navigatorSlot = page.locator('.workspace-navigator-slot')
  await expect(inspectorOverlay).toBeVisible()
  await expect(navigator).toBeHidden()
  await expect(stage).toHaveAttribute('inert', '')
  await expect(stage).toHaveAttribute('aria-hidden', 'true')
  await expect(navigatorSlot).toHaveAttribute('inert', '')
  await expect(navigatorSlot).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByRole('button', { name: /^(Fit|符合視窗)$/ })).toHaveCount(0)
  const outsideInteractive = await inspectorOverlay.evaluate((dialog) => {
    const isVisible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    )
      .filter((element) => !dialog.contains(element) && isVisible(element))
      .map((element) => Boolean(element.closest('[inert], [aria-hidden="true"]')))
  })
  expect(outsideInteractive.length).toBeGreaterThan(0)
  expect(outsideInteractive.every(Boolean)).toBe(true)
  const inspectorFocusables = inspectorOverlay.locator(
    'button:visible, input:visible, select:visible, textarea:visible, [tabindex]:not([tabindex="-1"]):visible'
  )
  await expect(inspectorFocusables.last()).toBeFocused()
  await inspectorFocusables.last().press('Tab')
  await expect(inspectorFocusables.first()).toBeFocused()
  await inspectorFocusables.first().press('Shift+Tab')
  await expect(inspectorFocusables.last()).toBeFocused()

  await page.setViewportSize({ width: 1400, height: 800 })
  const inspectorSlot = page.locator('.workspace-inspector-slot')
  await expect(inspectorOverlay).toHaveCount(0)
  await expect(inspectorSlot).toBeVisible()
  await expect(inspectorSlot).not.toHaveAttribute('role', 'dialog')
  await expect(stage).not.toHaveAttribute('inert')
  await expect(stage).not.toHaveAttribute('aria-hidden')
  expect(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[hidden], [inert], [aria-hidden="true"]'))
    )
  ).toBe(false)

  await page.setViewportSize({ width: 900, height: 800 })
  await expect(inspectorOverlay).toBeVisible()
  await expect(stage).toHaveAttribute('inert', '')
  await expect(stage).toHaveAttribute('aria-hidden', 'true')
  await expect(inspectorFocusables.last()).toBeFocused()

  await inspectorOverlay.getByRole('button', { name: /^(Slides|投影片|幻灯片)$/ }).click()
  const slidesOverlay = page.getByRole('dialog', { name: /^(Slides|投影片|幻灯片)$/ })
  await expect(slidesOverlay).toBeVisible()
  await expect(page.locator('.workspace-inspector-slot')).toHaveCount(0)
  await expect(
    slidesOverlay.getByRole('button', { name: /Close (Slides|投影片|幻灯片)/ })
  ).toBeFocused()
  await slidesOverlay.press('Escape')
  await expect(navigator).toBeHidden()
  await expect(slidesTrigger).toBeFocused()
  await expect(stage).toBeVisible()
  await expect(stage).not.toHaveAttribute('inert')
  await expect(stage).not.toHaveAttribute('aria-hidden')
  await expect(page.getByRole('button', { name: /^(Fit|符合視窗)$/ })).toBeVisible()

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})

test('keeps corner resize chrome fully operable at every editor zoom', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await page.getByLabel(/New|新增/).click()
  await page.getByRole('menuitem', { name: /Create Presentation|建立簡報|创建演示文稿/ }).click()
  await expect(page).toHaveURL(/#\/presentations\//)
  await installResizeFixture(page)

  const zoomSlider = page.getByRole('slider', { name: /Zoom|縮放/ })
  const zoomValue = page.getByRole('button', { name: /Reset zoom|重設縮放/ })
  const saved = page.getByText(/^(Saved|已儲存|已保存)$/)
  const elements = page.locator('.presentation-stage [data-slide-content] [data-slide-element]')
  const contentTextHandles: ResizeHandle[] = ['nw', 'w', 'sw', 'ne', 'e', 'se']
  await expect(elements).toHaveCount(4)
  await expect(saved).toBeVisible()
  await expect(elements.nth(0)).toHaveCSS('left', '0px')
  await expect(elements.nth(0)).toHaveCSS('width', '60px')
  await expect(elements.nth(1)).toHaveCSS('width', '60px')
  await expect(elements.nth(1)).toHaveCSS('height', '24px')
  await expect(elements.nth(2)).toHaveCSS('width', '20px')
  await expect(elements.nth(2)).toHaveCSS('height', '20px')
  await expect(elements.nth(3)).toHaveCSS('width', '20px')
  await expect(elements.nth(3)).toHaveCSS('height', '20px')
  await expect(page.locator('.presentation-stage [data-slide-content]')).toHaveCSS(
    'overflow',
    'hidden'
  )

  for (const zoomPercent of ['25', '100', '200']) {
    await selectSlideElement(elements.nth(0))
    await expect(saved).toBeVisible()
    await setEditorZoom(page, zoomSlider, zoomValue, zoomPercent)
    for (const direction of contentTextHandles) {
      await dragResizeHandle(
        page,
        page.getByRole('button', {
          name: `Resize text box ${HANDLE_LABELS[direction]}`,
          exact: true
        }),
        direction,
        true,
        false
      )
    }
    if (zoomPercent === '25') {
      for (const direction of contentTextHandles) {
        await dragResizeHandle(
          page,
          page.getByRole('button', {
            name: `Resize text box ${HANDLE_LABELS[direction]}`,
            exact: true
          }),
          direction,
          true,
          false,
          'indicator'
        )
      }
    }
    await expectTextInteriorAndFrameMove(page, elements.nth(0))

    await selectSlideElement(elements.nth(1))
    await expect(saved).toBeVisible()
    await setEditorZoom(page, zoomSlider, zoomValue, zoomPercent)
    for (const direction of HANDLE_DIRECTIONS) {
      await dragResizeHandle(
        page,
        page.getByRole('button', {
          name: `Resize text box ${HANDLE_LABELS[direction]}`,
          exact: true
        }),
        direction,
        false,
        false
      )
    }
    if (zoomPercent === '25') {
      for (const direction of HANDLE_DIRECTIONS) {
        await dragResizeHandle(
          page,
          page.getByRole('button', {
            name: `Resize text box ${HANDLE_LABELS[direction]}`,
            exact: true
          }),
          direction,
          false,
          false,
          'indicator'
        )
      }
    }

    await selectSlideElement(elements.nth(2))
    await expect(saved).toBeVisible()
    await setEditorZoom(page, zoomSlider, zoomValue, zoomPercent)
    for (const direction of HANDLE_DIRECTIONS) {
      await dragResizeHandle(
        page,
        page.getByRole('button', {
          name: `Resize image ${HANDLE_LABELS[direction]}`,
          exact: true
        }),
        direction,
        false,
        false
      )
    }

    await selectSlideElement(elements.nth(3))
    await expect(saved).toBeVisible()
    await setEditorZoom(page, zoomSlider, zoomValue, zoomPercent)
    const genericHandle = page.getByRole('button', { name: 'Resize element', exact: true })
    await dragResizeHandle(page, genericHandle, 'se', false, false)
    expect(
      await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>(
          '.presentation-stage [data-slide-surface]'
        )
        const shape = document.querySelectorAll<HTMLElement>(
          '.presentation-stage [data-slide-content] [data-slide-element]'
        )[3]
        if (!surface || !shape) return false
        const slideRect = surface.getBoundingClientRect()
        const shapeRect = shape.getBoundingClientRect()
        const hit = document.elementFromPoint(
          slideRect.right + 2,
          shapeRect.top + shapeRect.height / 2
        )
        return !hit?.closest('[data-slide-element]')
      })
    ).toBe(true)
  }
})

test.describe('touch presentation editing', () => {
  test.use({ hasTouch: true })

  test('commits touch resize gestures while explicit cancellation restores geometry', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.goto('/')
    await completeOnboarding(page)
    await page.goto('/#/files')
    await page.getByLabel(/New|新增/).click()
    await page.getByRole('menuitem', { name: /Create Presentation|建立簡報|创建演示文稿/ }).click()
    await expect(page).toHaveURL(/#\/presentations\//)
    await installResizeFixture(page)

    const elements = page.locator('.presentation-stage [data-slide-content] [data-slide-element]')
    await expect(page.getByTestId('presentation-canvas-viewport')).toHaveCSS('touch-action', 'auto')
    await selectSlideElement(elements.nth(1))
    const textHandle = page.getByRole('button', {
      name: 'Resize text box right',
      exact: true
    })
    await expect(textHandle).toHaveCSS('touch-action', 'none')
    const textChrome = page.locator('[data-selection-chrome]')
    const readTextWidth = (): Promise<number> =>
      textChrome.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width))
    const initialWidth = await readTextWidth()
    const commitEvents = await dragWithTouch(page, textHandle, 24, 0)
    await expect.poll(readTextWidth).toBeGreaterThan(initialWidth)
    expect(commitEvents).toContain('pointerdown')
    expect(commitEvents).toContain('pointermove')
    expect(commitEvents).toContain('pointerup')
    expect(commitEvents).not.toContain('pointercancel')

    const committedWidth = await readTextWidth()
    const cancelEvents = await dragWithTouch(page, textHandle, 24, 0, 'cancel')
    await expect.poll(readTextWidth).toBe(committedWidth)
    expect(cancelEvents).toContain('pointercancel')
    expect(cancelEvents).not.toContain('pointerup')
  })
})

test('keeps the media sidebar on the right without horizontal overflow at each breakpoint', async ({
  page,
  context
}) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name: 'Responsive.png', mimeType: 'image/png', buffer: png })
  const projectionPromise = context.waitForEvent('page')
  await page.getByText('Responsive.png').dblclick()
  const projection = await projectionPromise
  await expect(page).toHaveURL(/#\/media$/)

  const mediaBack = page.getByTestId('media-back-to-files')
  const notes = page.getByRole('textbox')
  const expectRightSidebar = async (): Promise<void> => {
    await expect(notes).toBeVisible()
    const mediaBackBox = await mediaBack.boundingBox()
    const notesBox = await notes.boundingBox()
    expect(mediaBackBox).not.toBeNull()
    expect(notesBox).not.toBeNull()
    expect(notesBox!.x).toBeGreaterThan(mediaBackBox!.x)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
  }

  await expectRightSidebar()

  await page.setViewportSize({ width: 1024, height: 800 })
  await expectRightSidebar()

  await page.setViewportSize({ width: 700, height: 800 })
  await expectRightSidebar()

  await projection.close()
})
