# Editable preset geometry readiness

## Scope and activation

This is the first Phase 2 object slice of the approved DeckCraft-reference TypeScript goal. It adds roundRect, triangle, rtTriangle, diamond and four directional block arrows to existing rectangle/ellipse geometry. Schema v3 retains the preset identity and optional signed-32 integer adjustments. Values are clamped for rendering/editing, without rewriting raw values on open.

The editor, saved thumbnails and projection consume one pure geometry resolver. Existing transform/history, save coordinator and clipboard mechanisms remain authoritative. Handles support rotated/scaled pointer edits, keyboard edits and Escape cancellation; the numeric inspector also works in compact windows. Import/export preserve constant adjustment guides. Retained-source no-op returns exact bytes; adjusted exports patch owned geometry and keep opaque metadata and unrelated ZIP members.

General blank/import/provider copy still writes v1; retained-source v2 and new v3 documents are explicit gated paths. The matching isolated Asset API/OpenAPI validator is implemented but unmerged and undeployed. Local tests do not authorize enabling normal v3 writes.

## Local verification on 2026-10-13

The plan ledger records exact commands, prior failures and their corrections. After the compact-inspector fix, full isolated-thread Vitest passed 310 suites / 3894 tests (170.68s); both typechecks and repository lint passed. Fresh desktop/web builds and bundle checks passed.

- Genuine built browser geometry acceptance: 1/1 passed (5.3s), including gallery insertion, numeric/rotated handle edits, Escape, undo/redo, save/reopen, eight preset paths, actual native/source downloads and projection ownership.
- Genuine built macOS Electron geometry acceptance: 1/1 passed (7.1s), using its default 1200px window and real compact inspector controls. The isolated userData directory was verified and removed; user profiles and download folders were not used.
- Existing affected browser export/source/hymn/navigation/rendering/text flows: 26 passed, one Electron-only test skipped in this browser invocation (51.7s). The new Electron-specific geometry/download flow ran separately above.
- Independent LibreOffice checks of actual browser and Electron original/native/source-no-op/source-adjusted downloads: eight variants, 64 pages, 192 shape contours passed. Separate analytic formulas measured maximum deviation 0.07787552 points against a predeclared 0.1-point consumer quantization/cubic tolerance; stroke width tolerance is 0.01 points. Source no-op bytes and all unrelated adjusted-package members were compared directly. An eight-preset Office contact sheet and source-adjusted first page were inspected for Chinese glyphs and visible shape geometry.

The first actual Electron run exposed the compact inspector gated solely by background-panel state. A new regression failed before the minimal condition/label/focus fix; 69 workspace tests and the full suite passed afterward. Original failures remain part of the acceptance record. The fresh whole-branch reviewer is pending; this is local verification, not a merge/release claim.

API full race tests passed in 27 packages using an owned loopback-only PostgreSQL container pinned to the CI image. `go vet`, explicit governance export/publisher tests and Redocly 2.47.0 OpenAPI lint passed (70 lint warnings). The dedicated low-disk media filesystem test was skipped because that unrelated dedicated filesystem was not configured; the governance test skipped in the full run was subsequently executed explicitly. The owned test container was verified by id, name, task/thread labels and loopback binding before removal.

## Consumer and platform limits

Task-only official Noto CJK fontconfig makes Chinese glyphs available to the Office consumer without changing system fonts or document font names. Initial missing-glyph PDF evidence is retained. LibreOffice uses round joins for every fixture. [Microsoft documents default round joins](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/c0c046ec-a61d-405d-88fe-74d8487a37d7) and [miter exceptions for right/up/down arrows](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/562a55ee-ce0a-42b9-a8ef-9df10db1a07e); those defaults are mapped in renderer/thumbnail admission with miter limit 8. Actual Microsoft PowerPoint/device acceptance is still pending.

Unsupported extended shape text, custom geometry, advanced fill/effects/outline variants and the remaining preset catalog fail the editable admission boundary. These are subsequent object slices, followed by groups/connectors/tables/charts, masters/layouts/themes and playback. This first subset does not finish Phase 2 or the overall goal.

CI requires an actual workflow run. Neither worktree has been pushed, merged, deployed or released, and Windows projector/audio/IME, authenticated cloud rollout and physical-device acceptance remain separate gates.
