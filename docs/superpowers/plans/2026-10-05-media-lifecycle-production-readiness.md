# Media Lifecycle Production Readiness Plan

## Status and baseline

- Status: implemented on `fix/media-lifecycle-20261006`; local validation complete. Release and physical-device acceptance remain open.
- Investigation baseline: `fix/presenter-import-playback-20261005` at `73139970`.
- Existing dependency: PR #89 and [its completed implementation plan](2026-10-05-presenter-import-playback.md).
- Scope: photos, video, PDF, and PPTX across import/upload, storage, preparation, preview, projection, trash, restore, permanent deletion, and resource reclamation.
- Primary objective: predictable UI/UX and reliable production behavior throughout the user journey.
- Current authorization: implementation, PR integration, merge and a combined v2.6.6 release authorized on 2026-10-06. Production account data mutations remain out of scope.

The three-agent review found concrete code-path defects, but did not reproduce every scenario in a real GUI or on physical devices. Existing focused tests passed; they do not cover all newly identified cross-layer failure paths. The possible VLC startup audio leak is a device-validation risk, not an observed incident.

## Product contract

| Stage                | Required user-visible behavior                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Import or upload     | Show destination, progress, completed and failed counts, and actionable errors.                                  |
| Persistence          | Distinguish locally saved, pending cloud synchronization, and synchronized.                                      |
| Preparation          | Distinguish downloading, parsing, and preparing playback. Missing thumbnails alone must not block usable media.  |
| Projection readiness | Verify source and required playback capability; separately report actual render or decode failures.              |
| Presentation         | Operator page, transport state, and supported controls agree with the audience display.                          |
| Trash                | Allow restore. Removing a catalog item must not abruptly interrupt its active presentation snapshot.             |
| Permanent deletion   | Remove restore capability after catalog deletion commits. Defer physical deletion while resources remain in use. |
| Cleanup failure      | Show pending cleanup and allow retry. Recover after restart without inventing a successful restore.              |

Keep the existing projection ownership contract: browsing Bible or Media does not take projection ownership; returning to Timer retains its documented exception. Explicit end or close invalidates pending work so it cannot restart playback.

### Audience behavior during transitions

- Operator UI distinguishes the requested item from the item confirmed as projected. A successful dispatch is not proof that the audience can see the requested media.
- Proposed transition default: an explicit switch to another item stops old audio/video immediately and uses a neutral internal loading fallback until the new content is ready. Do not expose filenames, stack traces, recovery controls, or other diagnostic text to the audience. This does not add a user-facing blank projection mode.
- Refreshing a usable source for the same item preserves its current frame and intended page/transport state where possible. Retry must not implicitly advance the playlist, autoplay paused content, or resurrect an ended session.
- Access revocation, logout/account replacement, and authoritative security denial retain their existing stop/release behavior. Ordinary trash retention and resource locks never override authorization.
- Validate the proposed transition default with the actual presentation journey; preserving the previous slide until its replacement is ready is a separate product choice, not an accidental component-specific behavior.

### Product acceptance decisions

The user confirmed format support and live VLC preview requirements on 2026-10-06. Implementation and runtime acceptance remain separate gates.

| Decision                            | Proposed default                                          | Status                          | Closure evidence                                                                            |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| Legacy `.ppt`                       | Explain per file how to save as `.pptx`; no new converter | Accepted 2026-10-06             | User: support `.pptx` first; show conversion guidance for old `.ppt`                        |
| VLC visual preview                  | Live images from the actual projection player             | Required 2026-10-06             | User explicitly requires live visual preview; poster/status alone does not satisfy delivery |
| Cross-item preparing/failure output | Stop old audio/video and show neutral internal fallback   | Pending presentation acceptance | Observe slow/failed switches and record the accepted audience behavior                      |

Record the accepted choice and its acceptance evidence here when resolved. Do not silently mark a proposed limitation as an implemented equivalent of the broader requirement.

### Accessibility of changed controls

- Changed icon-only controls need localized accessible names and visible keyboard focus.
- Progress and failures need appropriate status announcements without flooding assistive technology on every playback tick.
- Import and repair UI must define focus entry, closing, and return to the invoking control. Use existing accessible UI primitives rather than custom focus plumbing where possible.
- Escape, arrow keys, and text input inside dialogs/drawers must respect shortcut scopes and must not unintentionally change or end audience playback.
- Verify keyboard-only cancel, retry, repair, and close, plus accessible control names and status output. This is scoped to the affected UI, not a whole-application redesign.

