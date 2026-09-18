import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { completeOnboarding } from './helpers'

const TINY_MP4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMPbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAPoAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjl0cmFrAAAAXHRra2QAAAADAAAAAAAAAAAAAAABAAAAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAD6AAAAAAABAAAAAAGxbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAEABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMAIDxYuSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAFBgAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAAAQAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAKDAAAAAQAAABRzdGNvAAAAAAAAAAEAAAM/AAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAAAIZnJlZQAAAottZGF0AAACcAYF//9s3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49NCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40NCBhcT0xOjEuMDAAgAAAAAtliIQEPJigADQbgA==',
  'base64'
)

declare global {
  interface Window {
    __projectionFocusCalls: number
    __allowProjectionPopup: boolean
  }
}

test('starts one projection popup and keeps passive timer ticks non-activating', async ({
  page,
  context
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__projectionFocusCalls', {
      value: 0,
      writable: true
    })
    window.focus = () => {
      window.__projectionFocusCalls += 1
    }
  })

  await page.goto('/')
  await completeOnboarding(page)

  const projectionPromise = context.waitForEvent('page')
  await page.getByTestId('btn-start').click()
  const projection = await projectionPromise

  await projection.waitForLoadState('domcontentloaded')
  await expect(projection).toHaveURL(/#\/projection\?generation=[1-9]\d*&session=[0-9a-f-]+$/i)
  await expect(projection.locator('.timer-digits').first()).toBeVisible()
  const focusCallsAfterOpen = await page.evaluate(() => window.__projectionFocusCalls)
  expect(focusCallsAfterOpen).toBe(1)

  const beforeReload = await projection.locator('.timer-digits').first().textContent()
  await projection.reload()
  await expect(projection.locator('.timer-digits').first()).toBeVisible()
  await expect
    .poll(async () => projection.locator('.timer-digits').first().textContent())
    .not.toBeNull()

  await projection.waitForTimeout(1200)

  expect(context.pages()).toHaveLength(2)
  expect(await page.evaluate(() => window.__projectionFocusCalls)).toBe(focusCallsAfterOpen)
  expect(beforeReload).not.toBeNull()

  await page.close({ runBeforeUnload: true })
  await expect.poll(() => projection.isClosed()).toBe(true)
})

test('recovers after the browser blocks the projection popup', async ({ page, context }) => {
  await page.addInitScript(() => {
    const nativeOpen = window.open.bind(window)
    Object.defineProperty(window, '__allowProjectionPopup', {
      value: false,
      writable: true
    })
    window.open = (...args) => (window.__allowProjectionPopup ? nativeOpen(...args) : null)
  })

  await page.goto('/')
  await completeOnboarding(page)
  await page.getByTestId('btn-start').click()

  await expect(
    page.getByText(/Projection popup was blocked|投影彈出視窗遭到封鎖|投影弹出窗口被拦截/)
  ).toBeVisible()

  await page.evaluate(() => {
    window.__allowProjectionPopup = true
  })
  const projectionPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: /Retry projection|重試投影|重试投影/ }).click()
  const projection = await projectionPromise

  await expect(projection.locator('.timer-digits').first()).toBeVisible()
  expect(context.pages()).toHaveLength(2)
})

