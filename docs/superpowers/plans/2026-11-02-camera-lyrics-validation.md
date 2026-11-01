# Camera lyrics implementation and validation

The primary platform is Windows; macOS and browser use the same local OCR worker. This change is opt-in on the existing camera page and does not change the existing raw capture/key workflow.

## Delivered behavior

- OCR reads the selected capture before the existing camera transform. An adjustable normalized crop includes all source rows, including the third row.
- Recognized blocks are grouped by vertical overlap and ordered left to right. Output is an explicit string array; there is no wrapping, semantic reflow, dictionary correction, two-line limit, or automatic font reduction.
- Preview and projection share the same 1920×1080 black/white renderer. Font, font size, line height and bottom distance are adjustable. Additional rows grow upward from the same bottom anchor.
- Manual correction pauses automatic recognition. Hide/show is independent. Overflow is reported and displayed as black instead of clipped text. Disabling subtitles restores the existing raw video peer and transform.
- Source changes and worker cleanup fence asynchronous completions. Muted/ended tracks clear manual text too. Projection snapshots expire without another message; captured images and text are not persisted or uploaded.
- For the existing SE-2200 black-key workflow, output has no shadow or outline. Physical key level, color range and signal format remain installation checks.

## Runtime choice

Build-time SDK: `@paddleocr/paddleocr-js@0.4.2`; runtime: `onnxruntime-web@1.24.3`, single-thread WASM in the SDK worker. Detector: `PP-OCRv5_mobile_det`; recognizer: `PP-OCRv6_small_rec`. An older v5 recognizer misread `祂` as `他` on a three-line picture fixture and was rejected. There is no text-substitution workaround.

The worker, WASM and SHA-256 verified model archives are shipped with Electron. Browser assets are same-origin and loaded on demand, outside PWA precache; the optional runtime has its own 64 MiB budget. Desktop access uses a read-only protocol allowlist. Sandbox and context isolation stay enabled. Models are fetched only at build time, not at church during desktop use. The SDK worker transport is version-pinned and must be revalidated before upgrades.

Recognition is serial, with no frame queue. The crop is reduced to at most 960 pixels wide. Only byte-identical processed pixels reuse a result; a small text change cannot be skipped by a difference threshold. Two identical row structures are required before acceptance; an identical frame can confirm the cached result. After a changed or uncertain frame, the last accepted text expires within one second if no replacement is accepted. Moving backgrounds can therefore require more inference and can temporarily clear subtitles; no universal video-background guarantee is made.

## Executed local evidence

Real OCR fixtures contain original test sentences on black, dark-photo/white-text and bright-photo/black-text backgrounds, each with two and three rows. Photos are generated test assets; no private worship slides are committed. Automated camera inputs supply rendered frames, not mocked OCR results.

- Local Chromium: 30 consecutive changes, 30 exact row-array matches. At 960-pixel processing width: median 1,099 ms, nearest-rank P95 1,342 ms, including the first cold initialization. This run also included other local verification work and is not a standalone hardware benchmark.
- The prior 1280-pixel run also matched 30/30, at median 1,802 ms and P95 2,946 ms. The initial engineering target of P95 ≤1 second has not been established.
- Sandboxed macOS Electron with the built `file://` renderer: 30/30 exact changes, median 646 ms / P95 1,308 ms. Includes a separate projection window, styles, manual correction and switching back to raw video. The same 30-case flow is repeated by the Windows CI job.
- Windows runner evidence: native Electron 30/30, median 994 ms / P95 1,423 ms; Chromium 30/30, median 1,022 ms / P95 1,416 ms. These are CI-runner measurements, not target capture-card machine performance.
- Automated checks cover row grouping, exact pixel comparison, low-confidence rejection, crop/style/message validation, manual input limits, overflow, font loading, snapshot expiry and stale OCR completion after disposal/mute/end. Existing camera/owner/recovery checks remain part of regression testing.
- Full local hosted-browser regression: 103 passed, 3 existing conditional skips. Desktop/hosted builds, type checks and lint passed; lint retains one unrelated pre-existing unused-disable warning. The CI full unit run also passed on the implementation commit.
- The final targeted hosted-browser rerun also verifies that an overflowed cue recovers after navigating away from the camera page, and that a warm offline browser can restart its OCR worker. Runtime assets use bounded NetworkFirst caching with offline fallback so stable filenames do not retain old model/runtime files indefinitely after an update. A late automatic completion cannot overwrite manual corrections or a disabled session.

The PR's CI results and uploaded evidence are authoritative for the final commit. Windows CI builds the desktop renderer and runs native Electron before building the hosted renderer, then runs real Chromium OCR and existing camera projection tests. Switching that order would accidentally test web-only paths under `file://`.

## Remaining installation acceptance

- Real Windows capture-card/PowerPoint window capture, minimizing/freezing behavior and target-machine performance. Fake capture fixtures do not prove these hardware paths.
- A 30-minute resource/thermal soak on the actual Windows broadcast machine, including repeated source and projection changes.
- Actual SE-2200 preview/program checks: signal format, RGB/YUV and full/limited range, black removal and intact antialiased white strokes on bright and dark camera footage.
- Broader songs/fonts/backgrounds and moving video. These fixtures do not establish arbitrary-content accuracy or 99% recognition.

Merge is authorized after green CI. No tag or release is authorized for this change. Keep the task worktree for the remaining installation acceptance; do not update a dirty primary checkout.