## Architecture and constraints

- Retain the existing stores, projection coordinator, adapters, immutable blob identity, resource locks, job cancellation fences, and cleanup journal.
- Keep healthy HTML playback native. Use the existing VLC engine for supported desktop fallback cases; keep FFmpeg responsible for remux and derived media rather than introducing another player.
- Preserve browser and Electron behavior, account isolation, security scan gates, read-only provider rules, personal-cloud outbox ordering, and reference-count protection.
- Keep unrelated user changes and all existing worktrees intact.
- Do not introduce a new generic job framework or authorization service to solve these defects.
- Put serializable import/session state in Zustand, not a new business-data Context.
- New IPC operations require main-process validation, typed preload exposure, and scoped access checks. Never accept arbitrary filesystem paths from the renderer.
- Persistent schema changes require explicit versioning/migration and preservation tests. Prefer extending existing cleanup records where sufficient.
- Existing user expectations take precedence over cosmetic architecture improvements.

## Phase 1 Data consistency for imports and deletion

Priority: P1. Complete before presentation polish.

Primary files:

- `src/renderer/src/stores/file-explorer.ts`
- `src/renderer/src/stores/folder.ts`
- `src/renderer/src/lib/file-resource-cleanup.ts`
- `src/renderer/src/lib/resource-cleanup-journal.ts`
- `src/renderer/src/lib/media-resource-locks.ts`
- `src/renderer/src/lib/file-explorer-db.ts`
- `src/renderer/src/lib/persistence-operation-queue.ts`
- `src/renderer/src/lib/app-init.ts`
- `src/renderer/src/pages/TrashPage.tsx`

### Destination deletion during import

The current local import checks the parent before awaiting blob storage, then writes metadata without checking whether the destination was deleted during that wait.

- [ ] Add a regression that delays blob persistence, deletes the destination, and resumes import.
- [x] Validate the destination and its ancestor chain in the authoritative metadata commit transaction.
- [x] Reject a missing, trashed, inaccessible, or otherwise invalid destination; do not silently relocate the file to root.
- [x] Roll back the newly created blob on rejected commit. Journal cleanup failures so rollback does not leak resources.
- [x] Report the file as failed rather than incrementing the success count.
- [x] Preserve the personal-cloud transactional and ownership rules; do not replace them with the local path.

Acceptance: deleted destinations never acquire hidden children; failures leave no untracked source blobs; a valid concurrent import still succeeds.

### Ordered metadata commits and shared references

The current local import calls `addItem()`, which queues a metadata save, then also writes metadata directly. The persistence queue retains failed operations for retry, independently of permanent cleanup. Adding only a transaction to one path does not fence the other writer.

- [x] Route local import metadata and permanent catalog deletion through a consistent ordered commit boundary. Do not leave a second queued save after the authoritative import transaction.
- [x] Drain, invalidate, or reject stale writes for permanently deleted records without discarding unrelated queued user work. Surface failures rather than assuming the queue has drained successfully.
- [x] Account for parent deletion already pending in the persistence queue; an older database record is not sufficient evidence that the destination is still valid.
- [x] Commit copy metadata, destination validation, and blob reference changes atomically. Existing `incrementBlobRef` uses separate get/put operations and must not lose concurrent increments.
- [x] Serialize reference mutations against purge and revalidate surviving authoritative references before final source cleanup. Reuse existing database transactions rather than creating a generic reference manager.

Acceptance: fail/block a queued rename, trash, or restore write, then permanently delete and retry persistence; no record or blob may be resurrected. Concurrently create two copies, delete the original and one copy, and confirm the survivor still projects. Inject copy metadata failure and interleave copy with purge; no incorrect refCount, invisible copy, or missing source may remain.

### Crash-safe native import staging

Local native import currently copies bytes before creating its blob record. A crash in that interval leaves a file that a zero-reference database scan cannot find. Personal-cloud staging already provides a journal-first pattern in `personal-sync-db.ts`.

- [x] Persist local staging cleanup intent before native copying starts; retire that intent as part of the successful metadata commit.
- [x] Exclude active staging work from recovery using an appropriate shared ownership boundary; reuse the existing staging-lock pattern where applicable.
- [x] Preserve retryable cleanup intent when database persistence and immediate native rollback both fail.
- [x] Recover interrupted native imports even when no `file-blobs` record was ever created.

