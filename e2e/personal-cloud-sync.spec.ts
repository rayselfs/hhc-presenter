import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { completeOnboarding } from './helpers'
import type {
  PersonalMutationRequest,
  PersonalMutationResult,
  PersonalRemoteNode
} from '../src/shared/personal-cloud'

test('two clients preserve an offline rename conflict and replay a lost commit response', async ({
  browser
}) => {
  test.setTimeout(90000)
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZaoAAAAASUVORK5CYII=',
    'base64'
  )
  let remote: PersonalRemoteNode = {
    id: 'image',
    collectionId: 'space',
    kind: 'file',
    name: 'original.png',
    assetId: 'asset-image',
    revision: 1
  }
  const receipts = new Map<string, PersonalMutationResult>()
  let lostResponse = false
  const requests: PersonalMutationRequest[] = []
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'qa-owner', roles: [], exp: 4102444800 })).toString('base64url')}.signature`
  const install = async (context: BrowserContext): Promise<void> => {
    await context.route('https://account.alive.org.tw/api/account/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      const json = path.endsWith('/session')
        ? {
            authenticated: true,
            user: {
              id: 'qa-owner',
              display_name: 'Cloud QA',
              permissions: ['presenter:cloud:manage']
            }
          }
        : path.endsWith('/csrf-token')
          ? { csrf_token: 'qa-csrf' }
          : { access_token: token }
      await route.fulfill({ json })
    })
    await context.route('https://www.alive.org.tw/api/assets/personal-space**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path.endsWith('/changes')) {
        await route.fulfill({
          json: {
            collection: { id: 'space', revision: remote.revision },
            items: [remote],
            nextCursor: `cursor-${remote.revision}`,
            hasMore: false,
            reset: true
          }
        })
      } else if (path.endsWith('/content')) {
        await route.fulfill({ contentType: 'image/png', body: png })
      } else if (path.endsWith('/mutations')) {
        const operation: PersonalMutationRequest = request.postDataJSON()
        requests.push(operation)
        const receipt = receipts.get(operation.operationId)
        if (receipt) {
          await route.fulfill({ json: receipt })
          return
        }
        if (operation.expectedRevision !== remote.revision) {
          await route.fulfill({
            status: 409,
            json: { error: { code: 'AST_CONFLICT', message: 'Revision changed' } }
          })
          return
        }
        expect(operation.type).toBe('rename')
        remote = { ...remote, name: operation.name!, revision: remote.revision + 1 }
        const result = {
          itemId: remote.id,
          nodeRevision: remote.revision,
          collectionRevision: remote.revision
        }
        receipts.set(operation.operationId, result)
        if (!lostResponse) {
          lostResponse = true
          await route.abort('failed')
          return
        }
        await route.fulfill({ json: result })
      } else await route.fulfill({ json: { id: 'space', revision: remote.revision } })
    })
  }
  const open = async (context: BrowserContext): Promise<Page> => {
    await install(context)
    const page = await context.newPage()
    await page.goto('/')
    await completeOnboarding(page)
    await page.getByRole('link', { name: 'Cloud documents', exact: true }).click()
    await expect(
      page.locator('[data-file-item][role="button"]').filter({ hasText: 'original.png' })
    ).toBeVisible()
    return page
  }
  const rename = async (page: Page, current: string, next: string): Promise<void> => {
    await page
      .locator('[data-file-item][role="button"]')
      .filter({ hasText: current })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const input = page.locator('textarea[aria-label]').filter({ visible: true })
    await input.fill(next)
    await input.press('Enter')
    await expect(
      page.locator('[data-file-item][role="button"]').filter({ hasText: `${next}.png` })
    ).toBeVisible()
  }
  try {
    const [a, b] = await Promise.all(contexts.map(open))
    await contexts[0].setOffline(true)
    await rename(a, 'original.png', 'offline')
    await rename(b, 'original.png', 'cloud')
    await expect.poll(() => remote.name).toBe('cloud.png')
    await expect
      .poll(() => requests.filter((request) => request.name === 'cloud.png').length, {
        timeout: 20000
      })
      .toBe(2)
    await expect(b.getByText('Cloud folder · Synced', { exact: true })).toHaveCount(0)
    expect(requests.filter((request) => request.name === 'cloud.png')).toHaveLength(2)
    expect(receipts.size).toBe(1)
    await contexts[0].setOffline(false)
    await a.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(a.getByRole('button', { name: 'Save a local copy', exact: true })).toBeVisible({
      timeout: 20000
    })
    await a.getByRole('button', { name: 'Save a local copy', exact: true }).click()
    await a
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Save a local copy', exact: true })
      .click()
    await expect(
      a.locator('[data-file-item][role="button"]').filter({ hasText: 'cloud.png' })
    ).toBeVisible({ timeout: 20000 })
    const copies = await a.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('hhc-file-explorer')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const tx = db.transaction('folder-items')
      const items = await new Promise<Array<{ name: string; personalOwnerId?: string }>>(
        (resolve) => {
          const request = tx.objectStore('folder-items').getAll()
          request.onsuccess = () => resolve(request.result)
        }
      )
      db.close()
      return items.filter((item) => item.name === 'offline.png' && !item.personalOwnerId).length
    })
    expect(copies).toBe(1)
    expect(remote.name).toBe('cloud.png')
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
