import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { access, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { completeOnboarding } from './helpers'
import { verifyVlcFixtures } from './helpers/vlc-fixtures'

interface PlaybackState {
  itemId: string
  phase: 'preparing' | 'ready' | 'playing' | 'paused' | 'ended'
  currentTime: number
  duration: number
  isPlaying: boolean
  isEnded: boolean
  seekable?: boolean
  volume?: number
}

interface VlcFailure {
  code: string
  message: string
  itemId?: string
}

interface PackagedVlcEvidence {
  states: PlaybackState[]
  failures: VlcFailure[]
}

let electronApp: ElectronApplication | null = null
let processLogs = ''
let currentControl: Page | null = null
let currentUserDataPath: string | null = null

function packagedFfmpegPath(executablePath: string): string {
  const platformDir = process.platform === 'win32' ? 'win32-x64' : `darwin-${process.arch}`
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const resources =
    process.platform === 'darwin'
      ? join(dirname(executablePath), '..', 'Resources')
      : join(dirname(executablePath), 'resources')
  return resolve(resources, 'video-engine', 'ffmpeg', platformDir, executable)
}

async function launchPackaged(
  executablePath: string,
  userDataPath: string
): Promise<{ app: ElectronApplication; control: Page }> {
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    timeout: 15_000
  })
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on('data', (chunk) => {
      processLogs = `${processLogs}${String(chunk)}`.slice(-64 * 1024)
    })
  }
  const control = await app.firstWindow()
  await expect(control).toHaveTitle(/HHC Presenter|HHC 投影系統|HHC 投影系统/)
  await completeOnboarding(control)
  return { app, control }
}

async function installVlcEvidenceCapture(control: Page): Promise<void> {
  await control.evaluate(() => {
    Reflect.set(window, '__packagedVlcEvidence', { states: [], failures: [] })
    const unsubscribeState = window.api.projection.onProjectionMessage(
      (_generation, channel, data) => {
        const evidence = Reflect.get(window, '__packagedVlcEvidence') as { states: unknown[] }
        if (channel === 'file:playback-state') evidence.states.push(data)
      }
    )
    const unsubscribeFailure = window.api.projectionVlc.onFailure((failure) => {
      const evidence = Reflect.get(window, '__packagedVlcEvidence') as { failures: unknown[] }
      evidence.failures.push(failure)
    })
    Reflect.set(window, '__packagedVlcUnsubscribe', [unsubscribeState, unsubscribeFailure])
  })
}

async function evidence(control: Page): Promise<PackagedVlcEvidence> {
  return control.evaluate(() => Reflect.get(window, '__packagedVlcEvidence'))
}

async function latestState(control: Page): Promise<PlaybackState | null> {
  return (await evidence(control)).states.at(-1) ?? null
}

async function startCurrentVideo(control: Page): Promise<void> {
  await control.evaluate(() => window.dispatchEvent(new CustomEvent('media:togglePlay')))
}

async function waitForItemState(control: Page, itemId: string): Promise<void> {
  await expect
    .poll(async () => (await latestState(control))?.itemId, { timeout: 20_000 })
    .toBe(itemId)
}

async function queueInitialVlcControls(control: Page, itemId: string): Promise<void> {
  await control.evaluate(async (targetItemId) => {
    const { lifecycle } = await window.api.projection.check()
    const generation = lifecycle.generation
    window.api.projection.send(generation, 'file:control', {
      action: 'volume',
      itemId: targetItemId,
      value: 0.4
    })
    window.api.projection.send(generation, 'file:control', {
      action: 'seek',
      itemId: targetItemId,
      value: 3
    })
    window.api.projection.send(generation, 'file:control', {
      action: 'play',
      itemId: targetItemId
    })
  }, itemId)
}

async function seekCurrentVideo(control: Page, seconds: number): Promise<void> {
  await control.evaluate(
    (offset) =>
      window.dispatchEvent(
        new CustomEvent('media:videoSeekRelative', { detail: { seconds: offset } })
      ),
    seconds
  )
}

async function selectGridItem(control: Page, fileName: string): Promise<void> {
  await control.getByRole('button', { name: /Grid|網格|网格/ }).click()
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const item = control.getByRole('button', { name: new RegExp(escaped) })
  await item.evaluate((button: HTMLButtonElement) => button.click())
  await expect(item).toHaveCount(0)
}