Acceptance: crash after native copy but before blob/catalog persistence, then restart and reclaim the orphan. Inject database quota failure plus native deletion failure and verify a durable retry record. Recovery in another tab must not delete an active import.

### Catalog deletion and physical cleanup failure

Currently, catalog deletion may commit before native cleanup fails, while the store retains the item because its update waits for complete cleanup success. Restore can then recreate metadata without a valid blob.

- [ ] Add a store-to-trash regression for native delete failure after catalog commit.
- [x] Separate the committed catalog result from the outcome of physical cleanup.
- [x] Remove committed deletions from the store even when resource cleanup needs retry.
- [x] Remove Restore immediately after permanent catalog deletion; show pending cleanup through the existing recovery UI.
- [x] Keep cleanup retries idempotent and protect shared references.

Acceptance: cleanup failure cannot leave a restorable ghost item; retry does not recreate catalog records or delete a surviving copy's source.

### Crash recovery for deferred deletion

Projection locks deliberately delay deletion. The intent to delete a zero-reference source must survive a crash before lock release.

- [x] Add a regression that deletes a locked resource, simulates a process restart, and runs startup recovery.
- [x] Persist deferred cleanup intent, or reconstruct it safely at startup from authoritative references.
- [x] Recheck source references, active use, personal-sync protection, and pending operations before deleting bytes.
- [x] Do not interpret every zero-reference or temporarily staged blob as immediately disposable.
- [x] Recover source, derivative, and associated cache cleanup without requiring a manual integrity repair.
- [x] Define ownership across browser operator tabs, projection windows, and native playback. The existing `media-resource-locks.ts` maps are renderer-local; an empty map in a new tab does not prove global inactivity.
- [x] Before enabling startup reclamation, provide shared exclusion/leases or an explicit safe single-operator policy. Do not silently remove currently supported concurrent sessions; preserve them with shared ownership unless a product change is accepted.
- [x] Ensure crash recovery can reclaim abandoned ownership without stealing live resources; apply the same boundary to manual integrity repair and cache clearing.

Acceptance: normal session release and crash/restart both reclaim eligible resources, while active or referenced resources remain available.

Cross-context acceptance: tab A projects a source and permanently deletes its catalog record; tab B starts recovery. A must still read the held source after projection reload or switching back. Cleanup becomes eligible only after all valid holders release it; crashed holders must not pin it forever.

## Phase 2 Import progress and recovery UX

Primary files: `lib/upload-utils.ts`, `pages/FilesPage.tsx`, existing file-browser import entry points, and personal-sync status components.

- [x] Apply consistent status and error behavior to file picker, folder picker, and drag-and-drop.
- [x] Show batch completed/total counts, the current operation, and a per-file failure list.
- [ ] Distinguish local copying, cloud upload, synchronization, downloading, and derivative preparation.
- [x] Show percentage only when real byte progress exists; otherwise show phase and item counts.
- [x] Allow stopping remaining batch items while preserving completed imports.
- [x] For an operation that cannot abort immediately, display cancellation in progress and safely finish or roll back its commit.
- [x] Prevent accidental duplicate submission of the same active action without blocking intentional later re-import.
- [x] Retry only failed items; do not duplicate already successful items.
- [x] Keep file input reset behavior so the same file can be selected after failure.
- [x] Preserve quota handling, account/lease checks, outbox ordering, and safe backup/cancellation behavior from PR #89.
- [x] Localize actionable messages instead of exposing raw internal reason codes as the only explanation.

Acceptance scenarios: mixed valid/invalid files, insufficient disk space, browser storage quota, personal-cloud quota, cancellation, folder navigation during import, duplicate clicks, offline recovery, and retrying the same file.

Implement progress using the existing import path and store conventions; a new durable general-purpose import scheduler is not required by this plan.

## Phase 3 Photo and document presentation consistency

Primary files:

- `components/Control/FileExplorer/Presenter/Preview/PdfPreview.tsx`
- `components/Control/FileExplorer/Presenter/Preview/ImagePreview.tsx`
- `components/Projection/FileProjection.tsx`
- `lib/media-projection-payload.ts`
- `lib/projection-render-state.ts`
- `lib/media-projection-sync.ts`
- `stores/media-projection.ts`

Paths above are relative to `src/renderer/src/`.

### PDF state and loading

