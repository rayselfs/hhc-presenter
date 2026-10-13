# Editable object discovery

Continuation of the approved five-phase DeckCraft-reference design; current-session inline execution and uninterrupted progress are explicitly authorized. Existing isolated client/API worktrees remain the only implementation locations. No API deployment, shared push, merge or release is authorized.

## Verified source and current gaps

Pinned local source is DeckCraft v0.5.0 under `/private/tmp/hhc-deckcraft-poc/deckcraft-0.5.0`; archive SHA-256 `113b5d6e6c6ff3724b3adbf59f4146933d02fe6fc65b46612b13f2f4cc23d753`. `crates/geom/src/preset.rs` builds geometry, text bounds, adjustment handles and connection sites using OOXML preset names. `crates/model/src/lib.rs` represents preset geometry with numeric adjustments or custom paths. `crates/pptx/src/read/shapes.rs` reads at most sixteen constant adjustment values, filling missing values from preset defaults. HHC must explicitly reject unknown formulas rather than inherit upstream silent omissions.

HHC `EditableShapeKind` is rectangle/ellipse; `convertShapeNode` rejects other presets/custom geometry, advanced fills and unresolved lists. `EditableSlideSurface` paints shapes with CSS backgrounds/borders, while DrawingML export serializes preset geometry. The portable validator allows only these existing kinds. Asset API checks element kinds and graph bounds but does not currently validate preset geometry/adjustments; both sides need a coordinated contract for new geometry. Shape insertion, selection, history, arrange and clipboard already exist and should be reused. The installed renderer has internal preset geometry declarations, but its public package exports do not expose them; do not deep-import private bundled functions or use the raw-viewer rectangle fallback as editable geometry.

## Recommended sequence within Phase 2

1. Preset geometry and adjustments, with one shared pure TypeScript geometry resolver used by editor/thumbnail/projection. First independently testable subset: existing rectangle/ellipse plus rounded rectangle, triangle, diamond and directional block arrows. Keep source preset identities/adjustments rather than storing a rendered path as the editable source of truth. Add a bounded gallery and adjustment editing through existing controls; advanced/custom presets remain explicit unsupported inputs until subsequent slices.
2. Shape paint/outline/effects and custom path geometry, with inert validated path commands, bounded command counts and no arbitrary embedded SVG/HTML.
3. Nested group transforms and group/ungroup commands, followed by connector attachment using stable object IDs and resolved sites. Validate cycles/depth/counts and preserve membership through duplication/history/reopen.
4. Tables, merged cells and rich cell text; then chart types/data/labels actually implemented in pinned DeckCraft. Each graph addition must travel through client/API validation and independent PPTX acceptance.

This sequence is a breakdown of the approved scope, not a reduction to the first subset. Every slice needs create/import/edit/duplicate/delete/reorder/undo/save/reopen, renderer/projection agreement and export acceptance before being marked complete.

## Decisions to settle in the next implementation plan

A new geometry representation needs an explicit schema version floor; existing v1/v2 documents must still load without rewriting the source merely on open. Existing basic-shape documents remain in their original schema. Matching Asset API/OpenAPI/contract changes must be implemented in its isolated worktree. General new-schema writes and cloud activation stay gated on separately authorized API rollout, so local explicit fixtures can verify the implementation without publishing incompatible cloud heads.

Adjustment clamps depend on width/height and shorter-side semantics, especially arrows and degenerate dimensions. Use exact pinned upstream formulas only where independent Office evidence agrees; retain tests for extreme aspect ratios, reflected/rotated geometry, and non-finite values. Imported shape text bounds cannot be guessed from the outer frame or silently flattened when an adjustment changes. Existing source-backed geometry reconciliation and pure-position preservation need dedicated new-preset cases.

## Current evidence limits

This is read-only discovery, not an implementation or readiness claim for new objects. Current compatibility acceptance is documented separately in `docs/testing/pptx-import-compatibility.md`. Platform, API rollout and physical-device gates remain open.

## First geometry-slice contract direction

Use schema v3 for extended preset kinds and numeric adjustment arrays, preserving legacy rectangle/ellipse documents in v1/v2. Keep normal blank creation and ordinary PPTX import/copy at their current v1 policy until the matching API contract rollout is separately authorized. Explicit v3 portable/source fixtures can exercise the complete editor/export/persistence path; the expanded gallery is available only in a v3 document during this gated stage. This is local implementation readiness, not general activation.

A pure geometry resolver returns inert SVG path strings, local text bounds, adjustment handles and connection sites for a strict supported preset allow-list; the document retains the preset and adjustments, not generated markup. Editor, thumbnail and projection consume the same result. SVG values are generated from validated numeric data and constant geometry code; arbitrary user SVG is not accepted. Default values, absent versus explicit adjustments and raw source metadata must be preserved through no-op and source editing.

The first supported subset is rectangle/ellipse plus roundRect, triangle, rtTriangle, diamond, rightArrow, leftArrow, upArrow and downArrow. Initial extended-preset import is limited to geometry without embedded shape text; a labeled non-rectangular shape needs an explicit attachment/text-bound model rather than two independent guessed frames. That remaining behavior belongs to the next object-text/group slice and must stay visibly unsupported until implemented. Shapes with unrepresented fill/effects/reflection/outline properties retain the compatibility boundary.

## First preset-geometry subset status (2026-10-13)

The gated schema-v3 client/API contract, pure TypeScript resolver, shared editor/thumbnail/projection rendering, preset gallery, pointer/keyboard/numeric adjustment edits and native/source PPTX round trips are implemented. Post-review-fix local verification passed 310 suites / 3914 tests, lint/typechecks, desktop/web builds, real browser and isolated macOS Electron geometry/download flows, 27 browser flows including geometry and independent Office verification of 64 pages / 192 shape contours. Exact limits and review status are in `docs/testing/pptx-preset-geometry-readiness.md`. Ordinary creation/import/copy remains v1; API rollout/general v3 activation, actual Microsoft/Windows device acceptance and all later object/master/playback slices remain open. This updates the discovery's historical gap description; it does not claim full Phase 2 parity.
