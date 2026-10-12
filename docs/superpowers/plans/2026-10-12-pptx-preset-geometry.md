# Editable Preset Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Native inline execution and continuous progress are already authorized; do not create per-task implementer/reviewer agents. One fresh whole-branch reviewer at completion.

**Goal:** Implement an independently testable first Phase 2 subset of editable preset geometry and adjustments through both portable contracts, rendering, commands and PPTX import/export, without activating incompatible default writes.

**Architecture:** Extend the existing shape element with preset kinds and optional numeric adjustments under schema v3. A small pure TypeScript resolver produces constant-code SVG paths, text bounds, handles and sites; all three surfaces consume it. Reuse existing transform/history/persistence/clipboard and source reconciliation, not a second object store or raw-viewer DOM extraction. Keep general v1 import/copy/blank creation until separate API rollout authorization.

**Tech Stack:** Existing TypeScript/React/SVG/JSZip/Vitest/Playwright; Go Asset API validation. No new dependency or Rust runtime.

**Spec:** `docs/superpowers/specs/2026-10-11-deckcraft-reference-typescript-design.md`, refined by `docs/superpowers/specs/2026-10-12-pptx-editable-object-discovery.md`. This is the first shape subset, not completion of Phase 2 or the five-phase goal.

## Global Constraints

- Use DeckCraft v0.5.0 as a reference for presentation capabilities that HHC lacks.
- The dedicated workspace is `/Users/rayselfs/.codex/worktrees/deckcraft-reference-ts/hhc-client-v2`, branch `feat/deckcraft-reference-ts`, based on `origin/main` `0980ab5350f41acc6e820469f1f816957efc4fd0`. Preserve the primary checkout and every unrelated worktree. No merge, release or deployment is authorized.
- Use versioned schema evolution for new object kinds and graph references. Continue reading v1 files and legacy files without a version. Validate/migrate at the load boundary; never mutate a source file merely by opening it.
- Enable the new schema only after the matching API validator is deployed under separate authorization. Ordinary blank/import/copy continues v1; explicit v3 fixtures/loaded v3 documents exercise the gated development path. Existing v1/v2 sources remain readable.
- Use the current save coordinator for revisions, drafts and account fences. Preserve source blob identity, read-only provider permissions and import failure cleanup.
- Client and Asset API changes stay in their existing isolated worktrees; API canonical OpenAPI and contract tests travel together. Keep the API worktree unmerged and undeployed.
- Unknown XML is inert source data: it must not become unsanitized HTML/SVG or executable content. No arbitrary SVG markup or geometry formula evaluation.
- Browser and Electron parity, projection ownership, source attribution/MIT notice and existing file format remain binding.

## Exact First Subset

Existing aliases remain `rectangle` and `ellipse`. New shape kinds use OOXML names: `roundRect`, `triangle`, `rtTriangle`, `diamond`, `rightArrow`, `leftArrow`, `upArrow`, `downArrow`. `EditableShapeElement.adjustments?: readonly number[]` stores source values/default omission, not generated SVG. Extended kinds or any adjustment field require schema v3; v1/v2 keep existing kinds without adjustments. Values must be finite integers within signed 32-bit range; at most 16 and no more than the selected preset's parameter count. Rendering clamps values by the selected preset and dimensions; opening must not rewrite stored values.

Defaults: roundRect `[16667]`, triangle `[50000]`, arrows `[50000,50000]`; other first-subset shapes have no adjustments. Use pinned `crates/geom/src/preset.rs` for shorter-side semantics, text bounds, handle axes and sites; identify adaptations in code and tests. Do not copy its unknown-preset rectangle fallback.

Extended-preset import initially rejects nonempty embedded shape text and still rejects unrepresented fill/effects/reflection/outline properties. This avoids guessed implicit text bounds and disconnected shape/text frames until the following attachment/group slice. Text boxes alongside shapes remain supported. Source no-op must retain exact original bytes; source geometry changes replace only the owned geometry fields.

## Review Focus

