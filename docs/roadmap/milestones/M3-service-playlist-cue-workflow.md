# M3 Service Playlist / Cue Workflow Plan

## Status

Legacy implementation retired on 2026-10-18. The existing `/service` redirect to Timer remains.
The scope below is historical; new Service functionality requires a separate implementation.
See the [retirement execution record](../../reports/2026-10-18-legacy-retirement-execution.md).

## Goal

Add a live service rundown so operators present from an ordered cue list instead of directly from File Explorer folders.

## Key Changes

- Add a top-level Service workspace.
- Add cue types for media, Bible passage, timer, and future slide/song content.
- Track current, next, and preview cue state.
- Support reorder, duplicate, remove, jump, and mark-complete operations.
- Let cues reference existing media/library records instead of copying assets.
- Use the M1 projection session API for cue playback.

## Acceptance Criteria

- A user can build a service list and run it in order.
- Media and Bible cues can project through the same session lifecycle.
- File Explorer remains an asset library.
- Service state persists between app restarts.
- Broken/missing cue sources are visible before projection.

## Historical verification

```bash
npx vitest run src/renderer/src/stores/__tests__/service-playlist.test.ts
npx vitest run src/renderer/src/components/Control/Service/__tests__
npm run typecheck
npm run lint
```