- [x] Add delayed-load regressions: choose page N or continuous mode before the projection-side document finishes loading.
- [x] Preserve the latest pending page, scroll position, and view mode for the current item and session.
- [x] Apply pending state after document readiness; discard commands belonging to replaced items or ended sessions.
- [x] Give operator preview, initial projection payload, replay, and source renewal an explicit common state contract.
- [x] Preserve the chosen reading mode across documents; initialize a newly selected document at page 1 on both surfaces.
- [x] Preserve the current document's page during operator remount, source renewal, and projection recreation.
- [x] Clamp page and scroll state to the loaded document's valid range.

### PDF rendering lifecycle

- [x] Keep and cancel obsolete `RenderTask` instances before reusing a canvas.
- [x] Check cancellation after asynchronous page lookup as well as during render.
- [x] Treat expected cancellation separately from decode/render failures.
- [x] Route genuine failures to existing error and retry UI rather than unhandled promise rejection.
- [x] Test rapid next/previous, mode changes, source replacement, and close during rendering.

### Photo and document load errors

- [x] Handle image decode/load errors and rejected PDF/PPTX loading.
- [x] Send item/session-scoped projection failures back to the operator.
- [x] Show the affected filename, actionable cause, and a working retry action.
- [x] Distinguish source availability from successful decoding/rendering without requiring thumbnails as a universal gate.
- [x] Ensure stale failures cannot replace the status of newer projected content.
- [x] Retry must reload or reacquire the source, not only dismiss the message.

### PowerPoint compatibility

- [x] Preserve PR #89's presenter-authoritative page selection, page-count readiness, grid navigation, stale callback guards, and editor save protections.
- [x] Validate actual PPTX documents for fonts, layout, images, aspect ratios, page count, and embedded media.
- [x] Document observed limitations; do not infer PowerPoint-equivalent animation or embedded-media support from basic slide rendering.
- [x] Give legacy `.ppt` an explicit conversion instruction to save as `.pptx` rather than only an aggregate unsupported-file warning.

Scope decision: direct `.ppt` conversion is not part of the default implementation. If direct legacy `.ppt` playback is required, conversion becomes a separate required capability and production acceptance cannot claim that requirement complete until it exists.

The user accepted this format boundary on 2026-10-06.

Acceptance: slow large PDF navigation, rapid page changes, continuous PDF A to PDF B, source renewal and remount on page N, corrupt documents/images, and real multi-page PPTX navigation with matching operator/audience pages.

## Phase 4 VLC presentation UX and startup safety

Primary files: `src/main/ipc/projection-vlc.ts`, the video preview and media toolbar, `FileProjection.tsx`, and existing projection coordinator tests.

### Silent initialization

The current bootstrap installs the source, applies volume, and starts playback before final pause/seek state settles. Actual audible leakage has not been verified.

- [x] Add tests for initially paused playback, paused recovery, seek recovery, and volume changes during startup.
- [x] Keep bootstrap muted or at zero volume while initializing source and restoring position.
- [x] Restore requested volume only when the final transport/seek state can be applied safely.
- [x] During startup, retain new volume commands as pending desired state.
- [ ] Verify the behavior on packaged macOS and Windows with actual audio output.

### Preview and control truthfulness

- [x] Show live frames from the actual VLC projection player; retain authoritative playback status and transport controls.
- [x] Bound capture resolution and refresh rate; avoid a second decoder or audio stream. Suppress stale frames after source/session changes and clean temporary snapshots.
- [x] Show preparing or failed preview state honestly; a poster is only a temporary fallback, not acceptance of live preview.
- [x] Preserve usable time, duration, seekability, play/pause, ended, and replay controls from VLC-confirmed state.
- [x] Disable unsupported VLC zoom/pan controls and reset residual framing state so preview does not imply unsupported audience behavior.
- [x] Keep controls consistent during preparing, failed, paused, playing, and ended states.

Scope decision: live VLC visual preview is a required delivery gate. Capture from the existing player is preferred over a second playback engine. Measure native capture latency and verify actual refreshed frames in the packaged application; do not claim 30 fps or frame-perfect synchronization without evidence.

### First-use preparation and cancellation

- [x] Show distinct phases for source acquisition, inspection, remux, and player initialization.
- [x] Provide meaningful waiting and cancel/return behavior; do not fabricate progress percentages.
- [x] Retain the existing ownership guards so completed preparation cannot restart replaced or ended content.
- [x] Define whether cancellation stops only the presentation request or also the background cache work; make the visible state match the actual behavior.
- [ ] Measure representative large-file preparation before deciding whether import-time background prewarming is necessary.
- [x] Keep runtime-unavailable, unsupported codec, remux failure, timeout, and disk-full errors actionable.