async function fixtureItemIds(
  userDataPath: string,
  fixtureHashes: Record<string, string>
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {}
  const nativeFiles = join(userDataPath, 'native-files')
  for (const id of await readdir(nativeFiles)) {
    const digest = createHash('sha256')
      .update(await readFile(join(nativeFiles, id)))
      .digest('hex')
    const fixture = Object.entries(fixtureHashes).find(([, hash]) => hash === digest)?.[0]
    if (fixture) ids[fixture] = id
  }
  return ids
}

async function expectPlayingState(control: Page, itemId?: string): Promise<PlaybackState> {
  await expect
    .poll(
      async () => {
        const state = await latestState(control)
        return Boolean(
          state &&
          (!itemId || state.itemId === itemId) &&
          state.isPlaying &&
          state.seekable === true &&
          state.duration >= 7.9 &&
          state.duration <= 8.1
        )
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  return (await latestState(control))!
}

async function expectConfirmedSeek(control: Page, itemId: string, minimum: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await latestState(control)
        return state?.itemId === itemId ? state.currentTime : -1
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(minimum)
}

async function attachEvidence(testInfo: TestInfo, userDataPath?: string): Promise<void> {
  await testInfo.attach('packaged-app-vlc.log', {
    body: Buffer.from(processLogs.slice(-64 * 1024)),
    contentType: 'text/plain'
  })
  if (!userDataPath) return
  const cache = join(userDataPath, 'video-remux-cache')
  const metadata: Array<{ file: string; content: string }> = []
  for (const file of await readdir(cache).catch(() => [] as string[])) {
    if (!file.endsWith('.json')) continue
    metadata.push({ file, content: await readFile(join(cache, file), 'utf8') })
  }
  await testInfo.attach('remux-metadata.json', {
    body: Buffer.from(JSON.stringify(metadata, null, 2)),
    contentType: 'application/json'
  })
}

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  await attachEvidence(testInfo, currentUserDataPath ?? undefined)
  if (currentControl && !currentControl.isClosed()) {
    await testInfo.attach('playback-evidence.json', {
      body: Buffer.from(JSON.stringify(await evidence(currentControl), null, 2)),
      contentType: 'application/json'
    })
  }
  await electronApp?.close()
  electronApp = null
  currentControl = null
  currentUserDataPath = null
  processLogs = ''
})

test('launches packaged control and projection windows with recovery lifecycle', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(90_000)
  const configuredPath = process.env.PACKAGED_APP_PATH
  if (!configuredPath) throw new Error('PACKAGED_APP_PATH is required')
  const userDataPath = testInfo.outputPath('user-data')
  ;({ app: electronApp } = await launchPackaged(resolve(configuredPath), userDataPath))
  const control = await electronApp.firstWindow()

  await control.getByTestId('btn-start').click()
  await expect.poll(() => electronApp?.windows().length ?? 0).toBe(2)
  const projection = electronApp.windows().find((window) => window.url().endsWith('#/projection'))
  if (!projection) throw new Error('Projection window did not open')
  await expect(projection.locator('.timer-digits').first()).toBeVisible()
  await projection.reload()
  await expect(projection.locator('.timer-digits').first()).toBeVisible()

  await control.evaluate(() => {
    window.location.hash = '/files'
  })
  await expect(control).toHaveURL(/#\/files$/)
  await expect(projection.locator('.timer-digits').first()).toBeVisible()
  await control.getByRole('button', { name: /Stop projection|停止投影/ }).click()
  await expect
    .poll(() => control.evaluate(() => window.api.projection.check()))
    .toMatchObject({ exists: false, lifecycle: { status: 'closed' } })
  expect(electronApp?.windows()).toHaveLength(2)
  expect(projection.isClosed()).toBe(false)
})

