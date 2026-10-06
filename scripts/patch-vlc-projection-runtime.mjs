/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const original = '  pushArg("--no-video-title-show");'
const patched = `${original}\n  pushArg("--no-snapshot-preview");\n  pushArg("--no-osd");`

export function patchVlcProjectionRuntime(source, version) {
  if (version !== '1.0.2') throw new Error(`Review the VLC native patch for version ${version}`)
  const pointer = '    g_vlc_argv_ptrs.push_back(g_vlc_argv_storage.back().c_str());'
  const initialize =
    '  g_vlc = p_libvlc_new(static_cast<int>(g_vlc_argv_ptrs.size()), g_vlc_argv_ptrs.data());'
  const stablePointers = `  for (const auto &arg : g_vlc_argv_storage) g_vlc_argv_ptrs.push_back(arg.c_str());\n${initialize}`
  if (source.split(initialize).length !== 2) throw new Error('Unexpected VLC initialization call')
  if (!source.includes(stablePointers)) {
    if (source.split(pointer).length !== 2) throw new Error('Unexpected VLC argument storage')
    source = source.replace(`${pointer}\n`, '').replace(initialize, stablePointers)
  }
  // Keep native errors visible for runtime diagnosis, without enabling verbose logs.
  source = source.replace('  pushArg("--quiet");', '  pushArg("--verbose=0");')
  if (source.includes(patched)) return source
  if (source.split(original).length !== 2) throw new Error('Unexpected VLC initialization source')
  // VLC snapshots show both a PIP and a filename OSD unless disabled at instance initialization.
  return source.replace(original, patched)
}

export function patchVlcEventDispatch(source, version) {
  if (version !== '1.0.2') throw new Error(`Review the VLC event patch for version ${version}`)
  if (source.includes('// HHC: queue events without the player mutex.'))
    return source.replace('electron_vlc_player_event', 'hhc_vlc_event_dispatch_main')
  const hash = createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex')
  if (hash !== '0418a85611baac59851c79ccd09c8a8383c9becc0d672ee0e271d62364c481a7')
    throw new Error('Unexpected VLC event source')
  source = source.replace(
    '  int playerId = -1;',
    '  libvlc_event_t event = {};\n  int playerId = -1;'
  )
  source = source.replace(
    'static std::map<int, Napi::ThreadSafeFunction> g_player_event_tsfn;',
    `static std::map<int, Napi::ThreadSafeFunction> g_player_event_tsfn;
// HHC: queue events without the player mutex.
static std::mutex g_event_mutex;
static std::map<PlayerState *, int> g_event_players;`
  )
  const start = source.indexOf(
    '  {\n    std::lock_guard<std::mutex> lock(g_mutex);',
    source.indexOf('void VlcDispatchPlayerEvent')
  )
  const end = source.indexOf('    Napi::HandleScope scope(env);', start)
  source =
    source.slice(0, start) +
    `  // libVLC calls this with its event lock held. Never take g_mutex or call libVLC here.
  std::lock_guard<std::mutex> eventLock(g_event_mutex);
  auto owner = g_event_players.find(state);
  if (owner == g_event_players.end()) { delete payload; return; }
  playerId = owner->second;
  auto it = g_player_event_tsfn.find(playerId);
  if (it == g_player_event_tsfn.end()) { delete payload; return; }
  tsfn = it->second;
  payload->playerId = playerId;
  payload->type = event->type;
  payload->event = *event;

  const napi_status status = tsfn.NonBlockingCall(payload, [](Napi::Env env, Napi::Function jsCallback, JsEventPayload *data) {
    if (!env || !jsCallback) { delete data; return; }
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      PlayerState *current = VlcFindPlayer(data->playerId);
      if (!current || !current->mp) { delete data; return; }
      OnVlcEvent(&data->event, current);
      EnrichPayload(&data->event, data, current);
    }
` +
    source.slice(end)
  source = source.replace(
    '    delete data;\n  });',
    '    delete data;\n  });\n  if (status != napi_ok) delete payload;'
  )
  source = source.replace(
    'static void VlcClearPlayerEventHandlerLocked(int playerId) {',
    `static void VlcClearPlayerEventHandlerLocked(int playerId) {
  for (auto it = g_event_players.begin(); it != g_event_players.end();) {
    if (it->second == playerId) it = g_event_players.erase(it);
    else ++it;
  }`
  )
  source = source.replace(
    'void VlcClearPlayerEventHandler(int playerId) {\n  std::lock_guard<std::mutex> lock(g_mutex);',
    'void VlcClearPlayerEventHandler(int playerId) {\n  std::lock_guard<std::mutex> lock(g_event_mutex);'
  )
  source = source.replace(
    '  VlcClearPlayerEventHandlerLocked(playerId);\n\n  if (info.Length()',
    '  std::lock_guard<std::mutex> eventLock(g_event_mutex);\n  VlcClearPlayerEventHandlerLocked(playerId);\n\n  if (info.Length()'
  )
  source = source.replace(
    '  Napi::Function callback = info[1].As<Napi::Function>();',
    '  g_event_players[VlcFindPlayer(playerId)] = playerId;\n  Napi::Function callback = info[1].As<Napi::Function>();'
  )
  return source.replace('electron_vlc_player_event', 'hhc_vlc_event_dispatch_main')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve('node_modules/electron-vlc-player')
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const path = resolve(root, 'src/native/libvlc_dynload.cc')
  const source = await readFile(path, 'utf8')
  const next = patchVlcProjectionRuntime(source, version)
  if (next !== source) await writeFile(path, next)
  const eventsPath = resolve(root, 'src/native/vlc_events.cc')
  const events = await readFile(eventsPath, 'utf8')
  const patchedEvents = patchVlcEventDispatch(events, version)
  if (patchedEvents !== events) await writeFile(eventsPath, patchedEvents)
}