Acceptance: healthy native video never initializes VLC; VLC-required formats, MKV remux, missing runtime, rapid replacement, pause/seek/replay, window recreation, explicit end during preparation, and no audio before intended playback.

## Phase 5 Readiness repair and storage reclamation

### Readiness repair

Primary files: `ReadinessIssueDrawer.tsx`, `PresenterHeader.tsx`, `presentation-readiness.ts`, and the media projection store.

- [x] Reanalyze an item after successful preparation or retry and update report totals.
- [x] Preserve original ordering information for items excluded at startup.
- [x] Offer an explicit action to add a repaired item to the current playlist; do not interrupt the currently projected item.
- [x] Acquire required resource locks and update the snapshot safely when adding an item.
- [x] Revalidate the originating session, immutable source/blob identity, catalog availability, and authorization immediately before applying reanalysis results or inserting a repaired item.
- [x] End/new session, source replacement, trash/purge, and account/provider changes invalidate pending repair results. Repeated Retry/Add actions must be idempotent.
- [x] Preserve the current item by identity when insertion changes its index. Do not invoke start/restart merely to update the queue, release its source lease, reset playback time/page, or briefly unlock resources still in use.
- [x] Adjust the existing playlist-change subscription deliberately: `media-projection-sync.ts` currently clears the remote source and projects again when playlist content changes. A queue-only insertion must not reload unchanged current content.
- [x] Persist Skip acknowledgment for the current session so closing/reopening the drawer does not undo it.
- [x] Keep skipped source files intact; skipping is not deletion.
- [x] Clear acknowledgments at the appropriate new-session boundary.
- [x] Use actionable localized reasons; retry the relevant operation rather than an unrelated latest job.

Acceptance: failed item repaired during presentation, explicit insertion without changing the current audience frame, stable ordering, session-scoped Skip, and retry failure with a useful next action.

Also test repair followed by End/new session, source replacement, deletion, logout/revocation, double Add, and insertion before the current item. Late completion must not insert into another session, revive deleted media, duplicate entries, or reset the current remote lease/transport.

### Storage accounting and cleanup

Primary files: `src/main/ipc/video-remux.ts`, native storage IPC/preload contracts, `media-storage-accounting.ts`, `media-storage-cleanup.ts`, and existing storage settings.

- [x] Include native remux output and temporary files in storage accounting.
- [x] Distinguish sources, regenerable caches, trash retention, and pending reclamation without double counting.
- [x] Extend existing cache-clear UI to include eligible remux caches.
- [x] Exclude active playback and in-flight source mutations; reuse existing serialization/fences.
- [x] Keep originals and unsynchronized user data outside regenerable-cache deletion.
- [x] Update measured usage after cleanup and expose failures through existing recovery controls.
- [x] Verify deferred cleanup becomes eligible after session release and after safe restart recovery.

Acceptance: large MKV cache is visible; clearing cache reclaims eligible bytes without interrupting playback; shared copies and unsynced originals remain usable; failures can be retried.

## Phase 6 Verification and delivery

### Regression strategy

- [ ] Write failing behavioral tests for each confirmed defect before fixing it.
- [ ] Use delayed promises, controlled rendering tasks, and filesystem failure injection for races; do not rely on immediately resolved mocks for concurrency assertions.
- [ ] Include store/UI integration tests for partial deletion, not just cleanup-helper tests.
- [ ] Keep real decoder/file fixtures where mock success would hide the defect.
- [ ] Run targeted checks while implementing, then complete repository-wide gates on the final integrated head.
- [ ] Obtain independent final review of data integrity, concurrency, and the operator/audience contract.
- [ ] Exercise A playing to slow B to failed B to Retry to immediate End. Observe frame, audio, requested/confirmed status, and late completion at each step; repeat for paused same-item renewal and authoritative access revocation.
- [ ] Verify keyboard-only affected journeys, accessible names/status, focus restoration, and shortcut isolation with repair/import UI open.

Repository gates:

```bash
npm run lint
npm run typecheck
npx vitest run --maxWorkers=2
npm run build
npm run build:web
npm run test:e2e:browser
```

Run relevant packaged runtime checks and `npm run test:e2e:packaged` with the repository's required packaging prerequisites. Inspect the current scripts before executing so commands use the intended build artifacts. Bound workers to avoid shared-machine contention; do not weaken assertions to hide flakes.

