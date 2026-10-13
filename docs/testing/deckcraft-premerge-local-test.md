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

1. Complete onboarding and import `src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx`, the original 22-slide hymn fixture. Confirm all slides and Chinese text remain present.
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
- Web/desktop builds and bundle checks passed. Browser 10/10 (23.3 seconds); isolated macOS Electron 3/3 (24.6 seconds), including the local solid-style fixture and original hymn native/source downloads.
- API feature branch integrated origin/main: assets and OpenAPI race tests plus `go vet ./...` passed. Client/API source and geometry contract corpora are byte-identical.

Local logs and the independent review are in `.superpowers/sdd/2026-10-13-included-review/`. Remote CI status is tracked in the draft PRs, separately from these local results.
