# Presenter Import and Playback Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development, with test-first fixes and independent final review.

**Goal:** Make personal imports recoverable, unsupported desktop videos use VLC safely, and presentation controls navigate every page.

**Architecture:** Keep existing providers, outbox, projection coordinator and VLC runtime. Repair identities and validation at their current boundaries; page navigation stays in the media projection store.

**Tech Stack:** TypeScript, React 19, Zustand, IndexedDB, Electron IPC, Vitest, Playwright, LibVLC.

**Spec:** `docs/superpowers/specs/2026-10-05-presenter-import-playback-design.md`

## Global Constraints

- Preserve Electron/browser modes, projection ownership, account isolation, read-only providers and security scan gates.
- No new playback dependency, backend policy changes or identity migration.
- Personal upload maximum is 200 * 1024 * 1024 bytes; use canonical existing constant and align MIME values with current Asset API personal policy.
- No `as any` or new TypeScript suppression comments.
- Deliver PR plus passing CI; do not merge or release.

## Review Focus

1. A rejected file must not poison valid later imports or lose previously persisted content.
2. Retry/cancel while account or outbox state changes must not mutate another account or newer content.
3. Media errors arriving during replacement, owner navigation or queued seek must not replay stale content.
4. Slow/corrupt presentation loading must not end a deck or pretend its page count is one.
5. Page jumps must preserve editable save/composition guards and ordinary image/video grid behavior.

## Task 1: Personal cloud import and recovery

**Files:** `lib/upload-utils.ts`, `lib/personal-file-actions.ts`, `lib/personal-sync-db.ts`, `lib/personal-sync-runtime.ts`, `components/Control/FileExplorer/PersonalCloudStatus.tsx`, `pages/FilesPage.tsx`, relevant locale files, corresponding unit tests; add focused personal upload policy helper only if shared callers need it.

**Interfaces:** Preserve public upload APIs and provider contracts. Derived jobs consume persisted source blob IDs with separate item IDs. Recovery consumes owner ID and exact failed operation identity under lease; any cancellation uses fresh validated scope and preserves a verified local backup.

- [ ] Add failing tests for different item/blob IDs across cover/PDF/poster jobs; assert source bytes remain accessible.
- [ ] Add failing tests for personal SVG, over-200-MiB and zero-byte imports rejected before outbox writes while local SVG remains supported; accepted batch entries still import.
- [ ] Add picker failure/reselection tests. Implement per-file error reporting and guaranteed reset for both file/folder inputs.
- [ ] Implement smallest policy and enrichment changes; run targeted tests.
- [ ] Add recovery tests: quota explicit retry retains immutable request/id/snapshot; account/lease changes abort; permanent invalid file can only be cancelled after durable local backup with no submitted mutation/dependents; unsafe scope remains untouched and explains why. Finalize/flush editable sessions before fresh scope capture, then recheck pending editor work/save status after backup. Test blocked save and edits during backup preserve original catalog/outbox/blob refs.
- [ ] Implement reason-specific status and guarded retry/backup cancellation. Never automatically discard or reorder dependent work. Run personal sync and import suites.

## Task 2: Video routing and bounded metadata

**Files:** `lib/media-metadata.ts`, `lib/presentation-readiness.ts`, `lib/__tests__/media-metadata-authorization.test.ts`, `lib/__tests__/presentation-readiness.test.ts`.

**Interfaces:** Existing metadata/readiness public interfaces remain compatible. Healthy native status stays unchanged; known-unplayable native-fs desktop video yields existing VLC source descriptor after runtime availability check.

- [ ] Add failing tests for metadata captured before load-reset, error/timeout cleanup, uncertainty not cached as permanent unplayable, and later retry.
- [ ] Implement bounded probe and cleanup with current derived metadata contracts.
- [ ] Add tests for unplayable MP4/MOV fallback, healthy native avoiding VLC lookup, native storage/runtime failure and web rejection.
- [ ] Implement guarded readiness routing; run metadata/readiness suites.

## Task 3: Late video error recovery

**Files:** `shared/projection-messages.ts`, `main/ipc/validate.ts`, `renderer/src/components/Projection/FileProjection.tsx`, `renderer/src/contexts/ProjectionContext.tsx`, `renderer/src/lib/projection-session-coordinator.ts`, `renderer/src/stores/media-projection.ts` (coordinate with Task 4), corresponding validation/coordinator/context/render tests.