### Acceptance matrix

#### Provider semantics

Exercise the lifecycle with each ownership model rather than applying local-file deletion rules to every provider. This adds client acceptance coverage, not a backend redesign.

| Source model                   | Required cases                                                                                                   | Invariant                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Local files                    | Trash/restore/purge, concurrent copies, queued persistence failure, interrupted import                           | No resurrection, lost references, or hidden orphan files                                     |
| Personal cloud                 | Unsynced outbox, logout/owner switch, late upload completion, retry and deletion                                 | Preserve pending user data; never commit into another account or revive its projection       |
| Read-only synchronized sources | OneDrive, LINE, local-sync and shared-source unlink/revoke where supported; in-flight downloads and derived jobs | Honor provider ownership; late work cannot recreate unlinked or revoked catalog/source state |
| Cache eviction                 | Remote-only transition, subsequent download, pinned/offline policy and active-resource exclusions                | Preserve remote catalog and original ownership; eviction is not remote deletion              |

Ordinary trash/purge continuity never takes precedence over an authoritative access denial. Authentication recovery must preserve existing distinctions between transient unavailability and confirmed revocation.

#### Platform journeys

| Journey                                                             | Browser                               | Packaged macOS | Packaged Windows |
| ------------------------------------------------------------------- | ------------------------------------- | -------------- | ---------------- |
| Photo import, decode error, projection, trash, restore, purge       | Required                              | Required       | Required         |
| Large PDF delayed load, rapid navigation, mode and page consistency | Required                              | Required       | Required         |
| Real PPTX pages, grid, source changes, editor/presenter separation  | Required                              | Required       | Required         |
| Native video controls, ended/replay, source failure                 | Required                              | Required       | Required         |
| VLC-required video, remux, startup silence, player recreation       | Unsupported formats clearly explained | Required       | Required         |
| Import destination deleted during copying                           | Required                              | Required       | Required         |
| Permanent deletion with physical cleanup failure                    | Browser storage failure equivalent    | Required       | Required         |
| Delete while presenting, then close or crash/restart                | Required                              | Required       | Required         |
| Readiness retry/skip/reinsert and storage reclamation               | Required                              | Required       | Required         |
| Authenticated personal-cloud upload, offline recovery, deletion     | Required                              | Required       | Required         |

Also require browser multi-tab ownership/recovery, native staging crash recovery, queued-write retry after purge, concurrent copy/purge, and keyboard-only repair/import workflows. For each provider/platform case, use actual supported operations; record unsupported combinations explicitly rather than skipping them without explanation.

Physical-device checks additionally cover external display selection, fullscreen/DPI, moving/recreating the projection window, real audio output, and representative large files. Use isolated test profiles and disposable fixtures; do not mutate production user data merely to exercise failure paths.

### Evidence and completion criteria

- [x] Record local tests/builds, PR CI, merge, release, and physical-device acceptance separately.
- [x] Record exact tested commits and packaged artifacts; historical green checks are not evidence for a new head.
- [ ] No unresolved P1 integrity or operator/audience synchronization defects.
- [ ] No unverified startup-silence claim for VLC; complete the physical audio check.
- [ ] Every supported media journey has both successful and failure/recovery evidence.
- [x] Format and preview limitations are explicit and match the agreed product scope.
- [ ] Product acceptance decisions above are resolved with evidence; proposed scope reductions do not count as completed functionality.
- [ ] No silent data loss, invalid Restore action, stale playback resurrection, or unsafe resource deletion.

The initial review's focused tests passed: document/cleanup 30, shared lifecycle 128, VLC 62, and import/readiness UI 38 tests. Some overlap; do not sum them as unique coverage. Newly identified scenarios still need regression tests and runtime acceptance.

## Consultant review amendments

Two follow-up consultant reviews checked this plan against baseline code. Findings were accepted as plan requirements, not marked as fixed product defects:

