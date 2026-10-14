# DeckCraft reference pre-merge local testing

Use the existing isolated `feat/deckcraft-reference-ts` worktree at `/Users/rayselfs/.codex/worktrees/deckcraft-reference-ts/hhc-client-v2`. Do not use the primary checkout. The desktop build must be the last build: web and desktop share `out/renderer`.

## Start the isolated desktop

```sh
cd /Users/rayselfs/.codex/worktrees/deckcraft-reference-ts/hhc-client-v2
npm run build
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js --user-data-dir="$PWD/.superpowers/sdd/2026-10-13-included-review/manual-user-data"
```

The prepared `.superpowers/sdd/2026-10-13-included-review/try-presenter.command` opens the already built app with the same isolated profile. That profile persists between manual runs and does not use the installed application's data. No cloud login is required for local import/edit/export tests.

## Suggested acceptance

1. Complete onboarding and import `src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx`, the synthetic 22-slide text/layout fixture (Noto Sans TC and dark text; not the private black/white hymn original). Confirm all slides and Chinese text remain present.
2. Change a line of text and font size, undo/redo, save, close and reopen. Verify the saved result.
3. Start projection, change slides, then visit another control page. Projection should change only on explicit presentation actions according to the existing ownership rule.
4. Download PPTX and reopen it in PowerPoint if available. Compare text, page count, line breaks and the edit.
5. Import `local-solid-style.pptx`, `theme-solid-fill.pptx` and `theme-solid-line.pptx` from the same fixture directory. Local solid style should have a light-red fill and 2 px light-red outline; theme fill should match its fill color; theme line has a red 10 px outline. Save/reopen and project each.

Ordinary import still produces schema v1. Source-preserving v2 and extended preset v3 capabilities remain gated; this test does not enable them or require API deployment. Unsupported dash/arrow styles now produce an import error instead of silently losing visual information. Existing v2 documents preserve their legacy interpretation.

This is an unpackaged macOS run. Physical Windows/projector, installed-font and authenticated cloud acceptance are separate. Both client and API remain unmerged until user acceptance.

## Pre-merge correction verification (2026-10-13)

Direct solid shape colors now share the theme color transform evaluator; the equivalent red 50% tint produces `#FFBCBC` for either representation. Local outlines without theme references share the strict line-style check, preventing silent dash/arrow loss. Retained-source v2 interpretation remains unchanged.

- Formal regression RED: three reproduced failures, two passing controls; all five pass after correction.
- Affected regression suites: 236/236 passed. Independent read-only reviewer: 116/116 passed, no Important regression found.
- Final full suite: 311 files / 3955 tests passed (241.82 seconds). Lint and both typechecks passed.
- First full run: app-init Electron recovery timed out at five seconds; the next cleanup-order test observed two calls. All 15 app-init tests passed separately; the final full run passed without increasing timeouts. Initial failure logs are retained.
- Web/desktop builds and bundle checks passed. Browser 10/10 (23.3 seconds); isolated macOS Electron 3/3 (24.6 seconds), including the local solid-style fixture and synthetic 22-slide fixture native/source downloads.
- API feature branch integrated origin/main: assets and OpenAPI race tests plus `go vet ./...` passed. Client/API source and geometry contract corpora are byte-identical.

Local logs and the independent review are in `.superpowers/sdd/2026-10-13-included-review/`. Remote CI status is tracked in the draft PRs, separately from these local results.

## Actual black/white hymn verification (2026-10-14)

The previous 22-slide fixture was incorrectly described as the original hymn. It is a synthetic text/layout fixture and cannot establish black/white or 標楷體 fidelity. The actual private OneDrive sample previously recorded in the October 10 acceptance has 13 slides. Its source and lyric-bearing outputs remain local and are not committed.