1. Legacy/v1/v2 documents with new geometry fields must fail before writes rather than downgrade or render rectangles; supported old documents remain unchanged. Task 1 shared-contract cases.
2. Unknown/duplicate adjustment names, expressions, overflow, non-finite values and unknown presets must not become executable SVG or fallback geometry. Tasks 1/2 rejection fixtures.
3. Extreme aspect ratios and rotation/scaled editing must produce finite paths and predictable clamped handles, with no negative size or stale pointer commit. Tasks 2/3 geometry and interaction tests.
4. Retained source opaque geometry metadata and untouched ZIP members must survive no-op/movement/style edits; an ambiguous adjustment mapping must conflict. Task 2 source reconciliation tests.
5. Read-only providers/account changes, save/reload/undo/clipboard and projection selection must preserve current ownership and schema fences. Task 3 commands/persistence and Task 4 actual dual-mode acceptance.

## Task 1: Versioned Geometry Model and Matching Contracts

**Files:** `src/renderer/src/lib/editable-presentation.ts`, `portable-presentation.ts`, `pptx-source.ts`; client `__tests__/portable-presentation.test.ts`, `pptx-source.test.ts`, new `__fixtures__/preset-geometry/contract.json`. API worktree `internal/assets/personal_deck.go`, `personal_deck_source.go`, new `personal_deck_geometry_test.go`, mirrored `internal/assets/testdata/preset-geometry/contract.json`, `docs/openapi.yaml`, `docs/openapi_test.go`.

**Interfaces:** extend document version union to `1 | 2 | 3`, shape kind union as above and optional `adjustments`. Preserve existing source-record/reference contract for versions 2/3. Existing factories/default conversion remain v1 (v2 only when explicitly retaining source).

- [ ] Write client/API RED shared cases: valid v3 basic/extended/adjusted shape; old v1/v2 basic shapes and source fixtures accepted; extended kind/adjustments in old versions rejected; unknown preset/version 4, too many values, fractional/out-of-range values and malformed source references rejected. Assert input JSON is unchanged.
- [ ] Run `npx vitest run src/renderer/src/lib/__tests__/portable-presentation.test.ts src/renderer/src/lib/__tests__/pptx-source.test.ts`; run API `go test ./internal/assets -run 'Geometry|Source'` and `go test ./docs`. Expected RED at the new cases, no unrelated fixture errors.
- [ ] Implement the exact shape/version validation on both sides, using existing graph/size/source checks; define preset parameter counts with the allow-list. Update canonical OpenAPI and its checked contract fixtures. Preserve valid legacy behavior, not previously malformed graphs.
- [ ] Rerun the same commands and client typecheck; expected PASS. Verify the two fixture copies have identical SHA-256, then commit each repository's matching contract changes.

## Task 2: Pure Geometry, Conversion and PPTX Reconciliation

**Files:** create `src/renderer/src/lib/presentation-shape-geometry.ts`, `__tests__/presentation-shape-geometry.test.ts`; modify converter, `pptx-export-drawingml.ts`, `pptx-export-source.ts`, attribution, and their existing tests.

**Interfaces:** `resolvePresetShapeGeometry(shape: EditableShapeElement): PresetShapeGeometry`, with `path: string`, `textBounds: { x: number; y: number; width: number; height: number }`, `handles: readonly PresetAdjustmentHandle[]`, `sites: readonly { x: number; y: number }[]`. Handles expose index, point, origin, direction and min/max. `projectPresetAdjustment(shape, index, point): readonly number[]` returns clamped integer values. `convertPresentationData` gains a final optional `conversionSchemaVersion?: 3`; ordinary callers omit it.

- [ ] Write RED finite/default/extreme-aspect cases for every listed preset; roundRect radius equals `min(width,height)*16667/100000`, triangle apex equals `width*adj/100000`, directional arrows use the same oriented outline/head-length semantics. Unknown presets/invalid dimensions throw, never return rectangles. Handle projection respects min/max and rotation is tested by its caller.
- [ ] Write RED bounded real-PPTX mutations for each preset/constant `avLst`, explicit empty/missing adjustments, duplicate/unknown guide names and formulas; only explicit target v3 admits extended geometry. Nonempty embedded shape text and unrepresented visual properties fail with location before persistence. Ordinary entry-point policy remains unchanged.
- [ ] Write native/source export RED cases: correct `prstGeom` and named `val` guides; imported values/default omission survive native reopen; source no-op bytes match exactly; changing an adjustment edits only owned geometry and preserves opaque metadata/unrelated members; unknown reconciliation returns `source-conflict`.
- [ ] Implement pinned formulas and safe constant adjustment parsing. Serialize Office preset names/guide values and update source geometry comparison to include adjustments. Reuse existing URI/package bounds and error types.
- [ ] Run `npx vitest run src/renderer/src/lib/__tests__/presentation-shape-geometry.test.ts src/renderer/src/lib/__tests__/editable-presentation-pptx.test.ts src/renderer/src/lib/__tests__/pptx-export-drawingml.test.ts src/renderer/src/lib/__tests__/pptx-export-source.test.ts src/renderer/src/lib/__tests__/pptx-export.test.ts`; expected all PASS. Add adapted-source notices and commit.

