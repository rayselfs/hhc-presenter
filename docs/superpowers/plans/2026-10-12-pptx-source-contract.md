# Bounded PPTX source contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox syntax. Native execution in the current session was selected by the user and persists. This next-batch plan awaits review; no product implementation has started.

**Goal:** Implement a portable schema-v2 source-preservation foundation that both client and Asset API validate, while retaining legacy/v1 reads and ordinary v1 import writes until deployment acceptance.

**Architecture:** Add an optional immutable original-package record and optional slide/object source references to the existing model. Validate structure synchronously and package bytes asynchronously at load/import trust boundaries; preserve existing revision, draft and owner fences. The API performs equivalent package validation before accepting a cloud head. This batch supports loading, editing and saving v2 locally; it does not enable production v2 cloud writes or implement PPTX export.

**Tech Stack:** Existing TypeScript/JSZip/renderer/Web Crypto, Go archive/zip/encoding/xml/crypto/sha256, Vitest and existing Playwright/Electron smoke. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-deckcraft-reference-typescript-design.md`

## Global Constraints

- Client: `/Users/rayselfs/.codex/worktrees/deckcraft-reference-ts/hhc-client-v2`, branch `feat/deckcraft-reference-ts`, initial base `0980ab5350f41acc6e820469f1f816957efc4fd0`. Preserve its completed conversion commits.
- Asset API: `/private/tmp/hhc-deckcraft-asset-api-20261012`, branch `feat/deckcraft-source-validation`, base `ce418dfafaa7d63b8d8a6962ceba1fb005813733`. Re-fetch both remotes before product edits and resolve baseline advancement without discarding work.
- Preserve all other checkouts/worktrees. No merge, release, deployment or production mutation in this batch.
- Native `.lpdeck` files and HHC MIME remain. Legacy/no-version files normalize to v1; v1 remains readable. Never rewrite a file merely by opening it.
- General user imports remain v1 in this batch. An explicit converter input exercises v2 in tests and future activation; no settings switch, capability endpoint or silently dropped source. API deployment and client activation require a subsequent authorized rollout with evidence.
- Existing unsupported-feature rejection, immutable source blob identity, account/revision fences, import cleanup and projection ownership remain.
- Reuse current dependencies and standard libraries. If upstream code is adapted, add pinned DeckCraft v0.5.0 attribution and MIT notice in that task; reference-only standards behavior does not require copying code.

## Contract decisions

- `EditablePresentationDocument.schemaVersion?: 1 | 2`.
- Optional `pptxSource: { version: 1; base64: string; sha256: string }` contains the exact original ZIP, canonical RFC4648 base64 and lowercase 64-hex SHA-256. Version 2 may omit it for a native-created deck. v1/legacy must not contain source records or references.
- Optional slide `pptxSourcePart: string` names an existing `ppt/slides/*.xml` package part. Optional element `pptxSourceNode: { id: string; role: 'geometry' | 'text' | 'image' }` resolves the original `p:cNvPr/@id` in that slide. `geometry`/`text` require a `p:sp`, `image` a `p:pic`. A shape and its separate text element may share the node ID with different roles; duplicate `(part, node, role)` claims are invalid. References require a source package and the slide's part; inserted objects need no reference.
- Copy/duplicate creates new objects: clear the copied slide part and copied node references. Move/reorder/edit retains original references; delete removes only the edited graph entry. Undo restores the previous graph and references. Preserve the immutable package in document copies and drafts. No source-node reference is an authorization identity.
- Whole serialized UTF-8 `.lpdeck`: maximum **209715200 bytes (200 MiB)**, including original source, duplicated image assets and metadata. Use existing `PERSONAL_MAX_FILE_BYTES` / `PersonalMaxFileSize`; reject before persistence/catalog creation or upload. Do not drop original source to fit. Exact bytes decide acceptance; do not use character count.
- ZIP: at most **4000 entries**, **33554432 bytes per expanded entry**, **268435456 total expanded bytes**, **201326592 media bytes** under `ppt/media/`, client decompression concurrency **8** (existing renderer recommended limits). Original compressed ZIP is also bounded by 200 MiB before decoding; the whole-document limit is usually tighter after base64 overhead.
- XML: maximum element depth **128**; reject malformed XML, DTD/entity declarations, encrypted ZIP entries, ZIP64 packages and macro-enabled/VBA parts. Verify declared and actual expanded sizes/CRC; count all entries before decompression, including unsupported parts. Reject duplicate names and unsafe absolute/backslash/dot-segment paths instead of normalizing aliases. Require valid OPC content types, relationships and a presentation root; MIME/extension alone is insufficient.
- External relationships remain inert preserved data: never fetch them during validation or rendering. Do not rewrite retained XML into HTML/SVG or execute it. Retained source does not expand supported editable import features.
- Client/API validators must agree on these limits and reference rules. Shared small fixtures pin behavior; synthetic limit tests avoid allocating hundreds of megabytes just to exercise a boundary.

## Review Focus

- Forged hash, noncanonical base64 and archive aliases must fail before catalog/cloud-head mutation: Tasks 1–2.
- ZIP bombs, deep XML, DTD, encrypted/macros and cancellation must fail within bounded work: Tasks 1–2.
- Copy/delete/undo and save/reopen must not redirect an edited element to another original node: Task 3.
- Legacy/v1 files and cloud revision/account guards must retain behavior: Tasks 2–4.
- Source overhead may exceed 200 MiB even when the original fits; errors must preserve the old document and avoid partial items: Tasks 3–4.

---

### Task 1: Client source model and bounded validation

**Files:** Modify `src/renderer/src/lib/editable-presentation.ts` and `portable-presentation.ts`; create `src/renderer/src/lib/pptx-source.ts` and `src/renderer/src/lib/__tests__/pptx-source.test.ts`; extend `portable-presentation.test.ts`. Add small valid/invalid source contract fixtures under `src/renderer/src/lib/__fixtures__/pptx-source/`.

**Interfaces:** Export `PptxSource`, `PptxSourceNode` from the document model. Export `createPptxSource(buffer: ArrayBuffer): Promise<PptxSource>` and `validatePptxSource(document: EditablePresentationDocument): Promise<void>` from `pptx-source.ts`. Keep `validatePortablePresentation(document): void` synchronous for graph/style validation and source-record/reference shapes. Use existing ZIP dependencies and Web Crypto; validate archive metadata before expansion and XML before renderer parsing.

- [ ] Write tests `retains exact source bytes and digest`, `rejects source fields on v1`, `accepts v2 without source`, `rejects forged/canonicalization failures`, `rejects unsafe or duplicate ZIP names`, `enforces ZIP and XML limits`, `rejects macros/encryption/DTD`, `does not fetch external relationships`, and `rejects missing or mismatched source node roles`. Assert no fetch calls, byte identity and explicit failures. Include geometry/text sharing one node, duplicate same-role claims, malformed OPC roots, CRC/size mismatch and truncated archives.
- [ ] Run `npx vitest run src/renderer/src/lib/__tests__/pptx-source.test.ts src/renderer/src/lib/__tests__/portable-presentation.test.ts --maxWorkers=2 --testTimeout=15000`; observe missing v2 acceptance/source helpers and security assertions fail before implementation.
- [ ] Implement the defined fields and guards. Reject before expensive decode/expansion using encoded length and ZIP directory metadata, then verify actual bytes and XML/reference integrity. Source bytes are never modified. Keep graph and package responsibilities separate; do not convert the entire existing validator to async.
- [ ] Run the two files to GREEN; tests for existing v1 image signatures and graph limits must still pass. Commit `feat: validate bounded portable PPTX sources`.

### Task 2: Asset API source acceptance and canonical contract

**Files:** In the API worktree, modify `internal/assets/personal_deck.go`, `personal_deck_test.go`, `docs/openapi.yaml`, `docs/openapi_test.go`; create `internal/assets/personal_deck_source.go` and `personal_deck_source_test.go`. Add matching small fixture vectors under `internal/assets/testdata/pptx-source/`. Extend `internal/assets/personal_upload_test.go` and `internal/httpapi/personal_sync_test.go` only for missing complete/head-mutation coverage.

**Interfaces:** Preserve `ValidatePersonalDeck(ctx context.Context, reader io.Reader) error` and `ErrInvalidUpload`. Add private structs `personalDeckSource` and `personalDeckSourceSlide` matching Task 1's JSON fields and `validatePersonalDeckSource(ctx context.Context, source *personalDeckSource, slides map[string]personalDeckSourceSlide) error`. Reuse the existing upload-size boundary. Canonical OpenAPI documents v1/legacy/v2 and source limits on the upload-complete contract, without a new route or quota change.

- [ ] Write matching valid/invalid fixtures for source identity, paths, roles, all size/depth restrictions, macro/encrypted packages, cancelled context and truncated ZIP/XML. Assert legacy/v1 still pass, unsupported version 3 fails, rejected completion cannot replace an existing head, and existing revision/owner denial behavior persists. Change the old test named `future` to version 3; version 2 now has defined behavior.
- [ ] Run `go test ./internal/assets ./internal/httpapi ./docs -count=1`; record the v2/source validation failures before changes. DB-backed acceptance requires an isolated test PostgreSQL, never an existing production database.
- [ ] Implement package validation with standard `archive/zip`, `encoding/xml`, strict canonical base64 and SHA-256. Stream expanded data under limits and context cancellation; check all ZIP members before XML/reference resolution. Reject invalid data with the existing upload error and preserve completed-state/head atomicity. Update canonical OpenAPI and contract tests together.
- [ ] Run focused tests and `go vet ./...`; lint `docs/openapi.yaml` with the repository CI's pinned `@redocly/cli@2.47.0`. Commit `feat: validate schema v2 PPTX source preservation`. Do not deploy this validator.

### Task 3: Lossless local load, edit and save foundation

**Files:** Modify `editable-presentation.ts`, `editable-presentation-persistence.ts`, `presentation-drafts.ts` and `pptx-import.ts` only where trust-boundary tests require it. Extend their existing tests and `editable-presentation-pptx.test.ts`, `pptx-import.test.ts`. Use Task 1's source fixtures and the existing 22-slide hymn.

**Interfaces:** Extend `convertPresentationData(source, presentation, pptxSource?: PptxSource): EditablePresentationDocument`; omission retains exact v1 behavior. A supplied validated source produces v2 plus slide/node references from the existing `slide.slidePath` and original `node.id`. Make private `parseEditablePresentation(value): Promise<EditablePresentationDocument>` await package validation and preserve the parsed version/source; its existing async load caller awaits it. Reuse existing persistence/save/draft functions and size constant rather than creating a parallel save service.

- [ ] Add `reopens exact source after edit and save`, `v1 import remains v1`, `binds shape text and image to original nodes`, `copy and duplicate detach source references`, `reorder and undo retain references`, `rejects oversized serialized source before mutation`, and `rejects corrupted persisted source including restored drafts`. Assert unchanged original ZIP digest, edited text/geometry, source roles and old catalog/head retention on failure. Test UTF-8 byte length and ordinary v1/legacy reopen.
- [ ] Run the relevant existing test files plus `pptx-source.test.ts`; observe source/version loss and stale-copy-reference failures before implementation. Existing already-passing cases stay as regressions without extra production changes.
- [ ] Preserve source/version on load and ordinary save; validate at imported/untrusted load boundaries before caching. Clear references only for copied objects/slides. Preflight whole serialized byte size before catalog/draft/persistence mutations. Keep current account/revision checks across asynchronous validation. General `importEditablePptx` remains v1: production activation is a later batch after deployed-API acceptance, not a permanently disabled endpoint of the goal.
- [ ] Run the focused tests to GREEN and commit `feat: preserve PPTX source through local document edits`.

### Task 4: Cross-repository and dual-mode verification

**Files:** Reuse the existing rendering/text/navigation E2E suites, extending a v2 source fixture test if missing; record acceptance in this plan. No unrelated UI or release changes.

**Interfaces:** Consume Tasks 1–3. A single small portable-v2 corpus must pass both TypeScript and Go, with the same invalid mutations rejected. Use the existing account/revision/save/projection paths.

- [ ] Verify the same original hymn source bytes and 22 slides after supported edits, save/reopen, copy, undo and projection in browser and isolated local Electron. Show all variants retain independent projection ownership and no external URL fetch. Do not infer physical Windows or packaged acceptance.
- [ ] Run client `npm run lint`, `npm run typecheck`, `npm test -- --maxWorkers=2 --testTimeout=15000`, `npm run build`, `npm run build:web` and the scoped browser/Electron checks. Run API `go test -race ./... -count=1 -p=1`, `go vet ./...`, canonical OpenAPI lint and contract tests; provision an isolated local PostgreSQL for repository DB-backed checks. Report unavailable prerequisites and CI-only security/infra checks separately, never as passed.
- [ ] Obtain one fresh whole-diff review as required by native execution; reproduce/fix Important or Critical findings RED→GREEN, then rerun affected required checks. Record ledger rulings and no-activation evidence.
- [ ] Commit verification documentation. Keep both unmerged worktrees. Report this foundation complete separately from production v2 activation, export and the full five-phase goal.

## Follow-up boundary

This plan implements source validation and local preservation readiness, not full phase 1. Next: deployed-API acceptance and client write activation under separate release authorization, then supported-subset PPTX export with an independent consumer. Editable objects, masters/layouts/themes, playback and Windows/device/performance acceptance follow the approved order. A v2 file is intentionally unreadable by older clients; rollout must account for recipients before general writes are enabled.

## Read-only corpus preflight — 2026-10-12

Measured the actual existing hymn fixture `src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx` using Python standard-library ZIP CRC verification and strict XML parsing, without rewriting it.

- SHA-256: `ce1648cc6a449d7a29587b790877be1cf30efbef59de3984065dcdad948d6a0d`.
- Compressed package 25,845 bytes; canonical base64 34,460 bytes before JSON metadata.
- 53 unique ZIP members; 47,701 expanded bytes; largest member 3,804 bytes; no media payload.
- 53 XML/relationship parts; maximum XML element depth 10; 22 slide parts; each slide's `p:cNvPr/@id` values are unique.
- No external relationships or encrypted entries; all ZIP CRC checks passed.

This establishes that the approved hymn fits the proposed bounds and source-node identity rule. It does not establish compatibility with large image/media decks, ZIP64 producers, other authoring applications or cloud acceptance; Task 1's synthetic boundary tests and subsequent independent-consumer corpus must cover those gaps. The XML depth cap of 128 remains a deliberate new trust-boundary limit, not a value proved universal by this small fixture. Plan review remains pending.
