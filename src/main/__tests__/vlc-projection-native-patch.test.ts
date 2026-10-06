import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

it('applies silent snapshot defaults idempotently and rejects unsupported sources/versions', async () => {
  const scriptPath = resolve('scripts/patch-vlc-projection-runtime.mjs')
  const script: { patchVlcProjectionRuntime: (source: string, version: string) => string } =
    await import(scriptPath)
  const original = [
    '    g_vlc_argv_ptrs.push_back(g_vlc_argv_storage.back().c_str());',
    '  pushArg("--no-video-title-show");',
    '  pushArg("--quiet");',
    '  g_vlc = p_libvlc_new(static_cast<int>(g_vlc_argv_ptrs.size()), g_vlc_argv_ptrs.data());'
  ].join('\n')
  const patched = script.patchVlcProjectionRuntime(original, '1.0.2')
  expect(patched).toContain('for (const auto &arg : g_vlc_argv_storage)')
  expect(patched).not.toContain('g_vlc_argv_storage.back().c_str()')
  expect(patched).toContain('pushArg("--verbose=0")')
  expect(patched).not.toContain('pushArg("--quiet")')
  expect(patched).toContain('pushArg("--no-osd")')
  expect(patched).toContain('pushArg("--no-snapshot-preview")')
  expect(script.patchVlcProjectionRuntime(patched, '1.0.2')).toBe(patched)
  expect(() => script.patchVlcProjectionRuntime(original, '1.0.3')).toThrow()
  expect(() => script.patchVlcProjectionRuntime('changed upstream', '1.0.2')).toThrow()
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  expect(packageJson.scripts.postinstall).toContain('npm run rebuild:vlc')
})

it('queues native events without taking the player mutex or calling libVLC on its callback thread', async () => {
  const scriptPath = resolve('scripts/patch-vlc-projection-runtime.mjs')
  const script: { patchVlcEventDispatch: (source: string, version: string) => string } =
    await import(scriptPath)
  const source = await readFile(
    resolve('node_modules/electron-vlc-player/src/native/vlc_events.cc'),
    'utf8'
  )
  const patched = script.patchVlcEventDispatch(source, '1.0.2')
  expect(script.patchVlcEventDispatch(patched, '1.0.2')).toBe(patched)
  expect(() => script.patchVlcEventDispatch('changed upstream', '1.0.2')).toThrow()
  expect(() => script.patchVlcEventDispatch(source, '1.0.3')).toThrow()
  expect(patched).toContain('hhc_vlc_event_dispatch_main')
  expect(
    script.patchVlcEventDispatch(
      patched.replace('hhc_vlc_event_dispatch_main', 'electron_vlc_player_event'),
      '1.0.2'
    )
  ).toBe(patched)
  const dispatch = patched.slice(patched.indexOf('void VlcDispatchPlayerEvent'))
  const callbackThread = dispatch.slice(0, dispatch.indexOf('const napi_status status'))
  expect(callbackThread).toContain('eventLock(g_event_mutex)')
  expect(callbackThread).not.toContain('lock(g_mutex)')
  expect(callbackThread).not.toContain('OnVlcEvent(event')
  expect(callbackThread).not.toContain('EnrichPayload(event')
  expect(dispatch).toContain('OnVlcEvent(&data->event, current)')
  expect(dispatch).toContain('if (status != napi_ok) delete payload')
})