test('restores the HHC account session without storing the access token', async ({
  page,
  context
}) => {
  const clientOrigin = 'https://client.alive.org.tw'
  const accountOrigin = 'https://account.alive.org.tw'
  const callbackUri = `${clientOrigin}/oauth/callback`
  const accessToken = [
    'header',
    Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        roles: ['media_sync_user'],
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    ).toString('base64url'),
    'signature'
  ].join('.')
  let authenticated = false
  let sessionRequests = 0
  let callbackRequests = 0
  const assetOrigin = 'https://www.alive.org.tw'
  const collection = {
    id: 'collection-1',
    namespace: 'line.group.media-sync',
    name: 'Sunday media',
    revision: 2,
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T00:01:00Z'
  }
  const media = [
    ['image-1', 'Still.png', 'image/png'],
    ['audio-1', 'Sermon.mp3', 'audio/mpeg'],
    ['video-1', 'Welcome.mp4', 'video/mp4'],
    ['pdf-1', 'Bulletin.pdf', 'application/pdf'],
    [
      'pptx-1',
      'Announcements.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ]
  ].map(([id, displayName, mimeType], index) => ({
    id,
    collectionId: collection.id,
    remoteItemId: `line-source-${index + 1}`,
    displayName,
    sourceRevision: `sha256-${index + 1}`,
    createdRevision: 1,
    mimeType,
    sizeBytes: 128,
    etag: `"etag-${index + 1}"`,
    createdAt: '2026-08-17T00:00:00Z'
  }))
  const ticketRequests: string[] = []
  const contentRequests: Array<{
    range: string | undefined
    referer: string | undefined
    status: number
    fromProjection: boolean
  }> = []

  await context.route(`${clientOrigin}/**`, async (route) => {
    const url = new URL(route.request().url())
    const response = await page.request.fetch(`http://127.0.0.1:5173${url.pathname}${url.search}`)
    if (url.pathname === '/oauth/callback') {
      callbackRequests += 1
      await route.fulfill({
        status: response.status(),
        contentType: 'text/html',
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
        body: (await response.text()).replace('<head>', '<head><base href="/">')
      })
      return
    }
    await route.fulfill({ response })
  })
  await context.route(`${accountOrigin}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const corsHeaders = {
      'access-control-allow-origin': clientOrigin,
      'access-control-allow-credentials': 'true'
    }

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders })
      return
    }
    if (url.pathname === '/api/account/v1/oauth/authorize') {
      expect(url.searchParams.get('redirect_uri')).toBe(callbackUri)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      const state = url.searchParams.get('state')
      expect(state).toBeTruthy()
      await route.fulfill({
        contentType: 'text/html',
        body: `<script>location.replace(${JSON.stringify(`${callbackUri}?code=code-1&state=${state}`)})</script>`
      })
      return
    }
    if (url.pathname === '/api/account/v1/oauth/token') {
      const body = new URLSearchParams(request.postData() ?? '')
      expect(body.get('redirect_uri')).toBe(callbackUri)
      authenticated = true
      await route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          'content-type': 'application/json',
          'set-cookie':
            'hhc_session=session-1; HttpOnly; Secure; SameSite=Lax; Path=/api/account/v1'
        },
        body: JSON.stringify({ access_token: accessToken })
      })
      return
    }
    if (url.pathname === '/api/account/v1/session') {
      sessionRequests += 1
      const hasSessionCookie = request.headers().cookie?.includes('hhc_session=session-1') ?? false
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(
          authenticated && hasSessionCookie
            ? {
                authenticated: true,
                user: {
                  id: 'user-1',
                  email: 'ada@example.com',
                  display_name: 'Ada Lovelace',
                  avatar_url: null
                },
                permissions: [],
                permission_availability: { status: 'available' }
              }
            : { authenticated: false }
        )
      })
      return
    }
    if (url.pathname === '/api/account/v1/csrf-token') {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ csrf_token: 'csrf-token-1' })
      })
      return
    }
    if (url.pathname === '/api/account/v1/session/access-token') {
      expect(request.headers()['x-csrf-token']).toBe('csrf-token-1')
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken, expires_in: 3600 })
      })
      return
    }

    await route.fulfill({ status: 404, headers: corsHeaders })
  })
  await context.route(`${assetOrigin}/api/assets/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const corsHeaders = {
      'access-control-allow-origin': clientOrigin,
      'access-control-allow-headers': 'authorization,content-type,range',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-expose-headers': 'content-range,etag',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    }

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders })
      return
    }
    if (url.pathname === '/api/assets/collections') {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ collections: [collection], hasMore: false })
      })
      return
    }
    if (url.pathname === `/api/assets/collections/${collection.id}/changes`) {
      const isHandoff = url.searchParams.get('cursor') === 'reset-cursor'
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(
          isHandoff
            ? {
                collection,
                items: [],
                tombstones: [],
                cursor: 'live-cursor',
                hasMore: false,
                reset: false
              }
            : {
                collection,
                items: media,
                tombstones: [],
                cursor: 'reset-cursor',
                hasMore: true,
                reset: true
              }
        )
      })
      return
    }
    const itemPath = new RegExp(
      `^/api/assets/collections/${collection.id}/items/([^/]+)(/content-ticket)?$`
    ).exec(url.pathname)
    if (itemPath?.[2] === '/content-ticket' && request.method() === 'POST') {
      const itemId = itemPath[1]!
      const contentUrl = `/api/assets/content?ticket=ticket-${itemId}`
      ticketRequests.push(`${assetOrigin}${contentUrl}`)
      await route.fulfill({
        status: 201,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          contentUrl,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          etag: media.find((item) => item.id === itemId)?.etag ?? '"etag"'
        })
      })
      return
    }
    if (itemPath && request.method() === 'GET') {
      const item = media.find((candidate) => candidate.id === itemPath[1])
      await route.fulfill({
        status: item ? 200 : 404,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(item ?? {})
      })
      return
    }
    if (url.pathname === '/api/assets/content') {
      const range = request.headers().range
      const match = range?.match(/^bytes=(\d*)-(\d*)$/)
      let start = 0
      let end = TINY_MP4.length - 1
      if (range) {
        if (!match || (!match[1] && !match[2])) {
          await route.fulfill({
            status: 416,
            headers: {
              ...corsHeaders,
              'content-range': `bytes */${TINY_MP4.length}`
            }
          })
          return
        }
        if (match[1]) {
          start = Number(match[1])
          end = match[2] ? Math.min(Number(match[2]), end) : end
        } else {
          const suffixLength = Number(match[2])
          start = Math.max(0, TINY_MP4.length - suffixLength)
        }
        if (start > end || start >= TINY_MP4.length) {
          await route.fulfill({
            status: 416,
            headers: {
              ...corsHeaders,
              'content-range': `bytes */${TINY_MP4.length}`
            }
          })
          return
        }
      }
      contentRequests.push({
        range,
        referer: request.headers().referer,
        status: range ? 206 : 200,
        fromProjection: request.frame().url().includes('#/projection')
      })
      await route.fulfill({
        status: range ? 206 : 200,
        headers: {
          ...corsHeaders,
          'content-type': 'video/mp4',
          etag: '"etag-video"',
          'accept-ranges': 'bytes',
          'content-length': String(end - start + 1),
          ...(range ? { 'content-range': `bytes ${start}-${end}/${TINY_MP4.length}` } : {})
        },
        body: TINY_MP4.subarray(start, end + 1)
      })
      return
    }

    await route.fulfill({ status: 404, headers: corsHeaders })
  })

  await page.goto(`${clientOrigin}/`)
  await completeOnboarding(page)

  await page.getByRole('button', { name: 'Account menu for Guest' }).click()
  await page.getByRole('menuitem', { name: 'Login' }).click()
  await expect(page.getByRole('button', { name: 'Account menu for Ada Lovelace' })).toBeVisible()
  expect(callbackRequests).toBe(1)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Account menu for Ada Lovelace' })).toBeVisible()
  expect(sessionRequests).toBeGreaterThanOrEqual(3)

  const cookie = (await context.cookies(`${accountOrigin}/api/account/v1/session`)).find(
    ({ name }) => name === 'hhc_session'
  )
  expect(cookie).toMatchObject({ httpOnly: true, secure: true })

  const storageState = await context.storageState({ indexedDB: true })
  expect(JSON.stringify(storageState)).not.toContain(accessToken)
  expect(await page.evaluate(() => Object.values(sessionStorage))).not.toContain(accessToken)

  await page.getByRole('button', { name: 'Account menu for Ada Lovelace' }).click()
  await page.getByRole('menuitem', { name: 'Preferences' }).click()
  await page.getByTestId('category-media').click()
  await page.getByLabel('Offline Policy').click()
  await page.getByRole('option', { name: 'Online only' }).click()
  await page.locator('[data-slot="modal-backdrop"]').click({ position: { x: 5, y: 5 } })

  await page.getByRole('link', { name: /files/i }).click()
  await page.getByLabel('New').click()
  await page.getByRole('menuitem', { name: 'Sync LINE group' }).click()
  await page.getByRole('button', { name: collection.name }).click()
  await page.getByRole('button', { name: 'Add Folder' }).click()
  const importedCollection = page.locator(`span[title="${collection.name}"]`)
  await expect(importedCollection).toBeVisible()
  await importedCollection.dblclick()
  for (const item of media) await expect(page.getByText(item.displayName)).toBeVisible()

  const projectionPromise = context.waitForEvent('page')
  await page.getByText('Welcome.mp4').dblclick()
  const projection = await projectionPromise
  await expect(page).toHaveURL(/#\/media$/)
  await expect.poll(() => ticketRequests.length).toBeGreaterThan(0)
  const projectedVideo = projection.locator('video')
  await expect(projectedVideo).toBeVisible()
  await expect
    .poll(() =>
      contentRequests.some(({ fromProjection, range }) => fromProjection && Boolean(range))
    )
    .toBe(true)
  const mediaRangeRequest = contentRequests.find(
    ({ fromProjection, range }) => fromProjection && Boolean(range)
  )
  expect(mediaRangeRequest).toMatchObject({
    status: 206,
    referer: undefined
  })
  expect(mediaRangeRequest?.range).toMatch(/^bytes=\d*-\d*$/)
  await expect
    .poll(() =>
      projectedVideo.evaluate(
        (video) =>
          video.readyState >= HTMLMediaElement.HAVE_METADATA &&
          Number.isFinite(video.duration) &&
          video.duration > 0 &&
          video.seekable.length === 1
      )
    )
    .toBe(true)

  for (const item of media.filter(({ id }) => id !== 'video-1')) {
    await page.getByTestId('media-back-to-files').click()
    await page.getByText(item.displayName, { exact: true }).dblclick()
    const isPresentation = item.mimeType.includes('presentationml.presentation')
    await expect(page).toHaveURL(isPresentation ? /#\/presentations\// : /#\/media$/)
    await expect
      .poll(() => ticketRequests.filter((url) => url.endsWith(`ticket-${item.id}`)).length)
      .toBe(1)
  }
  expect(ticketRequests).toHaveLength(media.length)

  const ticketUrl = ticketRequests.find((url) => url.endsWith('ticket-video-1'))!

  const finalStorageState = await context.storageState({ indexedDB: true })
  expect(JSON.stringify(finalStorageState)).not.toContain('ticket-')
  expect(await page.evaluate(() => Object.values(localStorage))).not.toContain(ticketUrl)
  expect(await page.evaluate(() => Object.values(sessionStorage))).not.toContain(ticketUrl)
  const cacheUrls = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      for (const response of await caches.open(name).then((cache) => cache.matchAll())) {
        urls.push(response.url)
      }
    }
    return urls
  })
  expect(cacheUrls.some((url) => url.includes('/api/assets/content?ticket='))).toBe(false)
  const persistedFileBlobs = await page.evaluate(async () => {
    let count = 0
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(info.name!)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (db.objectStoreNames.contains('file-blobs')) {
        count += await new Promise<number>((resolve, reject) => {
          const request = db.transaction('file-blobs').objectStore('file-blobs').count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      }
      db.close()
    }
    return count
  })
  expect(persistedFileBlobs).toBe(0)
  await context.unrouteAll({ behavior: 'ignoreErrors' })
})

