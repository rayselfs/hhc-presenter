# PPTX conversion fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution is recommended; user plan review and method selection remain pending.

**Goal:** Correct demonstrable losses in already-supported PPTX objects without changing portable schema v1.

**Architecture:** Extend the existing converter and parser-backed synthetic fixtures. Reuse current editor, thumbnail, projection and persistence paths; change consumers only when regression evidence shows a representation disagreement.

**Tech Stack:** TypeScript, React, Vitest, JSZip, installed `@aiden0z/pptx-renderer`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-11-deckcraft-reference-typescript-design.md`

## Global Constraints

- Use `/Users/rayselfs/.codex/worktrees/deckcraft-reference-ts/hhc-client-v2`, branch `feat/deckcraft-reference-ts`; preserve the primary checkout and every unrelated worktree.
- Verify latest `origin/main` before product edits; integrate an advanced baseline without discarding documentation commits or user changes.
- Every feature must work in both Electron and browser; explicit show actions own projection.
- Preserve schema v1, old files, source blob identity, revision/account fences and unsupported-content rejection in this batch.
- No new dependency, Rust runtime, merge, release or deployment. If adapting upstream code, add pinned source attribution and MIT notice in the same task.
- The full goal still includes source preservation/export, objects, masters/layouts, playback and platform verification. Separate plans will cover those subsystems. Asset API companion changes are approved in scope and require their own isolated worktree when new schema work starts.

## Review Focus

- Explicit no-fill outlines must remain invisible even when line XML exists: Task 1.
- Embedded BMP content must pass signature validation; unknown extensions must not be mislabeled PNG: Task 2.
- Explicit false/normal local styles must override inherited values: Task 3.
- Leading/trailing whitespace and empty paragraphs must survive editing and persistence: Task 3.
- Failed import must leave no partial catalog entry; hymn text and 22-page count must remain intact: Task 4.

---

### Task 1: Preserve supported outline widths

**Files:** Modify `src/renderer/src/lib/editable-presentation.ts`; test `src/renderer/src/lib/__tests__/editable-presentation-pptx.test.ts` and `src/renderer/src/lib/__tests__/editable-presentation.test.ts`.

**Interfaces:** Consume `ShapeNodeData.line` and `convertPresentationData(source, presentation): EditablePresentationDocument`; preserve the existing shape/line `strokeWidth: number` contract.

- [ ] Extend the parser-backed fixture builder with optional shape XML. Add `preserves explicit outline width` for rectangle and line `a:ln w="38100"`: converted `strokeWidth` equals 4 canvas pixels; thumbnail contains `stroke-width="4"`. Add explicit `a:noFill` and missing-line cases asserting no visible rectangle outline. Do not introduce snapshot-only tests.
- [ ] Run `npx vitest run src/renderer/src/lib/__tests__/editable-presentation-pptx.test.ts`; record the assertion failure caused by fixed width before implementation.
- [ ] In `convertShapeNode`, resolve explicit line width in existing canvas units and explicit no-fill. Confirm parser default/theme-line behavior before choosing an omitted-width fallback; add a fixture for that choice. Keep shape and line behavior consistent and reject invalid non-finite/negative width at the load boundary.
- [ ] Run both listed test files; verify the outline renders consistently in `EditableSlideSurface` and generated thumbnails. Add a consumer regression only if either path differs.
- [ ] Commit as `fix: preserve imported presentation outline widths`.

### Task 2: Preserve embedded picture MIME identity

**Files:** Modify `src/renderer/src/lib/editable-presentation.ts`; test `src/renderer/src/lib/__tests__/editable-presentation-pptx.test.ts`, `src/renderer/src/lib/__tests__/portable-presentation.test.ts` and `src/renderer/src/lib/__tests__/pptx-import.test.ts`.

**Interfaces:** Keep private `getMimeTypeFromPath(path: string): string` and existing asset `{ mimeType, dataUrl }`; consume `validatePortablePresentation` without relaxing image signatures.

- [ ] Add a parser-backed valid embedded BMP fixture: assert asset `mimeType` is `image/bmp`, data URL starts `data:image/bmp;base64,`, decoded bytes match source and portable validation accepts the document. Add mismatched signature and unknown-extension import cases asserting explicit failure and no catalog item.
- [ ] Run the three listed test files; record the current BMP MIME/validation failure.
- [ ] Correct the existing extension mapping for supported formats and make unknown extension behavior explicit. Reuse portable signature validation; do not add SVG/TIFF support or decode bytes using a new library in this task.
- [ ] Run the tests; assert JSON save/reload retains asset MIME and exact bytes using existing persistence helpers.
- [ ] Commit as `fix: retain BMP identity during PPTX import`.

### Task 3: Preserve supported inherited run styles and intentional text

**Files:** Modify `src/renderer/src/lib/editable-presentation.ts`; extend `src/renderer/src/lib/__tests__/editable-presentation-pptx.test.ts` and `src/renderer/src/lib/__tests__/editable-presentation-persistence.test.ts`. Inspect `src/renderer/src/lib/presentation-rich-text.ts` and `src/renderer/src/components/Common/EditableSlideSurface.tsx`; modify only if the fixture exposes a consumer loss.

**Interfaces:** Keep `EditableTextRun`, `EditableTextParagraph` and `EditableTextElement` fields unchanged. Use the existing `resolveTextStyle` precedence for inherited supported attributes; `normalizeTextParagraphs(element)` remains the shared editor normalization boundary.

- [ ] Add inherited strike/superscript/character-spacing/highlight fixtures with local explicit no-strike/normal/zero overrides. Assert the supported values on paragraph runs and the explicit overrides, using DrawingML source units confirmed against pinned source/documentation. Add text `  title  ` followed by an empty paragraph and `tail `; assert consistent aggregate text/run/paragraph content and save/reopen preservation.
- [ ] Run `npx vitest run src/renderer/src/lib/__tests__/editable-presentation-pptx.test.ts src/renderer/src/lib/__tests__/editable-presentation-persistence.test.ts`; record actual failures. If a candidate already passes, retain the useful regression and skip the corresponding code change.
- [ ] Resolve supported inherited extended styles using existing precedence, respecting property omission. Preserve intentional whitespace and paragraph boundaries across converter representations; avoid changing user typing normalization globally unless the fixture proves it necessary.
- [ ] Run the listed tests plus `presentation-rich-text.test.ts` and `EditableSlideSurface.test.tsx`; verify existing font scaling and explicit `buNone` tests still pass.
- [ ] Commit as `fix: preserve imported rich text inheritance and whitespace`.

### Task 4: Verify the complete first batch

**Files:** Reuse `src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx`, existing import/persistence tests and `e2e/presentation-rendering-fidelity.spec.ts`, `e2e/presentation-text-editing.spec.ts`, `e2e/presentation-page-navigation.spec.ts`. Extend existing E2E fixtures only where these cases are uncovered.

**Interfaces:** Preserve existing projection/session and portable document contracts. This task consumes the fixes from Tasks 1–3 and produces recorded acceptance evidence.

- [ ] Assert the hymn import has 22 slides and exact original text; save/reopen retains those values and supported edits. Exercise rejected imports and existing draft/account guards. Add assertions only for uncovered behavior.
- [ ] Run `npm run lint`, `npm run typecheck`, `npx vitest run`, `npm run build` and `npm run build:web`; record actual outcomes separately.
- [ ] Run `npm run test:e2e:browser -- e2e/presentation-rendering-fidelity.spec.ts e2e/presentation-text-editing.spec.ts e2e/presentation-page-navigation.spec.ts`. Compare visible text, outline and crop on editor/thumbnail/projection using the imported corpus and targeted fixtures.
- [ ] Run available Electron runtime smoke for import/edit/save/reopen/projection. Report missing runtime/device prerequisites explicitly; browser tests do not prove packaged or physical Windows acceptance.
- [ ] Review the complete diff and record unresolved evidence. No PR/CI, release or device acceptance claim without that actual run. Commit any added regression coverage and report batch completion separately from the full goal.

## Subsequent plans

Next: bounded portable source preservation and schema/API contract evolution, including exact size/depth limits and migration tests; then PPTX export supported-subset fidelity. Objects, masters/layouts and playback retain the order and acceptance conditions in the approved spec. A new schema must not be enabled for cloud writes before matching API deployment is independently authorized and verified.
