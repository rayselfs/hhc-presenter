# PPTX Export Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current session, followed by one fresh whole-branch reviewer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the current editable HHC presentation to usable PPTX without losing supported content, and preserve retained original source when exporting source-backed documents.

**Architecture:** Reuse the editable document, JSZip, bounded source validation and the session registry. Generate explicit DrawingML for native/v1 decks; patch a validated retained package for source-backed v2 decks, preserving unrelated package members and inheritance. Add one workspace download action and verify with HHC and an independent consumer.

**Tech Stack:** TypeScript, DOMParser/XMLSerializer, JSZip 3.10.1, existing PPTX renderer 1.2.4, Vitest, Playwright, bundled LibreOfficeDev and PDF inspection tools. No new production dependency.

**Spec:** `docs/superpowers/specs/2026-10-11-deckcraft-reference-typescript-design.md`, Phase 1. Conversion fidelity and source-contract batches are complete; this plan does not complete the full five-phase goal.

## Global Constraints

- Use DeckCraft v0.5.0 as a reference for presentation capabilities that HHC lacks.
- Implement the useful missing behavior in TypeScript inside the existing HHC application.
- Preserve the primary checkout and every unrelated worktree. No merge, release or deployment is authorized.
- Continue reading v1 files and legacy files without a version. Validate/migrate at the load boundary; never mutate a source file merely by opening it.
- Unknown XML is inert source data: it must not become unsanitized HTML/SVG or executable content.
- Enable the new schema only after the matching API validator is deployed under separate authorization.
- Ordinary import still writes v1. This exporter accepts existing v1/native graphs and explicit validated v2 source-backed graphs; it does not activate v2 writes or change the API contract.
- Export must work in Electron and browser, preserve projection ownership, source identity, account fences, history and save/reopen behavior.
- Preserve current files until a tested migration is designed; new format is not assumed. Keep `.lpdeck` save behavior.
- Reuse source limits: 209715200 bytes of portable input/output, 4000 ZIP entries, 32 MiB per expanded member, 256 MiB total expanded content, 192 MiB media, XML depth 128. Never download a partially generated or invalid package.
- Use the MIT option for any adapted DeckCraft source or tests. Add pinned paths, original copyright and full license text when adaptation first enters the repository.

## Review Focus

1. One source `p:sp` maps to separate editable text and geometry: moving, deleting or reordering either must export the intended result without duplicate XML IDs or modifying the other role. Task 3 owns regression tests.
2. Whitespace, empty paragraphs, explicit no-bullet and omitted inherited values must not gain defaults or wrapping changes. Tasks 1–3 own XML and independent-consumer tests.
3. Account/tab changes or active IME composition during asynchronous export must prevent a stale or private download. Task 4 owns deferred-promise and composition tests.
4. Copied/deleted slides, shared images and opaque relationships must not cause missing media, dangling internal targets or removal of unrelated source content. Tasks 2–3 own package graph tests.
5. Valid editor assets/colors/effects and extreme inputs must either export their intended appearance or return a precise compatibility error before download; never substitute black or flatten supported content silently. Tasks 1–2 own boundary and importer parity tests.

## Export Contract and File Map

Public entry point in `src/renderer/src/lib/pptx-export.ts`:

```ts
export async function exportPresentationPptx(document: EditablePresentationDocument): Promise<Blob>
```

The Blob MIME is existing `PPTX_MIME_TYPE`. Export snapshots and validates input before asynchronous work; it does not mutate the document, stored original package, catalog or history. Failed validation produces `PptxExportError`, carrying `diagnostics: PptxExportDiagnostic[]`; each diagnostic has `code: 'unsupported-content' | 'invalid-value' | 'source-conflict' | 'package-limit'`, `message: string`, and optional `slideId`/`elementId`. Preserve validation causes for debugging; display localized actionable messages without raw source XML.

