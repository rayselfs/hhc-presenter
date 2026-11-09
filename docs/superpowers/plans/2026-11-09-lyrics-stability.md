# Lyrics Stability Implementation Plan

**Goal:** Persist the subtitle preference and prevent transient OCR failures from blanking live lyrics, while preserving phrase gaps and emitting Traditional Chinese.

**Architecture:** Keep preference in the existing persisted store and accepted lyrics in memory. Separate the projection heartbeat expiry from recognition freshness. Stage validated layout before replacing displayed text. Use the existing OpenCC conversion and geometric OCR boxes, without changing models or confidence thresholds.

**Scope:** `camera-lyrics.ts`, `CameraSessionContext.tsx`, lyrics line/gate processing, layout and output, their unit tests, and existing browser/Electron lyrics fixtures. No dependency, release, model or projection ownership changes.

**Behavior:** Two matching nonempty observations accept a cue. Whitespace differences between Chinese characters do not restart stability. Empty observations must persist for 5 seconds and at least two observations; uncertainty resets this pending transition. Failed recognition retains accepted text. Disabled mode, changed source/crop and ended/muted source clear text. A 1-second projection heartbeat lease still clears disconnected output. New cues keep the previous validated layout until their own validation completes; explicit empty/hidden output clears immediately. Invalid/overflow layouts remain hidden.

**Risks:** Blank cues incur a deliberate 5-second delay. A live but persistently misrecognizing source can retain old lyrics; the operator error remains visible. Real capture/switcher timing needs hardware acceptance before release.

- [x] Add regression tests for persistence/migration, lifecycle, confidence failure, delayed empty frames, phrase spacing, Traditional conversion, and atomic layout replacement; confirm failures.
- [x] Implement minimal changes and run focused tests.
- [x] Extend real OCR fixtures for spaced lyrics and reload persistence; run lint, types, full tests, desktop/web builds and browser checks.
- [ ] Review diff, commit and push. Open draft PR to trigger PR-only CI; wait for all required checks and retain draft status. Do not merge, tag or release.

**Observed OCR limit:** The real model can emit an entire spaced sentence as one block without internal spaces. Tests require all words in Traditional Chinese and tolerate this model whitespace loss; geometry and explicit block-boundary whitespace are preserved when available. No pixel segmentation or language-model correction is introduced.

**Local validation:** 365 unit-test files passed (4,611 tests passed, one existing skip) with two workers; lint passed with one existing FolderBrowser unused-disable warning; node/web/E2E types passed; desktop and hosted builds and bundle checks passed. Electron real OCR workflow passed; nine browser lyrics/camera/hosted-artifact checks passed, including WASM fallback and preference reload. Initial unrestricted unit concurrency produced timeouts in unrelated presentation/PPTX tests; the full two-worker rerun passed. Hardware acceptance and release remain outside this PR.
