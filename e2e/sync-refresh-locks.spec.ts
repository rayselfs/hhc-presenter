import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

type Harness = typeof import('../src/renderer/src/lib/sync-refresh-lifetime') &
  Pick<typeof import('../src/renderer/src/lib/file-explorer-db'), 'openFileExplorerDB'>
type HarnessWindow = Window & {
  SyncLifetime: Harness
  releaseMutation: () => void
  mutation: Promise<void>
  guard: () => Promise<boolean>
  enteredMutation: boolean
}

test('real Web Locks serialize a connection across tabs and a durable unlink invalidates the old guard', async ({
  page,
  context
}) => {
  const bundle = await build({
    stdin: {
      contents:
        "export * from './src/renderer/src/lib/sync-refresh-lifetime'; export { openFileExplorerDB } from './src/renderer/src/lib/file-explorer-db'",
      resolveDir: process.cwd()
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'SyncLifetime'
  })
  await context.route('**/__test-sync-lifetime.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
  )
  await context.route('**/api/bible/v2/versions', (route) => route.fulfill({ json: [] }))
  await context.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  const other = await context.newPage()
  for (const tab of [page, other]) {
    await tab.goto('/')
    await tab.addScriptTag({ url: '/__test-sync-lifetime.js' })
  }
  await page.evaluate(async () => {
    const target = window as HarnessWindow
    const api = target.SyncLifetime
    const db = await api.openFileExplorerDB()
    const root = {
      id: 'lock-smoke-root',
      name: 'Smoke root',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerType: 'onedrive' as const,
        providerConnectionId: 'onedrive:lock-smoke',
        remoteFolderId: 'remote-root'
      }
    }
    await db.put('folder-records', root)
    target.guard = api.createSyncRefreshGuard(root)
    let entered!: () => void
    const acquired = new Promise<void>((resolve) => {
      entered = resolve
    })
    target.mutation = api.withSyncConnectionMutation('onedrive:lock-smoke', async () => {
      entered()
      await new Promise<void>((resolve) => {
        target.releaseMutation = resolve
      })
    })
    await acquired
  })
  await other.evaluate(() => {
    const target = window as HarnessWindow
    target.enteredMutation = false
    target.mutation = target.SyncLifetime.withSyncConnectionMutation(
      'onedrive:lock-smoke',
      async () => {
        target.enteredMutation = true
        const db = await target.SyncLifetime.openFileExplorerDB()
        await db.delete('folder-records', 'lock-smoke-root')
      }
    )
  })
  await expect
    .poll(() =>
      other.evaluate(async () =>
        (await navigator.locks.query()).pending?.some(
          (lock) => lock.name === 'hhc-sync-connection:onedrive:lock-smoke'
        )
      )
    )
    .toBe(true)
  expect(await other.evaluate(() => (window as HarnessWindow).enteredMutation)).toBe(false)
  expect(await page.evaluate(() => (window as HarnessWindow).guard())).toBe(true)
  await page.evaluate(() => (window as HarnessWindow).releaseMutation())
  await other.evaluate(() => (window as HarnessWindow).mutation)
  expect(await other.evaluate(() => (window as HarnessWindow).enteredMutation)).toBe(true)
  expect(await page.evaluate(() => (window as HarnessWindow).guard())).toBe(false)
})
