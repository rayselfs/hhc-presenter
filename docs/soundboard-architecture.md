# Soundboard Architecture

> Historical design: the legacy Soundboard UI/store/Web Audio/MIDI implementation was retired
> on 2026-10-18. Shared audio classification, File Explorer assets and media playback remain.
> The sections below describe the removed implementation, including its old pad-delete warning;
> they are not a current API or a specification for future Ableton work.
> See the [retirement execution record](reports/2026-10-18-legacy-retirement-execution.md).

## Goal

Soundboard is a top-level workspace for live audio cue playback. It is designed for
church services and drama use cases where operators need mouse or MIDI-triggered
audio pads without leaving HHC Presenter.

## Scope

- 8x8 pad grid per scene.
- Multiple boards and scenes.
- Audio assets stored through the existing File Explorer media pipeline.
- Web Audio playback in both desktop and website modes.
- Optional Web MIDI note and fader mappings.
- Preferences for default trigger mode, global fade, master volume, and MIDI enablement.

Soundboard does not project visual content and does not add a separate audio asset
database.

## Data Model

The soundboard state lives in `useSoundboardStore`.

- `boards`: persistent board records keyed by board id.
- `scenes`: persistent scene records keyed by scene id under each board.
- `pads`: persistent 8x8 pad records under each scene.
- `settings`: persistent soundboard preferences.
- `live`: non-persistent runtime pad playback state.

Only serializable data is persisted. Audio nodes, decoded buffers, MIDI access, and
other runtime resources stay outside Zustand persistence.

## Asset Identity

Pads reference File Explorer assets by `assetId`.

```ts
interface SoundboardAssetRef {
  assetId: string
  name: string
  mimeType: string
  size: number
}
```

This keeps asset ownership in the File Explorer store and lets Soundboard reuse the
same upload, storage, sync, and cleanup policies as the rest of the app.

When a File Explorer item is deleted, HHC Presenter checks whether that item is
assigned to any pad and adds a warning to the delete confirmation.

## Upload And Storage

Audio support is part of the shared media capability registry. The Soundboard library
uses audio-only upload helpers, so imported audio goes through the same canonical
File Explorer storage path as images, videos, and PDFs.

Supported first-version audio formats:

- MP3
- WAV
- M4A
- AAC
- OGG

## Playback

Playback is handled by `createSoundboardAudioEngine()`.

- The engine owns `AudioContext`, master gain, per-pad gain nodes, and decoded buffer
  cache.
- `one-shot` pads stop any previous playback on the same pad before playing again.
- `toggle` pads stop or fade out when triggered again.
- `hold` pads play on note down or mouse down and fade out on release.
- `stopAll` stops every active pad immediately.
- `fadeAll` fades active pads using the global fade setting.

Desktop and website use the same Web Audio engine. There is no Electron-native audio
path in the first version.

## MIDI

MIDI is optional. Mouse operation remains complete when MIDI is unavailable, denied,
or disconnected.

The MIDI layer normalizes raw Web MIDI messages into:

- `note-on`
- `note-off`
- `cc`

Pad mappings support:

- note trigger mapping
- CC-to-volume mapping
- `default` input id for any connected controller
- specific input id matching when a device is selected

MIDI mappings are stored on pads so boards and scenes remain portable inside app
state.

## UI Composition

Soundboard is composed from small renderer components:

- `SoundboardPageContent`: engine lifecycle, MIDI wiring, and page composition.
- `SoundboardTopBar`: board, scene, mode, and MIDI status controls.
- `SoundboardLibrary`: audio asset upload and assignment source.
- `SoundboardGrid`: 8x8 live pad surface.
- `SoundboardInspector`: selected pad editing.
- `SoundboardMixer`: master volume, stop all, and fade all controls.
- `SoundboardSettings`: preferences panel.

The page uses the same route, sidebar, and preferences patterns as Timer, Bible, and
Media.

## Non-Goals

- No timeline editor.
- No multi-track DAW workflow.
- No plugin system.
- No MIDI mapping import/export.
- No Electron-native audio engine.
- No projection output for audio-only pads.

These can be revisited after the first Soundboard workflow is stable.
