# Legacy Service and Soundboard retirement execution

This record belongs to the retirement implementation task. The complete source plan was read
from the primary checkout's uncommitted `2026-10-17-service-soundboard-retirement-plan.md`.
That plan, its advisor evidence, the ProPresenter plan and primary roadmap drafts are preserved;
their uncommitted contents are not copied into these commits. Roadmap status changes here are
narrow edits against this task's clean main baseline.

The user authorized sequential implementation, independent read-only review, PRs and merges
after applicable CI. No tags, release, manual deployment or new ProPresenter/Ableton feature is
included. Windows/external-projection acceptance remains deferred because no equipment is available.

## A: Service retirement

Baseline: latest `origin/main` `1a46b60329ebe00e5791cc8c3159b110f1f042c0`.
A dedicated isolated worktree rechecked all callers before removing these nine exclusive files:

- `src/renderer/src/pages/ServicePage.tsx`
- `src/renderer/src/components/Control/Service/ServiceWorkspace.tsx`
- `src/renderer/src/components/Control/Service/__tests__/ServiceWorkspace.test.tsx`
- `src/renderer/src/stores/service-playlist.ts`
- `src/renderer/src/stores/__tests__/service-playlist.test.ts`
- `src/renderer/src/lib/service-cue-runner.ts`
- `src/renderer/src/lib/bible-service-cue.ts`
- `src/renderer/src/lib/__tests__/service-cue-runner.test.ts`
- `src/renderer/src/lib/__tests__/bible-service-cue.test.ts`

Their only callers were within this retired cluster. The unused `isServiceRoute` predicate and
exclusive `nav.service` / `service.*` entries in all three locales are removed. `/service` and
`/soundboard` still redirect to Timer. Existing Sidebar, Preferences and Bible-menu negative
contracts remain. Shared projection actions/coordinator, Timer, media/audio, storage/sync,
File Explorer and package/lock contracts are unchanged by A.

`hhc-service-playlist` becomes dormant: no startup hydration, mutation or removal. No schema,
IndexedDB, blob, cloud link or asset deletion is introduced. A behavior test seeds valid and missing
cue references plus a real shared PNG blob; Browser and Electron use the same contract to check
startup/reload, legacy redirects, no retired-key reads/writes, byte preservation and no new live
window. Explicit Clear All still removes dormant Service and Soundboard keys using the existing
site-data operation. Preserving a key does not recover references to assets deleted later by users.

The before-change focused baseline passed 11 suites / 114 cases. Removing the four exclusive
Service suites is intentional; their old feature assertions no longer apply. Remaining production
behavior and retirement compatibility receive separate coverage.

Local gates on A:

- `npx vitest run --maxWorkers=2`: 343 suites / 4,153 cases passed.
- `npm run lint`: no errors; one inherited unused-disable warning in FolderBrowser.
- `npm run build` and `npm run build:web`: passed, including node/web/E2E typechecks and
  unchanged bundle budgets (precache 2.87/5 MiB, fonts 8.41/10 MiB, largest JS 1.15/2.25 MiB).
- Genuine macOS arm64 Electron source retirement smoke: 1 passed, zero retries, fresh profile.
  Two initial test failures were fixed without product changes: canonicalize macOS path aliases
  before verifying profile isolation, and select the unique accessible file button.
- One independent Codex advisor completed a read-only review of the actual source/test/docs diff;
  no Critical or Important findings. The advisor did not run tests or validate hardware.

Browser smoke: 14 cases passed in 21.4 seconds, zero retries, covering retirement compatibility,
real Bible/Timer Workers, Browser projection, PPTX/editable-page projection/navigation/edit/save
and media controls. Additional Electron source smoke passed all 6 selected cases with zero retries:
retirement, account retry, recovery/projection lifecycle, native document storage, 22-slide PPTX
edit/F5/save/reopen and end-screen window reuse. The native VLC production matrix was not run.