- Original SHA-256: `1b3419c0981197a9b1ed706351d4526faf4c2f0d19c65c2a33f4adea51ad72cf`.
- Original XML: master background `tx1 → dk1 → #000000`; text `bg1 → lt1 → #FFFFFF`; subtitle layout paragraph alignment `ctr`; requested Latin/East Asian font `標楷體`.
- Page 1 uses 90 pt; pages 2–13 use 75 pt. Ordinary v1 import preserves the equivalent 120 px and 100 px on a 1280 × 720 canvas, with no source autofit scaling.
- All 13 pages retain black background, white text, horizontal center, top anchoring, x=0, y=26.666667 px, and 1280 px text-box width. Insets remain 9.6 px horizontally and 4.8 px vertically.
- Source XML, compatibility guards, converted styles and portable serialization assertions pass. The source file was not modified.
- Built browser: real file upload, editor, reload, close/reopen, persisted IndexedDB document and all 13 projected pages passed. Every rendered text run retained requested color/font/size. Screenshots visually confirm black/white and top/center positioning.
- Unpackaged macOS Electron: independent temporary profile, real file upload, editor reload and all 13 projected pages passed (one scenario, 5.8 seconds).
- **Font appearance remains unaccepted:** browser CSS requests `標楷體`, but Chrome platform-font inspection reports `PingFang TC / PingFangTC-Semibold` on this Mac. Requested font preservation is confirmed; actual 標楷體 glyph appearance and font-dependent wrapping still need the target Windows machine with that font installed. This check did not install or substitute fonts.

Evidence and repeatable private checks: `.superpowers/sdd/2026-10-14-real-hymn/`. The browser build uses that directory's `web-build/`, leaving the existing desktop `out/` and manual profile intact. No product-code fix was needed for the requested properties. Neither PR was merged or released.

## Near-top centered placeholder correction (2026-10-14)

A second private seven-slide hymn exposed a distinct coordinate bug. Its text alignment was already centered, but the parser replaced explicit near-top coordinates with the layout offset (x=160 px, y≈117.833 px), shifting the full-width text box to the right. Editable conversion now prefers complete explicit DrawingML transforms for both the shape and its text, and converts XML EMU values explicitly, including tiny positive/negative offsets. Missing transforms still inherit layout/master coordinates.

Re-test by restarting the prepared local app and importing the original PPTX again. Existing `.lpdeck` documents contain their saved positions and are deliberately not rewritten, because those positions may include user edits. Keep any edited copy until the fresh import is accepted.

Private reproduction, regression and Electron evidence: `.superpowers/sdd/2026-10-14-hymn-center/`. The source and lyric contents are not committed. No API change is required; no merge or release is authorized.

Verification: 414/414 affected tests passed with one worker; the initial concurrent run had one compatibility-boundary timeout (413 passed), retained in the evidence logs. Both real hymn source checks passed, including the prior 13-slide sample. Lint, typechecks, production desktop build and bundle budget passed. The independent reviewer found no remaining actionable regression. An isolated Electron run imported, reloaded and projected all seven pages successfully (4.5 seconds); the screenshot confirms horizontal centering. Windows font rendering and physical projector acceptance remain separate.

## Slide-edge and center snapping (2026-10-14)

Restart the same local launcher; snapping works on existing editable decks and does not require reimport or API deployment.

- Move a frame near the slide's left/right/top/bottom edge or either center line. It should acquire within 6 screen pixels and release beyond 10, independently of zoom.
- Resize fixed text/image frames using their eight handles. Only the dragged edges snap to slide boundaries; the opposite anchor stays fixed. Image corner resizing preserves aspect ratio, so one boundary may win when both cannot be satisfied.
- Thin magenta guides appear only during editor interaction. Hold Alt/Option while moving the pointer to bypass snapping. Release, cancel, or press Escape to clear guides. Projection and export do not include guides.
- Check Undo/Redo and save/reopen. A drag remains one history transaction. Content-height text keeps its automatic height. Rotated frames snap during movement using their visible bounds; rotated resizing remains free to preserve the existing opposite-anchor behavior.

The workspace no longer applies a second 8-document-unit snap after pointer previews; this is necessary for Alt bypass, screen-space thresholds and fixed resize anchors. Camera-workspace snapping is unchanged.

Validation: 180/180 geometry, surface and workspace tests passed, including all eight handle directions, zoom thresholds, hysteresis, image ratio, Alt bypass, Escape cleanup and single-commit behavior. Independent review found no remaining actionable issue. Local evidence: `.superpowers/sdd/2026-10-14-slide-snapping/`. No merge or release.

Boundary follow-up: the decorative slide border displaced the canvas origin by 1 CSS pixel. It now uses an inset outline without changing box geometry. Electron measurements confirm matching canvas/selection bounds (bottom subpixel rounding below 0.01 px), including bottom-right resize snapping. The focused suite passed 110 tests; lint, node/web typechecks, desktop build and bundle budgets passed. The isolated Electron smoke passed with center/edge snapping, Alt bypass, Undo and save/reopen. The user accepted both snapping behavior and the boundary correction locally. Windows physical acceptance remains unverified.
