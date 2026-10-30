# PPTX Import Compatibility Boundary Implementation Plan

> Historical PR #96 design/evidence, retained from source `4eaa86b4`. Test counts and release gates below describe that earlier branch, not the integrated main. See [the integration record](/docs/reports/2026-10-30-pr96-integration.md) for current scope, validation and remaining acceptance.

**Goal:** Make ordinary editable imports and the raw/provider “create editable copy” path share the same bounded compatibility checks and actionable failures, before any catalog/blob/draft creation. Continue Phase 1 after the verified export foundation.

**Authorization:** The five-phase design and current-session sequential implementation are approved; the user instructed continuous work without repeated review confirmations. Use the existing isolated client worktree. Keep the clean unmerged Asset API worktree; no API/schema deployment, merge or release belongs to this slice.

**Architecture:** Extract existing unsupported-feature checks into a shared import boundary, reuse the bounded package inspector and installed parser, and return typed compatibility diagnostics with slide/object/source-part location. Reuse existing upload failure and editable-copy toasts; do not add a new import dashboard, persistence model, IPC API or dependency. Keep the ordinary schema-v1 policy, safe account fences, source immutability and projection ownership.

## Investigation evidence and scope

- `pptx-import.ts` guards timing, transitions, embedded media and meaningful slide color-map overrides before catalog creation, then rejects converted locked objects.
- `convertPptxToEditablePresentation` in `editable-presentation.ts` skips that guard and can publish an editable item/draft after dropping animations/transitions/media or reducing advanced objects to labels. It is called by the raw/provider workspace's existing editable-copy action.
- Conversion failures for geometry/fills/decorations/text layout/image effects are plain errors without consistent slide/object locations. The upload failure and copy toast currently display raw error messages.
- Ordinary import currently uses the installed parser's recommended ZIP bounds; the stricter original-package inspector runs only if notes exist. Reuse the existing inspector explicitly at both editable conversion boundaries, including macro/encrypted/malformed/limit rejection, rather than writing another ZIP validator.
- The current locked element stores only a label/frame; it does not preserve an advanced object's source data or preview. Reject known unrepresentable conversion at both entry points until each later object/playback capability is implemented.
- Export review also identified a useful next probe: source `a:br` / soft-line breaks need independent consumer acceptance. Investigate with a focused fixture; change behavior only if a concrete loss is reproduced. Do not treat HHC-only round trips as proof.

## Files and interfaces

- New small `pptx-compatibility.ts`: typed compatibility diagnostics/error and the extracted feature inspection using the existing parser's `PptxFiles` / `PresentationData`.
- `pptx-import.ts` and `editable-presentation.ts`: shared validation before writes; preserve owner fences, names, original sources and read-only-provider draft behavior for supported files. Extend converter errors only where a fixture demonstrates a useful located diagnostic; avoid parsing error-message strings.
- `upload-utils.ts`, existing editable-copy toast and locales: render localized reason plus available slide/object ordinal from typed diagnostics. Keep existing progress/cancel/retry and raw viewer workflows; do not expose raw retained XML or private source-node names.
- Existing import/conversion/copy/upload tests and focused E2Es: verify both success and failure paths, no partial persistence and actionable presentation of failures.

## Task 1: Shared compatibility gate and failure atomicity

- [x] Write RED fixtures/tests for animation, transition, media, meaningful color-map override and unsupported converted objects through both ordinary import and create-editable-copy, including read-only provider drafts. Assert no new catalog/blob/draft on failure and original source bytes/records unchanged.
- [x] Extract the existing guard and share it at both entry points; reuse bounded package validation before parsing. Keep parser recommendation bounds and cancellation/account checks.
- [x] Cover malformed/macro/encrypted/oversized packages at the same boundary; use existing bounded fixtures/helpers, not resource-heavy fixtures or another parser.
- [x] Run affected import/conversion/persistence suites and typechecks; commit the focused safety fix.

## Task 2: Located, localized compatibility diagnostics

- [x] Write RED tests for structured feature reasons and slide/object/source-part location, unsupported text/image/shape/background conversion, and local/provider UI failures without raw XML/private labels.
- [x] Give feature inspection and converter failures typed diagnostic codes; attach location where traversal already knows the current slide/node. Keep valid values and inheritance unchanged. Retain causes for debugging without showing their raw text to the user.
- [x] Reuse upload failure/retry and copy toast surfaces with three locales. Supported copy/import keeps the existing source-provider permissions and destination behavior.
- [x] Run diagnostic, upload, copy and account-fence tests plus lint/typecheck; commit.

## Task 3: Compatibility fixture and independent-consumer matrix

- [x] Record supported, unsupported-until-later and malformed input cases with committed fixture/test pointers. Include inheritance, lists, empty/whitespace text, fonts, autofit, shape/image/background properties and notes; distinguish source-preserved no-op from editable support.
- [x] Probe soft line breaks through actual export and an independent consumer. If loss is reproduced, fix the common import/export representation narrowly with meaningful regression tests; otherwise record the passing evidence. Do not silently strip original run metadata or invent defaults.
- [x] Verify representative supported files import/edit/export/reopen and failure cases leave no duplicate or partial item. Keep schema v1 and cloud activation gates explicit.

## Task 4: Whole-slice acceptance and review

- [x] Run repository lint, both typechecks, full Vitest, desktop/web builds, affected browser E2Es and an isolated built Electron import/copy/export flow. Keep task-owned profiles/downloads and remove only owned temporary data after archiving evidence.
- [x] Request one fresh read-only whole-slice reviewer under the approved execution workflow; fix actionable findings and rerun justified checks.
- [x] Update the design/inventory/readiness and plan with exact results, archive task-owned execution evidence, commit and retain unmerged worktrees. Continue Phase 2 discovery after Phase 1's compatibility boundary is verified.

## Completion and limits

Both editable conversion entry points reject the covered known unrepresentable content before persistence and identify a useful reason/location. Supported imports/copies, history/save/reopen and source-provider permissions work in Electron/browser. Raw PPTX viewing remains available. This slice does not implement advanced shapes/groups/tables/charts, masters/layouts or playback; those are subsequent approved phases. It does not enable v2 writes, change the portable/API schema, claim remote CI or authorize deployment/merge/release/physical Windows acceptance.

## Completion Evidence

Completed locally on 2026-10-12. Product `1cc755ca`; acceptance tests `2ac689ae`. One fresh whole-branch reviewer found four Important issues, all fixed in one RED/GREEN pass (20 reproducing tests, three positive controls, 144 affected tests). Final full suite 309/3773 passed (257.66s, one worker, unchanged timeouts), lint/typechecks and desktop/web builds passed, all 25 affected browser cases passed (27.7s), isolated built Electron passed (10.8s). Fresh independent Office evidence covers eight actual exporter cases and .01pt maximum expected horizontal deviation. Runtime-load failures and corrected XML fixture doubles are retained in the ledger/evidence.

See `docs/testing/pptx-import-compatibility.md` for coverage and explicit limits. Durable evidence: `/Users/rayselfs/.codex/visualizations/2026/10/11/01a12b4f-88d0-7980-82da-40c2abb5b65f/deckcraft-pptx-import-acceptance-20261012/`. Both unmerged worktrees are retained, no activation/deployment/release is implied. Phase 2 discovery and preset-geometry plan are saved; continue inline without a new confirmation. The full goal remains active.