| Review concern                                                   | Baseline evidence                                                                                                                     | Required plan response                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Queued writes can outlive permanent deletion                     | `folder.ts` queued record saves; `persistence-operation-queue.ts` retains failed work; `file-explorer.ts` has duplicate import writes | Ordered commit boundary and stale-write retry regression                    |
| Concurrent copies can lose reference increments                  | `file-explorer-db.ts` separate get/put; `folder.ts` separately queues copy metadata                                                   | Atomic copy/reference mutation and copy-versus-purge tests                  |
| Empty renderer-local locks do not establish global inactivity    | `media-resource-locks.ts` module maps; separate browser projection sessions                                                           | Cross-context ownership before automatic reclamation                        |
| Native copies can orphan before any blob record exists           | `file-explorer-db.ts` import-before-put; `personal-sync-db.ts` journal-first staging pattern                                          | Durable staging intent and crash-point tests                                |
| Ordinary deletion and access revocation have different semantics | `media-projection-sync.ts` revocation/account-change stop paths; provider unlink/eviction paths                                       | Explicit authorization exception and provider matrix                        |
| Audience output during loading/failure is underspecified         | `FileProjection.tsx` clears content during replacement and has filename fallback                                                      | Requested/confirmed status and audience transition contract                 |
| UI improvements lack keyboard/focus acceptance                   | PDF/video icon controls and `ReadinessIssueDrawer.tsx`                                                                                | Accessible names, focus handling, scoped shortcuts and status announcements |
| Proposed format/preview limits are not accepted requirements     | `.ppt` capability is unsupported; VLC preview is still HTML-based                                                                     | Explicit pending product capability decisions                               |
| Reinsert can affect a new session or restart the current item    | `media-projection-sync.ts` playlist-change reload subscription                                                                        | Source/session authorization fences, idempotency, and queue-only insertion  |

Consultant baseline verification: persistence queue/database/folder/resource-lock suites passed 69 tests across four files; PDF preview passed nine tests. These are existing checks, not reproduction evidence for the new interleavings or physical-device behavior. Keep each implementation checkbox open until its corresponding behavior has actually been verified.

## Implementation and branch sequencing

1. Fix data integrity and durable cleanup.
2. Add import progress, cancellation, and recovery feedback.
3. Fix PDF/document rendering and state synchronization.
4. Complete VLC control/preview behavior and startup safety.
5. Close readiness repair and storage-management loops.
6. Run integrated review, CI, packaged checks, and physical acceptance.

Before implementation, refresh remote state and confirm whether PR #89 has merged. Create a new isolated task worktree and branch from the latest `origin/main`. If #89 remains unmerged, preserve its worktree and choose an explicit dependency strategy before coding; do not silently implement against main while assuming its fixes are present. Use small reviewable commits aligned with the phases above.

Preferred delivery is focused PRs for integrity, rendering/playback, and recovery UX, with dependencies recorded and shared-contract changes reviewed first. If implementation must start before #89 merges, record the exact dependency commits in the new task branch and reconcile against main before final integration checks. No dependency merge or release is implied by this plan.

Do not merge or release based on this planning request. Keep implementation and validation evidence in the task worktree until the authorized delivery scope is complete. Preserve the existing completed plan as historical evidence rather than rewriting it to imply these new findings were already covered.

## Implementation evidence (2026-10-06)

- Working branch: `fix/media-lifecycle-20261006`, based on refreshed `origin/main` and fast-forwarded through PR #89 (`73139970`). The original worktree is preserved.
- Schema version 8 adds permanent catalog deletion fences; upgrade tests preserve existing files, pending uploads, and cleanup records.
- Local imports journal staging before bytes are copied, commit destination validation with metadata, and remove staging intent in the same transaction. Copies commit metadata and references atomically.
- Physical reclamation uses durable records and shared Web Locks; overlapping same-source sessions reuse the held shared lease to avoid waiting behind a queued cleaner. Integrity repair and cache eviction use the same ownership boundary.
- New import browser tests exercise cancellation and retry of failed files without duplicating successful imports. Cross-tab and full browser results are recorded below.
- Live VLC preview is required by the accepted product contract. The implementation captures the existing player, bounds resolution/rate, and suppresses stale results. The rebuilt native binding disables snapshot notifications; packaged checks passed.
- Checkmarks above denote implemented behavior with scoped checks, not a release or physical-device acceptance claim. Final integrated gates and remaining platform checks are listed below.

PPTX rendering evidence and observed format limits: [browser validation](../../testing/media-lifecycle-pptx-validation.md). Embedded MP4 in the tested import is a static poster; use a separate video item for playback. Real installed-font fidelity, animations and native PowerPoint-equivalent embedded playback are not claimed.

### Native runtime findings and validation