- `pptx-export-drawingml.ts`: XML serialization of currently editable visual properties, namespaces and unit conversions. Use DOM construction/serialization; no user-controlled XML concatenation.
- `pptx-export-package.ts`: native OPC parts, media, notes, IDs, relationships and content types; bounded package checks shared with `pptx-source.ts` when useful.
- `pptx-export-source.ts`: retained-source reconciliation and patching, preserving role-owned properties and unrelated members.
- `pptx-export.ts`: validation, native/source branch, package validation and final Blob only.
- Existing `editable-presentation.ts` / `pptx-import.ts`: narrow conversion fixes only where focused export/reimport tests demonstrate loss of properties the editor already supports.
- Existing workspace header, its tests and three locales: single download action.
- New focused unit fixtures/tests, browser export E2E and task-owned independent-consumer evidence. Do not put exporter implementation in the large workspace page.

Supported output is the current visual graph: all ordered slides, backgrounds, rectangle/ellipse/line geometry, text/run/paragraph formatting, image crop/border/shadow, opacity/rotation, plain notes and assets. Native output uses a blank master/layout with no invented text defaults. Unsupported locked objects produce diagnostics. Advanced objects, editable masters/layouts, animations and media playback remain subsequent goal phases, rather than silently successful exports.

Use CSS pixels × 9525 for EMU; font size and character spacing in CSS pixels × 75 for DrawingML hundredths of a point; exact paragraph points × 100; paragraph multiples × 100000; normalized degrees × 60000; crop/alpha fractions × 100000. Preserve zero versus omitted values. CSS gradient angle is converted to DrawingML angle by subtracting 90 degrees, verified by rendered horizontal/vertical fixtures. Resolve supported CSS colors using the browser platform and reject unresolved/context-dependent colors.

PNG/JPEG/GIF/BMP media retain binary bytes. SVG/WebP are rasterized through inert browser image decoding into PNG when needed for consumer compatibility; preserve original document assets. Rasterization must reject failed decoding, external resources and dimensions above 8192 per axis or 16777216 total pixels before allocation. These are explicit export bounds; return a diagnostic rather than silently reducing quality. Do not inline executable SVG or fetch external relationships.

Text uses existing normalized paragraphs, explicit `buNone` for no list, per-run styles, paragraph margins/indent/alignment/spacing and empty-paragraph `endParaRPr`. Export list markers consistent with the currently rendered sequence, including start/level; internal sequence IDs are not Office identifiers. Cover fixed/content sizing and insets; do not introduce a shrink-to-fit mode. Map existing image effects explicitly; arbitrary source effects stay inert and preserved, or edited conflicts produce diagnostics.

## Tasks

### Task 1: DrawingML for Current Editable Properties

**Files:** Create `src/renderer/src/lib/pptx-export-drawingml.ts`; create `src/renderer/src/lib/__tests__/pptx-export-drawingml.test.ts`; modify `THIRD_PARTY_NOTICES.md` and add the upstream MIT license under `resources/licenses/deckcraft/` if adapting source/tests.

**Interfaces:** Consume `EditablePresentationDocument`, `EditablePresentationSlide`, `EditablePresentationElement`, existing paragraph/background normalization. Produce `writeSlideDrawingMl(document: EditablePresentationDocument, slideId: string, imageRelationshipIds: ReadonlyMap<string, string>): XMLDocument`. Keep IDs deterministic and unique per slide. The shared diagnostic types live in this module and are re-exported by `pptx-export.ts`.

- [ ] Write failing tests asserting EMU/font/spacing/angle/crop/alpha values; escaped Chinese and literal spaces; empty paragraphs; no invented bullets; lists, mixed runs, highlight/baseline/strike, insets, no visible zero-width outline, image effects and three gradient directions.
- [ ] Run `npx vitest run src/renderer/src/lib/__tests__/pptx-export-drawingml.test.ts`; confirm failures for missing writer rather than unrelated setup.
- [ ] Implement explicit visual serialization using existing normalization and DOM APIs; add attribution for any adapted pinned upstream implementation. Assert invalid CSS colors, locked objects and non-finite/unsupported values produce located diagnostics.
- [ ] Rerun focused tests and `npm run typecheck`; require all pass.
- [ ] Commit as `feat: serialize editable presentation DrawingML`.

