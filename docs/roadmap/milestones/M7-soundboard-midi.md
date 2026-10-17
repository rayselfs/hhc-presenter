# M7 Soundboard & MIDI

## Status

Legacy implementation retired on 2026-10-18. The existing `/soundboard` redirect to Timer and
shared audio/media capabilities remain. The scope and source anchors below are historical;
new Ableton-oriented functionality requires separate investigation and implementation.
See the [retirement execution record](../../reports/2026-10-18-legacy-retirement-execution.md).

## Goal

Add a top-level Soundboard workspace for live audio cue playback with mouse-first operation and optional MIDI input.

## Historical implemented scope

- Dormant Soundboard route implementation; the public route redirects to Timer.
- Audio media capability support in the shared media registry.
- Persistent Soundboard state for boards, scenes, pads, pad settings, and MIDI mappings.
- 8x8 pad grid for the initial layout.
- Audio library and pad assignment using the existing File Explorer media storage.
- Web Audio playback engine for Electron and Web.
- Mixer controls for master and per-pad playback.
- Optional Web MIDI input mapping.
- Dormant Soundboard preferences implementation; the category remains hidden.
- Asset-delete warning when audio files are referenced by pads.

## Historical source anchors

- `src/renderer/src/pages/SoundboardPage.tsx`
- `src/renderer/src/components/Control/Soundboard/`
- `src/renderer/src/stores/soundboard.ts`
- `src/renderer/src/lib/soundboard-audio.ts`
- `src/renderer/src/lib/soundboard-midi.ts`
- `src/renderer/src/lib/media-capabilities.ts`
- `docs/soundboard-architecture.md`

## Acceptance Criteria

- Soundboard is available as a first-class workspace.
- Mouse operation works without a MIDI device.
- Pads can be assigned existing or newly uploaded audio assets.
- Pads can play, stop, fade, and report playback state.
- MIDI support is optional and failure-tolerant.
- Settings persist without storing runtime playback state.
- Audio assets remain managed by the shared media library.

## Historical verification

```bash
npx vitest run src/renderer/src/lib/__tests__/media-capabilities.test.ts
npx vitest run src/renderer/src/lib/__tests__/soundboard-audio.test.ts
npx vitest run src/renderer/src/lib/__tests__/soundboard-midi.test.ts
npx vitest run src/renderer/src/stores/__tests__/soundboard.test.ts
npx vitest run src/renderer/src/stores/__tests__/soundboard-scenes.test.ts
npx vitest run src/renderer/src/stores/__tests__/soundboard-assets.test.ts
npm run typecheck
npm run lint
```

## Historical follow-up candidates

- MIDI mapping import/export.
- Multiple controller profiles.
- Per-pad waveform preview.
- Audio ducking and global emergency stop refinements.