**Interfaces:** Add `file:playback-error` as a non-content event carrying item/blob identity, current content/load revision, media error code and observed playback state. Bind sender to the current projection origin; lifecycle generation is not content identity. Strictly validate IDs, numeric time/volume and transport. Coordinator promotion preserves replay/pending controls and uses existing system replay; snapshot engine state must match coordinator.

- [ ] Test strict event validation and exclusion from content replay.
- [ ] Test only current native element/load reports error, once; stale and network/abort errors never force VLC.
- [ ] Test owner/generation/item/content-revision checks before and after native-storage/runtime awaits; capture coordinator show/session identity and require it unchanged. Test same-item restart and media→timer→media ABA while fallback awaits, old content reports and non-projection senders; healthy video stays native.
- [ ] Test fallback preserves position, paused/playing, volume and newer pending seek/transport; replay and re-projection retain VLC; no loops.
- [ ] Implement event/report/coordinator promotion and snapshot synchronization. Web/runtime-missing/native-source-missing failure is visible and does not fake success.
- [ ] Run IPC validation, projection context/coordinator, FileProjection and media store suites.

## Task 4: Presentation page controls

**Files:** `renderer/src/stores/media-projection.ts`, `components/Control/FileExplorer/Presenter/PresenterGrid.tsx`, `MediaPresenter.tsx`, `lib/media-projection-sync.ts` and its tests (open-session payload must use presenter slide index), existing presentation preview helpers as needed, corresponding tests, `e2e/pptx-thumbnail.spec.ts` or focused new E2E file with generated real ten-page fixture.

**Interfaces:** Add `jumpToSlide(index: number): MediaProjectionActionResult` to store, reusing editable preflight and generation guards. Preserve `jumpTo` file semantics. Page grid consumes current presentation count/index and the guarded action; use one shared PPTX viewer per deck, not one archive parse per page.

- [ ] Test unknown/invalid count blocks Next/End without ending and presents unknown progress; resolving count permits page 2; final page still ends normally.
- [ ] Test 10-page PPTX/lpdeck grid, page 7 selection, Home/End, blocked editable saves and superseded navigation; ordinary file grid unchanged.
- [ ] Implement minimal store/page-grid changes, with loading/error state and bounded thumbnail work. Reuse editable document/session data for editable previews. Dispose slide handles and destroy the shared viewer on close/source switch. Ignore late ready/error from obsolete sources; test bounded active handles for a large deck and close-during-load cleanup.
- [ ] Fix the E2E-reproduced open-session editable payload selecting the workspace page instead of presenter page; regression asserts different editor/presenter page selections and preserves workspace selection.
- [ ] Add real ten-page PPTX browser test: import, page 1→10, projection page correspondence, G→7, Home/End, and converted editable navigation if supported by existing UI test helpers. Check delayed load and page errors.
- [ ] Run relevant tests and browser E2E.

## Task 5: Independent review and delivery

- [x] Review this plan in a fresh agent before implementation; correct findings and repeat until no unresolved actionable plan defects.
- [ ] Run full lint, typecheck, Vitest, desktop build and browser E2E; bound local test workers if shared machine load causes timeouts without changing assertions.
- [ ] Perform feasible Electron smoke using isolated user data and existing VLC fixtures; distinguish host/device limitations.
- [ ] Obtain independent whole-diff review, fix findings and verify changed behavior.
- [ ] Commit scoped changes, push task branch, create PR with problem/behavior/test evidence. Watch all PR CI checks and repair failures until green.
- [ ] Keep worktree and branch for unmerged PR; report remaining physical Windows/macOS acceptance separately.

## Investigation/verification ledger

- Three read-only investigations completed against latest main. Existing presentation fixture conversion retained 22 slides; slide/store/grid targeted baseline: 81 tests passed. Cloud targeted baseline: 57 tests passed.
- Initial unconstrained local suite hit a timing failure in existing Ribbon test under high system load; restart uses `--maxWorkers=2` to establish reliable baseline. No product change yet.
- Independent review round 1 found content/session ABA identity missing, editable-cancellation unsaved work guards missing, and size-poisoning wording inaccurate. All corrected; explicit viewer cleanup/large-deck tests added. Independent re-review: clean, no remaining actionable plan defects; coordinator baseline 24/24 passed.