- Packaged macOS testing reproduced a real VLC binding lock inversion during MKV startup: the main thread held the binding player mutex while waiting for libVLC; a VLC event callback held the libVLC event lock while waiting for that player mutex. The failure was sampled before the test app exited.
- The pinned `electron-vlc-player@1.0.2` source patch queues copied native events using a separate event registry; player-state updates and enrichment occur on the main thread before invoking JavaScript. Independent review checked lock ordering, queued-event lifetime and player disposal.
- The same reproducible patch disables snapshot PIP/OSD and fixes argument-pointer lifetime. `npm run rebuild:vlc` compiles from source; postinstall invokes it. The binary gate checks both snapshot and event-dispatch markers so an old binary cannot silently pass.
- Live preview uses the actual projecting VLC player, at most 640×360 and four captures/second with slower adaptive refresh when capture is costly. This is a bounded live monitor, not a 30 fps or frame-perfect preview claim.
- Packaged evidence confirms changing decoded frames, stable paused frames, frame changes after paused seek, resume, remux cache reuse, corrupt-file failure/retry and stale-temp cleanup after restart. Two fixture capture samples took 51 ms and 62 ms; these are samples, not a representative hardware/large-file benchmark.
- Final UI review also removed document-render preparing labels from video/audio; their existing authoritative playback-state UI remains responsible for transport readiness.

### Remaining acceptance boundaries

- No PR, merge or release has been performed for this implementation branch.
- Windows packaged playback, external display selection/fullscreen/DPI, physical audio startup silence, installed-font fidelity and representative large-file preparation still need device acceptance. macOS automated smoke does not establish these outcomes.
- Authenticated personal-cloud production upload/offline/deletion journeys were not exercised against a real user account. Local regression tests cover ownership, cancellation, provider storage and recovery boundaries without mutating production data.
- Live preview's bounded refresh quality remains a product acceptance item even though frames from the actual projecting player are implemented and tested. Full-rate video preview would need a different native frame transport.

### Final local validation record

Implementation remains an uncommitted diff on baseline `73139970bced51a2d96148042f0a071cb712c809`; no PR CI, merge or release is claimed. The source digest below identifies the tested changes rather than attributing them to the baseline commit.

| Gate | Result | Evidence |
| --- | --- | --- |
| ESLint | Passed; final Header changes also passed scoped lint | `/tmp/media-lifecycle-lint-complete.log` |
| Full Vitest, final source | 295 suites, 3469 tests passed | `/tmp/media-lifecycle-vitest-delivery.log` |
| Full browser suite | 61 passed, 2 Electron-only cases skipped | `/tmp/media-lifecycle-browser-report-final/` |
| Later focused browser rerun | 5 passed: cancellation, failed retry, cross-tab deletion, real PDF and PPTX | `/tmp/media-lifecycle-browser-delivery.log` |
| Web production build | Passed before final Header status fix | `/tmp/media-lifecycle-web-build-delivery.log` |
| Final unpacked macOS build | Passed, including both typechecks, production bundle and native checks | `/tmp/media-lifecycle-package-delivery.log` |
| Final packaged macOS smoke | 3 passed, including actual VLC live frames and document/native lifecycle | `/tmp/media-lifecycle-packaged-delivery.log`, `/tmp/media-lifecycle-packaged-delivery/` |

The final Header change passed its scoped regression tests, the final full Vitest run and final packaged smoke. The full browser suite was not rerun after that change. Full Vitest used two workers and a 15-second runner timeout for the shared test host; no functional or performance assertion was relaxed.

Artifact: `dist/mac-arm64/HHC Presenter.app` (unsigned local test package).

- Source digest (98 changed/new source, script, E2E and package files): `e2f7520a0e30985b27ce775f2947bed2251fa85c5847918869229481eedb052e`.
- `app.asar` SHA-256: `76bdb15404fb8c8fda4c251aa2a52e62b1adcbfd662d0dd38d8aab4ad94c6d93`.
- Packaged `vlc_binding.node` SHA-256: `e545633572550d57661830cff290a6675e7b118e11498c578b6d56c956f538ae`.
- Manifest: `/tmp/media-lifecycle-delivery-manifest.json`. Source digest hashes each sorted relative pathname, a NUL separator and its binary SHA-256; documentation and generated reports are excluded.

Unchecked acceptance items remain open. Local automation establishes implementation evidence, not Windows, physical-device or authenticated production-cloud acceptance.

### Combined release execution

The user authorized releasing PR #89 and this implementation together as v2.6.6. No intermediate release is planned. Required PR CI must pass before merge; the tag workflow must pass both platform package/runtime/smoke gates before publication. Earlier no-release statements above describe the previous validation checkpoint. Physical-device acceptance remains separate.