### Task 2: Native PPTX Package and Reimport Parity

**Files:** Create `pptx-export-package.ts`, `pptx-export.ts` and `__tests__/pptx-export.test.ts` under `src/renderer/src/lib/`; modify `pptx-source.ts`, converter and their existing tests only for demonstrated shared validation/conversion needs; add focused fixtures under existing PPTX fixture directory.

**Interfaces:** Consume Task 1 writer. Produce `exportPresentationPptx(document): Promise<Blob>` for native/v1 input; package builder `buildNativePptx(document: EditablePresentationDocument): Promise<ArrayBuffer>`. If extracting package validation, expose `validatePptxPackage(buffer: ArrayBuffer): Promise<void>` from `pptx-source.ts` and reuse its current bounded inspector without allocating an unused base64 record.

- [ ] Write failing tests for 22-slide hymn v1 export, native rich-text/image/background fixture, slide reorder/insert/delete, shared media deduplication, notes, empty slides, asset decoding/raster bounds, package budgets and immutable input on success/failure.
- [ ] Run `npx vitest run src/renderer/src/lib/__tests__/pptx-export.test.ts`; confirm intended failures.
- [ ] Generate valid OPC presentation/master/layout/theme/slide/media/notes parts with unique IDs and relationships. No generated master bullets/default styles. Validate the finished archive before returning a PPTX Blob.
- [ ] Add reimport tests asserting text/geometry/crop/opacity/border/shadow/background and notes where represented. Fix the shared importer once for existing editor properties it currently drops (picture conversion currently omits border/shadow/opacity); do not redefine a loss as success. Source effects outside current model remain preserved/diagnosed.
- [ ] Run export, source-validation, conversion, portable and rich-text suites plus typecheck; require all pass.
- [ ] Commit as `feat: export native editable presentations to PPTX`.

### Task 3: Retained Source Reconciliation

**Files:** Create `src/renderer/src/lib/pptx-export-source.ts` and `__tests__/pptx-export-source.test.ts`; extend entry point and source fixtures.

**Interfaces:** Consume validated v2 source, existing parser/converter and Task 2 native builder. Produce `buildSourcePptx(document: EditablePresentationDocument): Promise<ArrayBuffer>`. Its result passes the same bounded package validation before download.

- [ ] Write failing tests: an unchanged source-backed hymn exports original bytes exactly; a text edit retains master/layout/theme/media bytes and does not invent bullets; independent text/geometry move/delete/reorder; copied slide; removed slide; shared media; unknown inert XML/relationships; contradictory source references and unrepresentable source edits.
- [ ] Run `npx vitest run src/renderer/src/lib/__tests__/pptx-export-source.test.ts`; confirm intended failures.
- [ ] Derive original editable baseline through the existing parser/converter. Compare render-relevant graph values, ignoring generated IDs/timestamps/names. Return exact original bytes when unchanged; otherwise clone and patch only affected parts.
- [ ] Preserve opaque XML and omission/inheritance in untouched properties. Coalesce compatible text/geometry roles sharing one source shape; split into unique shapes when their frames/order diverge. Remove only deleted mapped roles, retaining unmodeled nodes. Rebuild presentation ordering/internal relations for inserted/copied/deleted slides; keep unrelated source members unchanged.
- [ ] Return located source-conflict diagnostics when a requested edit cannot preserve meaningful opaque content or inheritance. Never strip unknown metadata to make a test pass. Verify document/source bytes are unchanged after both successful and failed exports.
- [ ] Run source/native/conversion/validation suites; require all pass and all internal relationship targets resolve.
- [ ] Commit as `feat: preserve PPTX source during editable export`.

### Task 4: Workspace Download and Session Fences

**Files:** Modify `src/renderer/src/components/Control/Header/PresentationWorkspaceHeader.tsx`, its existing `__tests__/PresentationWorkspaceHeader.test.tsx`, and `locales/en.json`, `zh-TW.json`, `zh-CN.json`.

**Interfaces:** Consume existing registry `finalizeAndFlush(itemId): Promise<EditablePresentationDocument | null>` and `exportPresentationPptx`. Use existing account visibility and workspace state; no new registry API, IPC or save service.

