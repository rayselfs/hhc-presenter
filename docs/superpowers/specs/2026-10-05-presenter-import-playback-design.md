# Presenter import and playback reliability

## Intent and evidence

Repair cloud-folder imports, non-browser video playback, and multi-page presentation controls. The user authorized investigation by three agents, an independent plan review with corrections, implementation, a PR, and passing CI. Merge/release is outside this delivery boundary. Start: `origin/main` `71041794` (2.6.5).

### Cloud imports

Personal cloud files have separate catalog item IDs and immutable blob IDs. `upload-utils.ts` incorrectly queues derived assets with the item ID as the source. Other cloud providers (OneDrive, LINE, shared collections) are read-only by design; preserve those permissions.

The Asset API personal upload policy permits at most 200 MiB and excludes SVG, while the generic local import accepts SVG. Unsupported MIME uploads can create a permanently failed outbox head and block later operations. The existing transaction already rejects files above 200 MiB before persistence; the size defect is preflight/feedback, not size poisoning. File picker handlers also lack guaranteed error reporting and input reset. These are code/contract findings, not a live production upload reproduction.

### Video

Registry-native MP4/MOV/WebM remain native on Electron even when metadata says browser-unplayable. Projection has no late media error handler. Metadata reads dimensions/duration after resetting the element and does not clean up failures or bound loading time.

Retain HTML playback for healthy videos, use existing VLC for confirmed unsupported local desktop videos, and keep FFmpeg for remux/posters. FFmpeg stream copy cannot change an unsupported codec. Building an FFmpeg player would add rendering/audio clock/seek/lifecycle responsibilities without evidence that the existing VLC engine is the root cause.

References: [electron-vlc-player](https://github.com/ssnangua/electron-vlc-player), [LibVLC 3 media player](https://videolan.videolan.me/vlc-3.0/group__libvlc__media__player.html), [FFmpeg stream copy](https://ffmpeg.org/ffmpeg.html), [ffplay](https://ffmpeg.org/ffplay.html), [HTML media events](https://html.spec.whatwg.org/multipage/media.html#event-media-loadedmetadata).

### Presentation pages

Raw import retains the entire file; the existing real PPTX conversion fixture passes with 22 pages. The confirmed defects are that G lists files, unknown slide count lets Next end the one-file playlist before preview finishes loading, and Home/End select files instead of presentation pages. The ten-page browser E2E subsequently reproduced persistent first-page projection for an open editable session: the operator advanced to page 2 while `media-projection-sync.ts` built the projection payload from the editor workspace active slide. The presenter page state must be authoritative for this explicit projection navigation; workspace selection remains unchanged. PPT is unsupported; PDF uses its existing separate navigation and is not silently reclassified as PPTX.

## Required behavior

- Resolve derived assets from the persisted blob identity and associate results with the catalog item.
- Apply personal-cloud size/MIME policy before persistence, including non-picker import paths. Keep local import capabilities unchanged. Report per-file failures and allow reselecting the same file.
- Expose failed sync reason and a safe explicit retry for recoverable failures. Preserve snapshots, account isolation, leases, operation ordering and idempotency. For permanently invalid, never-submitted create-file uploads, allow explicit backup to local and cancellation only after fresh scope validation proves removal safe; never auto-drop data or skip dependent operations. Finalize/flush editable sessions before capturing cancellation scope and reject pending/unsaved editor changes both before and after backup; catalog revision alone cannot detect unflushed edits.
- Probe video metadata with bounded cleanup; snapshot values before source reset. Timeout/network uncertainty must not become permanent codec rejection.
- Confirmed unsupported desktop videos use existing VLC only after native storage/runtime checks. Late decode/source-not-supported errors trigger at most one owner-scoped promotion, preserving playback position, transport and volume, including pending controls. Stale errors and asynchronous results cannot replace a newer owner/item/generation. Bind reports to their current projection origin and content/load revision; lifecycle generation alone is insufficient for same-item restart or media→timer→media. Capture coordinator show/session identity before fallback work and require it unchanged after awaits.
- Healthy HTML playback never initializes VLC. Browser or unavailable desktop fallback gives an actionable failure. Replays and re-projection retain the promoted engine.
- Unknown presentation page count cannot advance/end the deck. G displays actual pages of the current PPTX/lpdeck with usable previews; ordinary media keeps its existing file grid. Page selection and Home/End use the same save/preflight/generation protections as other presentation navigation. Dispose thumbnail handles/viewer on close/source change, bound active renders, and ignore obsolete source readiness/errors.

## Constraints and acceptance

Use existing TypeScript patterns, no new playback dependency, no `as any` or suppression comments. Preserve Electron/browser modes, projection ownership, account isolation, read-only providers and security scan gates. Do not alter backend policy or migrate app identity. Tests must cover real behavior and failure paths; use a real ten-page PPTX for browser navigation verification. Complete lint, typecheck, unit suite, build and CI browser E2E. Native/device acceptance is a distinct evidence state, not implied by CI.