test('excludes presentations from a mixed folder media playlist', async ({ page, context }) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )

  await page.goto('/')
  await completeOnboarding(page)
  await page.getByRole('link', { name: /files/i }).click()
  const upload = page.locator('input[type="file"]:not([webkitdirectory])').first()
  await upload.setInputFiles({ name: 'First.png', mimeType: 'image/png', buffer: png })
  await upload.setInputFiles({ name: 'Clip.mp4', mimeType: 'video/mp4', buffer: TINY_MP4 })
  await upload.setInputFiles({
    name: 'Bulletin.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\nxref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n109\n%%EOF'
    )
  })
  await upload.setInputFiles(
    resolve(process.cwd(), 'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx')
  )
  await expect(page.getByText('text-placeholder-layout.pptx')).toBeVisible()

  const projectionPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: /Start projection|開始投影/ }).click()
  const projection = await projectionPromise
  await expect(page).toHaveURL(/#\/media$/)
  await expect(projection.getByRole('img', { name: 'First.png' })).toBeVisible()
  await page.getByRole('button', { name: /Grid|網格|网格/ }).click()

  await expect(page.getByRole('button', { name: /First\.png 1/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Clip\.mp4 2/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Bulletin\.pdf 3/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /text-placeholder-layout\.pptx/ })).toHaveCount(0)
})