## Task 3: Shared Surface, Gallery and Adjustment Editing

**Files:** `components/Common/EditableSlideSurface.tsx` and existing tests, `pages/PresentationWorkspacePage.tsx` and its tests, three locales, `presentation-editor-commands.ts` only if required; existing clipboard/history/persistence suites.

**Consumes:** Task 2 geometry/handle projection and Task 1 validated v3 model. Reuse existing transform start/preview/commit/cancel callbacks; an adjustment drag commits one undo entry and cancels on replacement/escape.

- [ ] Write RED surface assertions for inert SVG path/fill/outline and consistent rotated bounds in editor/thumbnail/projection, plus selected-shape adjustment handles and numeric inspector controls. Legacy v1/v2 shapes retain their current rendering/controls.
- [ ] Write RED actual menu insertion in an explicit v3 fixture, adjustment drag at rotated/scaled coordinates, keyboard-accessible numeric updates, cancellation, undo/redo and a document switch mid-drag. New preset menu entries remain gated to v3 documents; default blank/import/copy policy stays unchanged.
- [ ] Cover add/edit/duplicate/delete/reorder/clipboard/save/reopen of adjusted v3 shapes with stable schema and source-reference detachment; read-only/account fences and editor/projection ownership stay intact.
- [ ] Implement only the existing shape surfaces, gallery and inspector changes. Generate SVG solely from validated geometry; keep existing v1/v2 CSS shape path until its separate migration is validated.
- [ ] Run affected surface/workspace/editor-command/clipboard/persistence suites and typecheck; expected PASS. Commit the working gated editor slice.

## Task 4: Independent Consumer and Complete Local Acceptance

**Files:** new bounded `e2e/presentation-preset-geometry.spec.ts`, existing isolated Electron acceptance helper/flow, `docs/testing/pptx-preset-geometry-readiness.md`, design/inventory/plan.

- [ ] Export real browser/Electron downloads from explicit v3 fixtures containing each supported preset, selected non-default adjustments, extreme ratios, rotated bounds and adjacent text. Verify undo/save/reopen and unchanged projection ownership. Keep task-owned profiles/downloads and exact failure evidence.
- [ ] Render original/native/source-no-op/source-adjusted output through isolated Office/PDF, checking actual vector bounds/shape identity/adjustment values and unrelated source bytes. Record any approximation by preset; fail/reject shapes whose consumer evidence disagrees rather than relaxing geometry checks.
- [ ] Run lint, both typechecks, full Vitest alone with a bounded worker count, desktop/web builds and affected browser/isolated Electron acceptance. API full tests/vet/OpenAPI checks run in its worktree with owned fixtures/services only. Expected zero failures; local checks are distinct from CI/device acceptance.
- [ ] Request one fresh read-only whole-slice reviewer; re-grade findings, one TDD fix pass for Important/Critical, ledger deferred minors/rulings, no re-review. Archive exact evidence, commit, clean only owned scratch/profile data and retain both unmerged worktrees.

## Self-review and Continuation

This plan covers the first geometry subset only; custom paths, full preset catalog, attached shape text, fills/effects/outlines/reflections, groups/connectors/tables/charts remain subsequent approved object slices. General schema-v3 activation and API rollout are distinct gates and are not implied by these tests. The uninterrupted/native execution method is preserved from the user's explicit instruction; no repeated confirmation is required. No implementation starts until the preceding compatibility slice's fresh final gates are closed.
