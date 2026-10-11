# DeckCraft reference capabilities in HHC Presenter

Status: proposed design, awaiting user review. No product implementation authorized by this document alone.

## Intent and scope

Use DeckCraft v0.5.0 as a reference for presentation capabilities that HHC lacks. Implement the useful missing behavior in TypeScript inside the existing HHC application. The user requested all five previously discussed capability areas in sequence, not a single selected area: PPTX fidelity and persistence; editable objects; masters and layouts; transitions, animations and embedded media; complete platform and projection verification.

The dedicated workspace is `/Users/rayselfs/.codex/worktrees/deckcraft-reference-ts/hhc-client-v2`, branch `feat/deckcraft-reference-ts`, based on `origin/main` `0980ab5350f41acc6e820469f1f816957efc4fd0`. Preserve the primary checkout and every unrelated worktree. No merge, release or deployment is authorized.

The reference inventory records upstream implemented and partially implemented features in relevant areas. It is a discovery checklist, not a claim that all entries are missing in HHC or production ready upstream. Existing HHC capabilities must be identified and reused before choosing work. The inventory now distinguishes existing, partial, gap, policy-conflict and unassessed entries with local source paths. These are static code assessments, not end-to-end acceptance results; upstream D/P labels remain upstream claims. A gap describes editable HHC support, not the raw PPTX viewer. Each missing capability needs its own acceptance evidence; passing one phase does not complete the whole goal.

## Reference evidence

- Pinned source: https://github.com/storytold/deckcraft/tree/v0.5.0
- Architecture: https://github.com/storytold/deckcraft/blob/v0.5.0/docs/architecture.md
- Model: https://github.com/storytold/deckcraft/blob/v0.5.0/crates/model/src/lib.rs
- PPTX: https://github.com/storytold/deckcraft/tree/v0.5.0/crates/pptx/src
- Geometry: https://github.com/storytold/deckcraft/tree/v0.5.0/crates/geom/src
- Animation: https://github.com/storytold/deckcraft/tree/v0.5.0/crates/anim/src
- Capability inventory: https://github.com/storytold/deckcraft/blob/v0.5.0/docs/parity-checklist.md
- License: https://github.com/storytold/deckcraft/blob/v0.5.0/LICENSE-MIT

The official WASM release passed a standalone import/edit/show probe using the 22-slide hymn fixture. Unedited PPTX export and re-import introduced bullets and wrapping changes. Inspection found empty imported master styles replaced with generated defaults in `crates/pptx/src/write/mod.rs:master_xml`. This is a regression to prevent, not a behavior to reproduce. Direct Chinese text entry and browser composition commit reached the document, but real input-method candidate interaction remains unverified. Standalone WASM evidence does not establish HHC integration or packaged-device acceptance.

## Current HHC evidence

| Area             | Current implementation                                                         | Gap or dependency                                                                                |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| PPTX parsing     | `@aiden0z/pptx-renderer` 1.2.4, bounded ZIP parsing, master/layout/theme reads | Installed parser already has table, chart and group node types; assess conversion coverage first |
| Editable import  | `pptx-import.ts` and `convertPresentationData`                                 | Rejects unsupported objects, shape geometry/fills, animation, transition and embedded media      |
| Portable model   | `EditablePresentationDocument`, schema v1                                      | Element union is text/image/shape/line/locked; shapes are rectangle/ellipse                      |
| Text             | Rich runs/paragraphs, formatting and list controls                             | Audit inheritance, autofit and wrapping before porting text algorithms                           |
| Arrange          | Alignment, distribution, snapping, multi-selection, undo/redo already exist    | Add missing group/connector behavior; preserve existing commands                                 |
| Rendering        | `EditableSlideSurface`, thumbnails, projection surface                         | Every new object must render consistently in all three surfaces                                  |
| Persistence      | Save coordinator, drafts, immutable blob revisions, account fences             | New source parts and graph types must survive saves, reopen, history and sync                    |
| Cloud validation | `portable-presentation.ts`, Asset API `ValidatePersonalDeck`                   | API accepts schema v1 and five element kinds only; new model needs coordinated contract work     |
| Projection       | Presenter page state separate from editor workspace selection                  | Explicit show actions own projection; stale generations must not move the active show            |
| Native format    | `.lpdeck` JSON and HHC MIME type                                               | Preserve current files until a tested migration is designed; new format is not assumed           |

## Recommended architecture

Extend the existing serializable TypeScript document model and domain functions. Reuse Zustand stores, React surfaces, browser layout/SVG, existing ZIP parser and installed geometry facilities where available. Keep Electron-specific I/O and playback behind current adapters. Reference DeckCraft algorithms where HHC lacks equivalent behavior; do not copy its egui front end, application shell, media codecs or Rust workspace structure.

A feature is an end-to-end slice: parser/converter, validated document data, editor commands and undo, editor/thumbnail/projection rendering, persistence and reopening, plus sync acceptance where the portable graph changes. A UI button without these paths is not complete.

Use versioned schema evolution for new object kinds and graph references. Continue reading v1 files and legacy files without a version. Validate/migrate at the load boundary; never mutate a source file merely by opening it. Preserve original property omission versus explicit defaults so theme and master inheritance stay intact. Unknown XML is inert source data: it must not become unsanitized HTML/SVG or executable content.

For imported decks, use a versioned optional `pptxSource` record containing the original package as canonical base64, its SHA-256 identity, and source-node references for edited objects. Keep it inside the portable document so saving/syncing the document cannot lose its source dependency. Validate the package and expanded graph on the client and API; bound encoded size, archive entries, expanded bytes and XML depth using existing upload and ZIP limits. Base64 adds about one third to source size and may lower the maximum accepted original deck size; account for that before persistence/upload and report it explicitly. This is the initial preservation representation, not an external local-only sidecar. Enable the new schema only after the matching API validator is deployed under separate authorization. External relationships, macros, encrypted packages, malformed XML and expansion limits retain explicit safe behavior.

