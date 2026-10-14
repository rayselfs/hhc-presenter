# Editable preset geometry readiness

## Scope and activation

This is the first Phase 2 object slice of the approved DeckCraft-reference TypeScript goal. It adds roundRect, triangle, rtTriangle, diamond and four directional block arrows to existing rectangle/ellipse geometry. Schema v3 retains the preset identity and optional signed-32 integer adjustments. Values are clamped for rendering/editing, without rewriting raw values on open.

The editor, saved thumbnails and projection consume one pure geometry resolver. Existing transform/history, save coordinator and clipboard mechanisms remain authoritative. Handles support rotated/scaled pointer edits, keyboard edits and Escape cancellation; the numeric inspector also works in compact windows. Import/export preserve constant adjustment guides. Retained-source no-op returns exact bytes; adjusted exports patch owned geometry and keep opaque metadata and unrelated ZIP members.

General blank/import/provider copy still writes v1; retained-source v2 and new v3 documents are explicit gated paths. The matching isolated Asset API/OpenAPI validator is implemented but unmerged and undeployed. Local tests do not authorize enabling normal v3 writes.

## Local verification on 2026-10-13

The plan ledger records exact commands, prior failures and their corrections. After the final theme-style admission fix (client `8c5ae6ce`), full isolated-thread Vitest passed 310 suites / 3914 tests (169.98s); both typechecks and repository lint passed. Fresh desktop/web builds and bundle checks passed.

- Genuine built browser geometry acceptance and affected regressions: 27/27 passed (54.5s), including gallery insertion, numeric/rotated handle edits, Escape, undo/redo, save/reopen, eight preset paths, actual native/source downloads and projection ownership.
- Genuine built macOS Electron geometry acceptance: 1/1 passed (6.4s), using its default 1200px window and real compact inspector controls. The isolated userData directory was verified and removed; user profiles and download folders were not used.
- The browser invocation includes the existing export/source/22-page hymn/navigation/rendering/text flows and excludes Electron at collection. The Electron-specific geometry/download flow ran separately above; neither final invocation skipped a collected test.
- Independent LibreOffice checks of actual browser and Electron original/native/source-no-op/source-adjusted downloads: eight variants, 64 pages, 192 shape contours passed. Separate analytic formulas measured maximum deviation 0.07787552 points against a predeclared 0.1-point consumer quantization/cubic tolerance; stroke width tolerance is 0.01 points. Source no-op bytes and all unrelated adjusted-package members were compared directly. An eight-preset Office contact sheet and source-adjusted first page were inspected for Chinese glyphs and visible shape geometry.

The first actual Electron run exposed the compact inspector gated solely by background-panel state. A new regression failed before the minimal condition/label/focus fix; 69 workspace tests and the full suite passed afterward. Original failures remain part of the acceptance record. The fresh whole-branch review finished with zero Critical, one Important and zero Minor findings; its independent 341 tests passed. The Important finding was reproduced and fixed in one TDD pass: unrepresented inherited theme fill/line/effects now fail with located diagnostics, while explicit local overrides and harmless theme defaults remain accepted. Partial line inheritance and Office join behavior have regression coverage. This is an admission correction, not full theme inheritance support; the existing retained-source v2 path remains unchanged. All final runtime and Office gates were refreshed after the fix. No second review was requested.

API full race tests passed in 27 packages using an owned loopback-only PostgreSQL container pinned to the CI image. `go vet`, explicit governance export/publisher tests and Redocly 2.47.0 OpenAPI lint passed (70 lint warnings). The dedicated low-disk media filesystem test was skipped because that unrelated dedicated filesystem was not configured; the governance test skipped in the full run was subsequently executed explicitly. The owned test container was verified by id, name, task/thread labels and loopback binding before removal.

## Consumer and platform limits

Task-only official Noto CJK fontconfig makes Chinese glyphs available to the Office consumer without changing system fonts or document font names. Initial missing-glyph PDF evidence is retained. LibreOffice uses round joins for every fixture. [Microsoft documents default round joins](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/c0c046ec-a61d-405d-88fe-74d8487a37d7) and [miter exceptions for right/up/down arrows](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/562a55ee-ce0a-42b9-a8ef-9df10db1a07e); those defaults are mapped in renderer/thumbnail admission with miter limit 8. Actual Microsoft PowerPoint/device acceptance is still pending.

Unsupported extended shape text, custom geometry, advanced fill/effects/outline variants and the remaining preset catalog fail the editable admission boundary. These are subsequent object slices, followed by groups/connectors/tables/charts, masters/layouts/themes and playback. This first subset does not finish Phase 2 or the overall goal.

CI requires an actual workflow run. Neither worktree has been pushed, merged, deployed or released, and Windows projector/audio/IME, authenticated cloud rollout and physical-device acceptance remain separate gates.

## Closure and evidence

Tasks 1–4 are locally complete. Full source, review, RED/GREEN logs, actual downloads and independent consumer reports are archived at `/Users/rayselfs/.codex/visualizations/2026/10/11/01a12b4f-88d0-7980-82da-40c2abb5b65f/deckcraft-pptx-preset-geometry-20261013`, with a SHA-256 manifest. The client and API (`fd2de231`) branches/worktrees are retained for subsequent approved slices. Large-deck/long-session profiling remains part of the final platform phase.
