# Lyrics Stability Implementation Plan

**Goal:** Persist the subtitle preference and prevent transient OCR failures from blanking live lyrics, while preserving phrase gaps and emitting Traditional Chinese.

**Architecture:** Keep preference in the existing persisted store and accepted lyrics in memory. Separate the projection heartbeat expiry from recognition freshness. Stage validated layout before replacing displayed text. Use the existing OpenCC conversion and geometric OCR boxes, without changing models or confidence thresholds.

**Scope:** `camera-lyrics.ts`, `CameraSessionContext.tsx`, lyrics line/gate processing, layout and output, their unit tests, and existing browser/Electron lyrics fixtures. No dependency, release, model or projection ownership changes.

**Behavior:** Two matching nonempty observations accept a cue. Whitespace differences between Chinese characters do not restart stability. Empty observations must persist for 5 seconds and at least two observations; uncertainty resets this pending transition. Failed recognition retains accepted text. Disabled mode, changed source and ended/muted source clear text. Crop edits are preview-only until applied; applying retains the accepted cue while the new area is recognized. A 1-second projection heartbeat lease still clears disconnected output. New cues keep the previous validated layout until their own validation completes; explicit empty/hidden output clears immediately. Invalid/overflow layouts remain hidden.

**Risks:** Blank cues incur a deliberate 5-second delay. A live but persistently misrecognizing source can retain old lyrics; the operator error remains visible. Real capture/switcher timing needs hardware acceptance before release.

- [x] Add regression tests for persistence/migration, lifecycle, confidence failure, delayed empty frames, phrase spacing, Traditional conversion, and atomic layout replacement; confirm failures.
- [x] Implement minimal changes and run focused tests.
- [x] Extend real OCR fixtures for spaced lyrics and reload persistence; run lint, types, full tests, desktop/web builds and browser checks.
- [ ] Review diff, commit and push. Open draft PR to trigger PR-only CI; wait for all required checks and retain draft status. Do not merge, tag or release.

**Observed OCR limit:** The real model can emit an entire spaced sentence as one block without internal spaces. Tests require all words in Traditional Chinese and tolerate this model whitespace loss; geometry and explicit block-boundary whitespace are preserved when available. No pixel segmentation or language-model correction is introduced.

**Local validation:** 365 unit-test files passed (4,611 tests passed, one existing skip) with two workers; lint passed with one existing FolderBrowser unused-disable warning; node/web/E2E types passed; desktop and hosted builds and bundle checks passed. Electron real OCR workflow passed; nine browser lyrics/camera/hosted-artifact checks passed, including WASM fallback and preference reload. Initial unrestricted unit concurrency produced timeouts in unrelated presentation/PPTX tests; the full two-worker rerun passed. Hardware acceptance and release remain outside this PR.


## Operator recovery follow-up

Ray authorized these changes in the same PR after three read-only consultant rounds. Keep the independent worktree and draft PR; do not merge or release.

- Show retained-cue status and time since the last accepted observation on the operator screen. Hidden subtitles remain explicitly marked as hidden.
- Add runtime-only hide/show controls; continue OCR and resume the latest accepted cue without switching to camera imagery. Mode preference remains the only persisted mode state.
- Preview crop edits, with Apply and Cancel actions. Retain the old cue while the applied area is confirmed. Preserve initialization/source failure and its recovery action when applying a crop.
- Offer direct OCR retry through the existing session retry action; keep capture and accepted lyrics intact. Remove instructions referring to an unavailable manual editor.
- Repair spacing from later matching Chinese candidates without relaxing word boundaries or line structure.
- Use one source snapshot for both OCR attempts. If a <=960px result is empty or uncertain and native detail is available, retry once up to 1920px. Keep confidence validation unchanged and cache the accepted result against the low-resolution pixels. An uncertain detected word followed by a missed fallback is not a confirmed blank cue.

Validation includes staged crop UI, retained status, hidden updates/resume, retry without recapture, initialization failure recovery, later spacing, 4s empty/uncertainty/5s empty boundaries, and bounded fallback. Existing browser and Electron workflows exercise crop application and hidden/resumed output. Physical capture-card/switcher acceptance and recognition-rate benchmarking remain separate; this change does not claim a measured accuracy gain.

The small-viewport workflow reproduced a font menu closing during recognition recovery: removing the retained-cue detail row moved the scroll container. Reserve status/detail space so recovery does not move controls under an open picker. A direct repeated-OCR/search test and the original real-OCR workflow cover the interaction. No forced clicks or reduced correctness assertions are used.

**Follow-up local verification:** 365 unit-test files passed (4,622 tests, one existing skip); lint and node/web/E2E types passed (existing FolderBrowser warning only). Desktop/web builds and bundle/hosted checks passed. Electron real OCR workflow passed; all ten browser camera/lyrics/hosted checks passed, including 24px source text and CPU fallback. Final local 30-cue runs measured Electron median 364ms / p95 541ms and browser median 417ms / p95 544ms; these are fixture measurements, not hardware acceptance or measured accuracy gains. Independent review's initialization-recovery finding was fixed and re-reviewed with no remaining actionable findings.