test('VLC production matrix', async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(180_000)
  const configuredPath = process.env.PACKAGED_APP_PATH
  if (!configuredPath) throw new Error('PACKAGED_APP_PATH is required')
  const packagedAppPath = resolve(configuredPath)
  const userDataPath = testInfo.outputPath('user-data')
  const fixtures = await verifyVlcFixtures(packagedFfmpegPath(packagedAppPath))
  await testInfo.attach('vlc-fixture-manifest.json', {
    body: fixtures.manifestBytes,
    contentType: 'application/json'
  })
  await testInfo.attach('vlc-fixture-manifest.sha256', {
    body: Buffer.from(createHash('sha256').update(fixtures.manifestBytes).digest('hex')),
    contentType: 'text/plain'
  })

  const launched = await launchPackaged(packagedAppPath, userDataPath)
  electronApp = launched.app
  const control = launched.control
  currentControl = control
  currentUserDataPath = userDataPath
  await control.evaluate(() => {
    window.location.hash = '/files'
  })
  await expect(control).toHaveURL(/#\/files$/)
  await installVlcEvidenceCapture(control)

  const orderedFiles = [
    'healthy.mp4',
    'healthy.mkv',
    'broken-cues-readable.mkv',
    'unreadable-truncated.mkv'
  ]
  await control
    .locator('input[type="file"]:not([webkitdirectory])')
    .first()
    .setInputFiles(orderedFiles.map((file) => fixtures.paths[file]))
  for (const file of orderedFiles)
    await expect(control.getByText(file, { exact: true })).toBeVisible()
  const itemIds = await fixtureItemIds(
    userDataPath,
    Object.fromEntries(fixtures.manifest.fixtures.map((fixture) => [fixture.file, fixture.sha256]))
  )
  expect(Object.keys(itemIds)).toHaveLength(orderedFiles.length)

  await test.step('native MP4 reports owner playback and confirmed seek', async () => {
    await control.getByText('healthy.mp4', { exact: true }).dblclick()
    await expect.poll(() => electronApp?.windows().length ?? 0).toBe(2)
    await startCurrentVideo(control)
    const state = await expectPlayingState(control, itemIds['healthy.mp4'])
    await seekCurrentVideo(control, 4)
    await expectConfirmedSeek(control, state.itemId, 3.5)
  })

  let healthyMkvItemId = ''
  let healthyCacheMetadataPath = ''
  let healthyCacheMtime = 0
  await test.step('queued VLC controls and healthy MKV cache', async () => {
    await selectGridItem(control, 'healthy.mkv')
    await queueInitialVlcControls(control, itemIds['healthy.mkv'])
    await expectPlayingState(control, itemIds['healthy.mkv'])
    healthyMkvItemId = itemIds['healthy.mkv']
    await expectConfirmedSeek(control, healthyMkvItemId, 2.5)
    const confirmedVolume = (await latestState(control))?.volume
    const headlessWindowsAudio =
      process.platform === 'win32' &&
      confirmedVolume === 0 &&
      processLogs.includes('mmdevice audio output error: cannot get default device')
    await testInfo.attach('volume-acknowledgement.json', {
      body: Buffer.from(JSON.stringify({ requested: 0.4, confirmedVolume, headlessWindowsAudio })),
      contentType: 'application/json'
    })
    if (headlessWindowsAudio) {
      testInfo.annotations.push({
        type: 'headless-audio',
        description: 'Windows runner has no default audio device; verify volume on installed smoke.'
      })
    } else {
      expect(confirmedVolume).toBeCloseTo(0.4, 1)
    }

    const cache = join(userDataPath, 'video-remux-cache')
    await expect
      .poll(
        async () => (await readdir(cache).catch(() => [])).filter((f) => f.endsWith('.json')).length
      )
      .toBe(1)
    healthyCacheMetadataPath = join(cache, (await readdir(cache)).find((f) => f.endsWith('.json'))!)
    healthyCacheMtime = (await stat(healthyCacheMetadataPath)).mtimeMs
  })

  let brokenItemId = ''
  await test.step('rapid replacement keeps the new VLC owner and broken cues remain recoverable', async () => {
    await selectGridItem(control, 'healthy.mkv')
    await selectGridItem(control, 'broken-cues-readable.mkv')
    brokenItemId = itemIds['broken-cues-readable.mkv']
    await waitForItemState(control, brokenItemId)
    await startCurrentVideo(control)
    await expectPlayingState(control, brokenItemId)
    await seekCurrentVideo(control, 4)
    await expectConfirmedSeek(control, brokenItemId, 3.5)
    const projection = electronApp!
      .windows()
      .find((window) => window.url().endsWith('#/projection'))
    if (!projection) throw new Error('Projection window did not open')
    await testInfo.attach('projection-renderer.png', {
      body: await projection.screenshot(),
      contentType: 'image/png'
    })
    await control.waitForTimeout(750)
    expect((await latestState(control))?.itemId).toBe(brokenItemId)
  })

  await test.step('healthy MKV reuses its source-hash cache', async () => {
    await selectGridItem(control, 'healthy.mkv')
    await waitForItemState(control, healthyMkvItemId)
    await startCurrentVideo(control)
    await expectPlayingState(control, healthyMkvItemId)
    expect((await stat(healthyCacheMetadataPath)).mtimeMs).toBe(healthyCacheMtime)
  })

  await test.step('unreadable truncation fails and retry creates a fresh attempt', async () => {
    const unreadableItemId = itemIds['unreadable-truncated.mkv']
    const unreadableSource = join(userDataPath, 'native-files', unreadableItemId)
    const unreadableCache = join(userDataPath, 'video-remux-cache', unreadableItemId)
    await selectGridItem(control, 'broken-cues-readable.mkv')
    await waitForItemState(control, brokenItemId)
    await startCurrentVideo(control)
    await expectPlayingState(control, brokenItemId)
    await selectGridItem(control, 'unreadable-truncated.mkv')
    await expect
      .poll(
        async () =>
          (await evidence(control)).failures.filter(
            (failure) =>
              failure.itemId === unreadableItemId && failure.code === 'matroska-remux-failed'
          ).length,
        { timeout: 20_000 }
      )
      .toBe(1)
    expect(
      (await evidence(control)).states
        .filter((state) => state.itemId === unreadableItemId)
        .map((state) => state.phase)
    ).toEqual(['preparing'])
    await expect(access(`${unreadableCache}.mkv`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(`${unreadableCache}.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      createHash('sha256')
        .update(await readFile(unreadableSource))
        .digest('hex')
    ).toBe(
      fixtures.manifest.fixtures.find((fixture) => fixture.file === 'unreadable-truncated.mkv')
        ?.sha256
    )
    await control.getByRole('button', { name: /Retry projection|重試投影|重试投影/ }).click()
    await expect
      .poll(
        async () =>
          (await evidence(control)).failures.filter(
            (failure) =>
              failure.itemId === unreadableItemId && failure.code === 'matroska-remux-failed'
          ).length,
        { timeout: 20_000 }
      )
      .toBe(2)
    await expect(access(`${unreadableCache}.mkv`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  await test.step('packaged restart removes only stale remux temps', async () => {
    await attachEvidence(testInfo, userDataPath)
    await electronApp!.close()
    electronApp = null
    const cache = join(userDataPath, 'video-remux-cache')
    await mkdir(cache, { recursive: true })
    const stale = join(cache, '.stale.e2e.tmp.mkv')
    const young = join(cache, '.young.e2e.tmp.mkv')
    await Promise.all([writeFile(stale, 'stale'), writeFile(young, 'young')])
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    ;({ app: electronApp } = await launchPackaged(packagedAppPath, userDataPath))
    await expect
      .poll(() =>
        access(stale).then(
          () => true,
          () => false
        )
      )
      .toBe(false)
    await expect
      .poll(() =>
        access(young).then(
          () => true,
          () => false
        )
      )
      .toBe(true)
  })
})

test('persists generated document bytes through native storage', async ({
  browserName: _browserName
}, testInfo) => {
  const configuredPath = process.env.PACKAGED_APP_PATH
  if (!configuredPath) throw new Error('PACKAGED_APP_PATH is required')
  ;({ app: electronApp } = await launchPackaged(
    resolve(configuredPath),
    testInfo.outputPath('user-data')
  ))
  const control = await electronApp.firstWindow()
  const result = await control.evaluate(async () => {
    const id = crypto.randomUUID()
    const content = JSON.stringify({ schemaVersion: 1, name: 'Native generated snapshot' })
    try {
      const imported = await window.api.nativeFs.importFile(
        id,
        new File([content], 'generated.lpdeck', { type: 'application/vnd.hhc.presenter+json' })
      )
      const response = await fetch(window.api.nativeFs.getUrl(id, 'application/json'))
      return { size: imported.size, text: await response.text(), expected: content }
    } finally {
      await window.api.nativeFs.delete(id)
    }
  })
  expect(result.text).toBe(result.expected)
  expect(result.size).toBe(Buffer.byteLength(result.expected))
})