[PR #175](https://github.com/rayselfs/hhc-presenter/pull/175) merged after Quality Gates
[39048717176](https://github.com/rayselfs/hhc-presenter/actions/runs/39048717176) and Azure
[39048717203](https://github.com/rayselfs/hhc-presenter/actions/runs/39048717203) succeeded.
Both CI unit runs passed 343 suites / 4,152 cases, with the existing macOS-only development-bundle
case skipped on Linux (it passed locally on macOS). Quality Gates Browser E2E passed all 89 cases
on the first attempt; Azure hosted-artifact validation passed. Only the automatic PR preview was
published. Tested head `3607ebce5048062e1cf4d4daccec27a48997d2f3` and merged main
`f5ae80c8a840faf4c4eb5078cd83a78d96a98f12` have the same tree
`793890f369ce0beda88f11d4cac4a469095f0bab`.

## B: Soundboard and MIDI retirement

Baseline: accepted A merge `f5ae80c8a840faf4c4eb5078cd83a78d96a98f12`, in a second isolated
worktree. Fresh caller checks confirmed these nineteen files are exclusive:

- `src/renderer/src/components/Control/Soundboard/SoundboardGrid.tsx`
- `src/renderer/src/components/Control/Soundboard/SoundboardInspector.tsx`
- `src/renderer/src/components/Control/Soundboard/SoundboardLibrary.tsx`
- `src/renderer/src/components/Control/Soundboard/SoundboardMixer.tsx`
- `src/renderer/src/components/Control/Soundboard/SoundboardPageContent.tsx`
- `src/renderer/src/components/Control/Soundboard/SoundboardTopBar.tsx`
- `src/renderer/src/components/Control/Soundboard/__tests__/SoundboardAssignment.test.tsx`
- `src/renderer/src/components/Control/Soundboard/__tests__/SoundboardGrid.test.tsx`
- `src/renderer/src/components/Control/Soundboard/__tests__/SoundboardMixer.test.tsx`
- `src/renderer/src/lib/__tests__/soundboard-audio.test.ts`
- `src/renderer/src/lib/__tests__/soundboard-midi.test.ts`
- `src/renderer/src/lib/soundboard-audio.ts`
- `src/renderer/src/lib/soundboard-midi.ts`
- `src/renderer/src/pages/SoundboardPage.tsx`
- `src/renderer/src/stores/__tests__/soundboard-assets.test.ts`
- `src/renderer/src/stores/__tests__/soundboard-scenes.test.ts`
- `src/renderer/src/stores/__tests__/soundboard.test.ts`
- `src/renderer/src/stores/soundboard.ts`
- `src/renderer/src/types/soundboard.ts`

FilesPage no longer imports the Soundboard store or queries pads before deletion. The two
exclusive helpers `collectDeletedFileIds` / `countDeletedSoundboardPadUsages`, unused database
import, obsolete test mock, `nav.soundboard` and pad-delete translation in all three locales are
removed. Normal delete confirmation and the existing awaited store commands remain.

Fresh evidence changes one helper decision from the original plan: **retain `isInsideAnyFolder`**.
It now also guards folder paste into itself/descendants; deleting it would regress a previously
merged safety repair. Its implementation, `FolderRecord`, sync-root unlink, source permissions,
selection/error handling, shared audio classification/upload/playback, storage/sync/purge,
Recovery and projection/Timer/PPT behavior are preserved. Package and lock files are unchanged.
The historical M7 and Soundboard design documents are retained and labeled retired.

Before deletion, 9 focused suites / 133 cases passed. The expanded Browser contract then failed
on the genuine existing `get:hhc-soundboard` access when opening FilesPage. That is the expected
pre-retirement behavior, not a sandbox/private-dependency failure. The fixture includes valid
and missing pad references, a real PCM WAV and a shared PNG. It now checks both dormant keys,
shared bytes, legacy routes, no startup window creation, and normal audio-folder delete/cancel
with soft-deleted content still available in Trash. Clear All keeps its original full-clear contract.
Eight added FilesPage cases protect ordinary file/folder cancel, failure, success and read-only
sync descendants; existing sync-root and self-copy tests remain. The focused FilesPage suite
passed 23 cases.

B local gates:

- Full unit suite: 335 suites / 4,149 cases passed. The eight removed suites test only the retired
  implementation; eight new cases protect the surviving FilesPage caller.
- Lint: no errors; the same inherited FolderBrowser unused-disable warning remains.
- `npm run build` and `npm run build:web`: passed, including all three typecheck targets and
  unchanged budgets (precache 2.86/5 MiB, fonts 8.41/10 MiB, largest JS 1.15/2.25 MiB).
- Browser smoke: 18 passed in 39.5 seconds, zero retries, including the expanded retirement
  contract, PPTX/editable documents, Bible/Timer Workers, projection, sync-copy and durable
  trash/delete/restore behavior.
- Genuine macOS arm64 Electron source smoke: all 6 selected cases passed in 17.7 seconds,
  zero retries, including the expanded retirement contract. No new packaged/VLC result is claimed.
- One independent read-only Codex advisor reviewed B's actual diff; no Critical/Important findings.
  It confirmed the retained paste guard and ordinary deletion/source-permission boundaries.
- Shared source/package bytes, primary WIP hashes and new document links were checked separately.

Remote PR CI must pass at the submitted B head before merge. Its exact outcome belongs to the
PR checks; no release, Windows/external-display or live-account acceptance is implied.

## Acceptance boundaries

Browser protocol/UI coverage, Electron source smoke, a genuine packaged artifact and physical
output acceptance are distinct. A source-mode executable wrapper is not a newly built package.
Dedicated live cloud/two-client accounts, Windows/DPI/fonts/external displays, actual capture
permissions and real LAN-phone operation remain manual acceptance tasks. Synthetic profiles are
used for data and Clear All tests; user data is never used for destructive acceptance.