test('uses full-window Media controls and closes from the control workspace', async ({
  page,
  context
}) => {
  test.setTimeout(60_000)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )

  await page.goto('/')
  await completeOnboarding(page)
  await page.getByRole('link', { name: /files/i }).click()
  await expect(page).toHaveURL(/#\/files$/)

  const upload = page.locator('input[type="file"]:not([webkitdirectory])').first()
  await upload.setInputFiles({ name: 'First.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByText('First.png')).toBeVisible()
  const projectionPromise = context.waitForEvent('page')
  await page.getByText('First.png').dblclick()
  const projection = await projectionPromise
  await expect(page).toHaveURL(/#\/media$/)
  await expect(projection.getByRole('img', { name: 'First.png' })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await page.waitForTimeout(500)
  await expect(page).toHaveURL(/#\/media$/)

  await page.setViewportSize({ width: 900, height: 800 })
  const mediaBack = page.getByTestId('media-back-to-files')
  const nextItem = page.getByText('Next', { exact: true })
  const notes = page.getByRole('textbox')
  await expect(mediaBack).toBeVisible()
  await expect(nextItem).toBeVisible()
  await expect(notes).toBeVisible()
  const mediaBackBox = await mediaBack.boundingBox()
  const nextItemBox = await nextItem.boundingBox()
  const notesBox = await notes.boundingBox()
  expect(mediaBackBox).not.toBeNull()
  expect(nextItemBox).not.toBeNull()
  expect(notesBox).not.toBeNull()
  expect(nextItemBox!.x).toBeGreaterThan(mediaBackBox!.x)
  expect(notesBox!.x).toBeGreaterThan(mediaBackBox!.x)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )

  await page.getByTestId('media-back-to-files').click()
  await expect(page).toHaveURL(/#\/files$/)
  await expect.poll(() => projection.isClosed()).toBe(true)

  await upload.setInputFiles({ name: 'Second.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByText('Second.png')).toBeVisible()
  const headerProjectionPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: /Start projection|開始投影/ }).click()
  const headerProjection = await headerProjectionPromise
  await expect(page).toHaveURL(/#\/media$/)
  await expect(headerProjection.getByRole('img', { name: 'First.png' })).toBeVisible()
  expect(context.pages()).toHaveLength(2)

  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/#\/files$/)
  await expect.poll(() => headerProjection.isClosed()).toBe(true)
})

test('keeps a read-only PPTX stage primary at the 900px breakpoint', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await completeOnboarding(page)
  await page.goto('/#/files')

  const fixture = resolve(
    process.cwd(),
    'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
  )
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(fixture)
  const file = page.getByText('text-placeholder-layout.pptx')
  await expect(file).toBeVisible()
  await file.click()
  await file.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Open Presentation|開啟簡報|打开演示文稿/ }).click()
  await expect(page).toHaveURL(/#\/presentations\//)

  await expect(page.locator('[data-pptx-slide-surface] > *').first()).toBeVisible()
  await expect(page.locator('[data-pptx-thumbnail="true"]').first()).toBeVisible()
  await expect(
    page.getByText(/Failed to load presentation|無法載入簡報|无法加载演示文稿/)
  ).toHaveCount(0)

  await page.setViewportSize({ width: 900, height: 800 })

  const navigator = page.locator('.workspace-navigator-slot')
  const stage = page.locator('.workspace-stage-slot')
  const slidesTrigger = page.getByRole('button', { name: /Slides|投影片/ })
  await expect(page.getByRole('button', { name: /Edit a copy|編輯副本/ })).toBeVisible()
  await expect(navigator).toBeHidden()
  await expect(slidesTrigger).toBeVisible()
  await expect(stage).toBeVisible()
  const title = stage.getByText('text-placeholder-layout.pptx', { exact: true })
  const slidesBox = await slidesTrigger.boundingBox()
  const titleBox = await title.boundingBox()
  expect(slidesBox).not.toBeNull()
  expect(titleBox).not.toBeNull()
  expect(slidesBox!.y + slidesBox!.height).toBeLessThanOrEqual(titleBox!.y)

  await slidesTrigger.click()
  await expect(navigator).toBeVisible()
  await page.getByRole('button', { name: /Close (Slides|投影片|幻灯片)/ }).click()
  await expect(slidesTrigger).toBeFocused()
  await expect(navigator).toBeHidden()
  await expect(stage).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )

  await page.getByRole('button', { name: /Edit a copy|編輯副本/ }).click()
  const ribbonFrame = page.getByTestId('presentation-ribbon-frame')
  await expect(ribbonFrame).toBeVisible()
  await expect(page.getByRole('tablist')).toHaveCount(0)
  const editableSurface = page.locator('.presentation-stage [data-slide-surface]')
  await editableSurface.click({ button: 'right', position: { x: 20, y: 20 } })
  await page.getByRole('menuitem', { name: /Format Background|設定背景格式|设置背景格式/ }).click()
  const inspector = page.locator('.workspace-inspector-slot')
  const inspectorDialog = page.getByRole('dialog', {
    name: /Format Background|設定背景格式|设置背景格式/
  })
  await expect(inspector).toBeVisible()
  await expect(inspectorDialog.locator('.workspace-overlay-close:visible')).toHaveCount(1)
  await expect(inspector.locator('.workspace-inspector-content-close:visible')).toHaveCount(0)
  await inspectorDialog.locator('.workspace-overlay-close').click()

  await page.setViewportSize({ width: 1440, height: 900 })
  await editableSurface.click({ button: 'right', position: { x: 20, y: 20 } })
  await page.getByRole('menuitem', { name: /Format Background|設定背景格式|设置背景格式/ }).click()
  await expect(inspector).toBeVisible()
  await expect(inspector.locator('.workspace-overlay-close:visible')).toHaveCount(0)
  await expect(inspector.locator('.workspace-inspector-content-close:visible')).toHaveCount(1)
  await inspector.locator('.workspace-inspector-content-close').click()

  const projectionPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: /Start projection|開始投影/ }).click()
  const projection = await projectionPromise
  await expect(projection.getByText(/主愛永不止息/)).toBeVisible()
  await expect(page).toHaveURL(/#\/media$/)
})

export {}
