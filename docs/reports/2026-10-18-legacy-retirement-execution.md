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
and media controls. Remote PR gates are recorded in the PR checks after their actual completion;
no future CI or device result is assumed.

## B: Soundboard and MIDI retirement

Not implemented in A. Start from the accepted A merge, recheck the nineteen exclusive files,
FilesPage helpers/callers, translations and fixtures. Preserve shared audio classification,
upload/preview/playback, FolderRecord sharing/sync uses, source permissions, delete/cancel,
trash/purge, Recovery, native media and both route redirects. Keep `hhc-soundboard` dormant,
without a migration or automatic legacy import. Run and independently review B's own gates.

## Acceptance boundaries

Browser protocol/UI coverage, Electron source smoke, a genuine packaged artifact and physical
output acceptance are distinct. A source-mode executable wrapper is not a newly built package.
Dedicated live cloud/two-client accounts, Windows/DPI/fonts/external displays, actual capture
permissions and real LAN-phone operation remain manual acceptance tasks. Synthetic profiles are
used for data and Clear All tests; user data is never used for destructive acceptance.