Use the current save coordinator for revisions, drafts and account fences. Preserve source blob identity, read-only provider permissions and import failure cleanup. Keep the current history operations until measured document size warrants a change.

Projection owns its playback cursor, animation step and content generation. Editor selection is independent. A timeline uses a monotonic playhead with deterministic seek/replay behavior; it is not a collection of component-local timers. New media uses the existing native/browser/VLC paths, not new software codecs.

## Delivery order and completion conditions

### Phase 1: PPTX fidelity, preservation and export foundations

Inventory supported input with actionable compatibility diagnostics. Cover text/run/paragraph formatting, placeholder frames, slide/layout/master/theme precedence, color transforms, image crop and shape properties. Retain source content needed for future loss-preserving export. Produce an explicit supported export contract and validate the resulting package with another consumer as well as HHC; self-generated round-trip tests alone are insufficient.

First slice: build compatibility fixtures and tests; correct demonstrable conversion losses in currently supported text/image/rectangle/ellipse/line content; design source preservation and schema/API evolution. Existing unsupported-content rejection stays until each corresponding capability is implemented, not as a permanent endpoint of this goal.

Acceptance: the hymn deck retains 22 pages and text; no invented bullets, lost explicit `buNone`, inherited-font changes, unexpected wrapping, lost crop or missing assets; save/reopen and undo/redo retain intended edits; invalid imports leave no catalog entries. Compare geometry and text metrics with reference renders. The hymn fixture does not cover advanced objects, so add focused fixtures for each later capability.

### Phase 2: editable objects

Implement missing preset/custom shapes, shape fills/outlines/effects, group coordinate transforms, grouping/ungrouping, attached connectors, tables and supported chart types. Read DeckCraft's implemented subset for chart semantics before setting the chart acceptance matrix. Preserve nested group transforms rather than flattening away editable grouping.

Acceptance: create/import/edit/duplicate/delete/reorder/undo/save/reopen each object; transformed bounds and hit tests agree with editor and projection; table merge/span and rich cell text survive edits; connector attachment follows moved shapes; chart source data and rendered labels remain consistent. Validate graph cycles, depth, counts and asset references on both client and server.

### Phase 3: masters, layouts and themes

Add editable masters and layouts, placeholders, create slide by layout, reset/apply layout, and theme inheritance. Preserve explicit local overrides and missing values. Reuse current theme controls and text resolution.

Acceptance: change a master once and dependent slides update; overridden properties stay overridden; reset layout preserves intended content; all references are valid after deletion, duplication, save/reopen and import/export. Editor, thumbnail and projection use the same effective property resolution.

### Phase 4: playback

Add supported transitions and entrance/emphasis/exit/motion-path effects, click/with/after timing and paragraph builds, followed by embedded audio/video behavior. Enumerate supported effects from pinned DeckCraft code; every unsupported imported effect remains preserved with an explicit compatibility result rather than silently disappearing.

Acceptance: deterministic start/advance/back/replay/end and seek; no stale event affects a new show; editor navigation cannot advance projection; animation steps advance before a slide where appropriate; interrupted transitions clean up; media seek/pause/volume/end and unsupported-codec fallback retain current behavior. Coordinate clocks and audio policy across the Electron and browser adapters.

### Phase 5: complete verification

Run lint, both typechecks, full Vitest, desktop and web builds, focused browser E2E and packaged runtime checks appropriate to changed paths. Verify Chinese input, keyboard focus, accessibility, offline reopen, personal sync, read-only cloud providers, external projection and long sessions. Measure large-deck open/render/save time and memory; retain the measured baseline and compare changes.

Physical Windows projector/audio/input-method acceptance is separate from local tests and CI. Until authoritative device evidence exists, record it as pending and keep the full goal unfinished. CI status requires an actual workflow run; local checks do not imply CI, release or deployment.

## Source attribution and licensing

Use the MIT option for any adapted DeckCraft source or tests. Add a third-party notice with the pinned version, original file paths, original copyright and license text when adapted code first enters the repository. Identify adapted algorithms in the affected source and tests. Do not import ArtCraft branding or assume bundled font/media licenses transfer with the code. Existing renderer and other dependencies retain their own licenses.

## Changes that must travel together

- Model and validator: `editable-presentation.ts`, `portable-presentation.ts`, source-load migration and matching Asset API contract tests.
- Import and export: `pptx-import.ts`, converter, source/asset identity, ZIP package writer and compatibility fixtures.
- Commands: `presentation-editor-commands.ts`, rich-text functions, workspace actions, clipboard and history.
- UI and rendering: workspace/ribbon, `EditableSlideSurface`, thumbnail renderer and projection surface.
- Runtime: shared projection payloads, adapters, session coordinator and existing media lifecycle.
- Persistence: creation, drafts, save coordinator, revision writer, sync and account fences.
- Verification: unit, rendering, import/persistence, projection navigation, browser and packaged tests; schema tests also cover prior file versions.

## Decision needed before implementation planning

Approve this client architecture, the versioned inline source-preservation representation, and the first slice. Separately confirm whether necessary `website/asset-api` validation, OpenAPI and contract-test changes belong to this goal or another task. Backend files have been inspected read-only; no backend change or deployment is authorized yet. Once scope is confirmed, write a concrete first-slice implementation plan with exact fixtures, failing tests, files and delivery gates.