- [ ] Write failing tests for editable-only export, unsaved current text finalization, IME refusal, flush/export error, duplicate click, tab close/change and account switch while awaiting export; assert no download and no projection action in unsafe cases.
- [ ] Run `npx vitest run src/renderer/src/components/Control/Header/__tests__/PresentationWorkspaceHeader.test.tsx`; confirm intended failures.
- [ ] Add accessible localized export action. Capture document/owner, finalize and flush, export the snapshot, then recheck owner/tab/session visibility before download. Use the existing Blob/anchor download pattern with safe basename and object URL cleanup. Keep `.lpdeck` save and raw PPTX behavior.
- [ ] Rerun header, session and ownership tests plus lint/typecheck; require all pass.
- [ ] Commit as `feat: download PPTX from the editable workspace`.

### Task 5: Independent Consumer and Dual-Mode Acceptance

**Files:** Create `e2e/pptx-export.spec.ts`; reuse existing helpers/source fixtures. Record evidence in task-owned scratch and durable artifacts; update this plan and approved spec with verified results.

**Interfaces:** Browser/Electron exercise Task 4; independent consumer reads files actually downloaded by the app. No production API/deployment required.

- [ ] Add browser download E2E covering v1 hymn, explicit v2 source-backed edit, reopening, undo/redo and projection ownership. Run equivalent isolated Electron smoke with task-owned userData/download paths, leaving the user's profile/downloads untouched.
- [ ] Convert original and exported hymn plus focused visual fixtures with bundled LibreOfficeDev 26.8.0.0.alpha0 in isolated profiles. Use the same process-only Songti TC font substitution for both; record that original 標楷體 is unavailable. Assert 22 pages, exact expected Chinese text, no unexpected list markers, unchanged line count and compare line bounds with a maximum 2-point deviation for unchanged text. If baseline measurement invalidates this bound, stop and document the cause rather than relaxing it blindly.
- [ ] Verify focused consumers show intended crop, rotated geometry, gradients, borders and shadows; use rendered images and numerical geometry/text checks rather than HHC-only round trips. Source no-op exact bytes and untouched-member equality are additional acceptance, not substitutes for edited output checks.
- [ ] Run `npm run lint`, `npm run typecheck`, `npx vitest run`, `npm run build`, `npm run build:web`, focused browser E2E and isolated Electron smoke; require successful exits and retain logs.
- [ ] Request one fresh whole-branch review using the executing-plans native workflow; address findings with focused regression tests and rerun affected/full required checks. Record evidence, commit verification docs and preserve unmerged worktrees.

## Preflight and Remaining Scope

Read-only preflight confirmed the original hymn SHA-256 `ce1648cc6a449d7a29587b790877be1cf30efbef59de3984065dcdad948d6a0d`, 22 pages, and successful independent PDF conversion. Initial missing Chinese glyphs were corrected only in a task-local fontconfig environment using Songti TC. This is a usable relative comparison baseline, not exact original-font, Microsoft PowerPoint or physical Windows acceptance.

The pinned upstream `crates/pptx/src/write/mod.rs` matches SHA-256 `d7ba765f4b87d10e5f573becf56f7374e541041f768793805cc4de7ec1fc9ee1`. Its empty-master-style substitution is a known regression to avoid. Retained-source export is not a Rust rewrite.

No API deployment, general v2 activation, remote CI, merge, release, physical Windows/PowerPoint acceptance or large-deck performance claim belongs to this batch. Advanced objects, masters/layout editing and playback remain subsequent phases. Phase 1 still requires its broader import compatibility/diagnostic acceptance after this slice.

## Self-Review / Handoff

Checked against the approved spec: this slice covers explicit export, retained source, current property fidelity, persistence-safe UI and independent/dual-mode validation. Later phase requirements and production activation remain explicitly open. Five review-focus cases each have an owning task and tests; public interfaces match between tasks. No product implementation has started for this plan.

Execution method remains the user's approved current-session sequential implementation. Await review of this new plan before product code, as required by writing-plans.
