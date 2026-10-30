# PR #96 staged integration — 2026-10-30

Engineering issue: [#185](https://github.com/rayselfs/hhc-presenter/issues/185).
Canonical Feature: [PRE-02](https://github.com/HallelujahHomeChurch/hhc-planning/issues/19).
Project: <https://github.com/orgs/HallelujahHomeChurch/projects/1>.
Run: `presenter-pr96-integration-20261030`, local macOS arm64.

## Source and boundaries

Original draft [#96](https://github.com/rayselfs/hhc-presenter/pull/96), source `4eaa86b45631b19f09a82df962afe830ba448e06`, contained 48 branch commits and 87 changed files. Integration began from main `933610e6b140ee30e2527f88b7343e740720e35a`. Original branch/worktree, primary-checkout planning WIP and unrelated worktrees are preserved.

The original source is split by responsibility. Main's extracted text DOM/protocol, element geometry, viewport, common converter, atomic creation, immutable image reuse and save/draft owner/revision guards remain authoritative. Tests are ported into the current split harnesses, rather than restoring obsolete monolithic test/setup code. No LOC reduction target or wholesale replacement is used.

| Slice              | PR                                                         | Resulting responsibility                                                                                        |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Environment repair | [#187](https://github.com/rayselfs/hhc-presenter/pull/187) | Pin supported Linux runner; recover a published website version from its explicit immutable tag                 |
| A                  | [#186](https://github.com/rayselfs/hhc-presenter/pull/186) | Outline width/noFill, embedded BMP, whitespace and inherited text styles, transparent geometry                  |
| B                  | [#188](https://github.com/rayselfs/hhc-presenter/pull/188) | Bounded schema2 source contract; ZIP/XML/CRC/hash/node ownership checks; atomic persistence and copy detachment |
| C                  | [#189](https://github.com/rayselfs/hhc-presenter/pull/189) | Native and explicit source-preserving PPTX export; notes and safe editor download lifecycle; MIT attribution    |
| D                  | [#190](https://github.com/rayselfs/hhc-presenter/pull/190) | Shared compatibility policy, typed located errors, soft breaks and notes; reject known lossy imports            |
| E                  | [#191](https://github.com/rayselfs/hhc-presenter/pull/191) | Explicit schema3 presets/adjustments; solid theme style resolution; thumbnail/projection/export parity          |
| F                  | Final snapping PR, linked from #185                        | Screen-space snapping and Alt bypass, near-top explicit XML frames, current reference/evidence reconciliation   |

Ordinary upload/create/edit-copy still writes schema1. Reading explicit schema2/3 is not a rollout of those formats. Companion Asset API #103 remains separate; no server schema migration, capability endpoint, default activation or ProPresenter feature is included. Unsupported content fails closed, retaining the original raw file and stored revision.

## Independent review and regressions

Each slice receives one independent read-only advisor. Findings are verified with failing regressions before correction:

- A: inherited transparent placeholder geometry retained; missing local line gets a visible fallback without overriding explicit zero/noFill.
- B: source validation occurs once on each relevant save/draft path; forged source identity cannot overwrite authoritative content.
- C: IME starting and ending while download is pending latches cancellation, even if composition ends before async work completes.
- D: picture effect graphs cannot disappear silently; final image/graph rejection produces typed diagnostics in all import/copy paths.
- E: inherited line width/noFill survives missing local line; unrepresented arrow round joins reject; malformed projection snapshots report render failure rather than throwing. Render validation strips non-rendering package/theme ownership metadata and keeps source-backed projection valid.
- F: no new important regression found by the advisor. Two existing interaction defects were reproduced (6 failures): group drag collapsed selection; image corner minima changed aspect ratio. The shared resize and selection paths now preserve ratio/opposite anchors and group preview/commit/cancel/undo; 78 focused follow-up cases pass. Explicit large/off-slide EMU coordinates are also covered.

CI also identified legacy test fixtures which omitted XML source nodes or removed package parts while retaining dangling relationships. Fixtures now describe valid package data so the original behavioral assertions remain meaningful; no production validation was relaxed.

## Validation evidence

PR checks are the immutable per-head merge gate. The following local checks supplement CI; historical test counts in imported design/readiness documents are explicitly marked historical.

| Slice | Local evidence                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | 78 focused cases; 5 Browser import/render/projection/navigation checks; lint/types/default/web builds and budgets                                                                                   |
| B     | 124 focused cases plus 28 save cases; 1 real Browser source/edit/copy/undo/projection/reopen flow; lint/types/builds                                                                                |
| C     | 102 focused cases; 5 Browser flows; separate macOS Electron download/projection smoke; lint/types/builds                                                                                            |
| D     | 228 focused cases; 4 Browser download/reopen/projection flows; lint/types/default/web builds                                                                                                        |
| E     | 283 focused cases plus 133 advisor cases; 5 Browser preset/theme/projection/export/reopen checks; 2 separate macOS Electron theme/preset/native+source checks; lint/types/builds                    |
| F     | 186 focused cases plus 78 advisor follow-up cases; real Browser group marquee/drag/Alt/snapping at 50% and 100%, one-step undo, save and reload passed; final full checks and CI linked from its PR |

Electron-only cases are explicitly skipped in Browser runs and executed separately with an isolated local Electron profile. No real account/library is used. The inherited FolderBrowser unused-disable warning and existing CSS/chunk notices are not represented as new product failures.

## Release and outstanding acceptance

Existing [v2.7.1](https://github.com/rayselfs/hhc-presenter/releases/tag/v2.7.1) was published separately under explicit authorization. Its tag/source `d2eaa508e80a71fb2d1e149db27ceae20d6b2bfb` and ten release assets remain unchanged. Checksums and updater manifest references were revalidated. Original cross-platform packaging/smoke run: `39117258017`.

The automatic website publication run `41036604315` failed because pinned Playwright did not support the newly selected Ubuntu 26.04 runner. Recovery uses #187's Ubuntu 24.04 workflow and checks out `refs/tags/v2.7.1`; run `41040009704`. Recovery completed successfully. Live index and main asset return HTTP 200; generated `index-DEbI_bLN.js` matches the immutable-tag build log (observed SHA256 `2a434c6955e9fb7a46d0416e5f763b73a95df3f687cc97ad1d8bf70f7a1820b0`). It does not deploy these PR #96 integration changes.

No new integration tag, package release or deployment is authorized by this merge series. Remaining acceptance: physical Windows installation/use, external projector/display scaling, real IME/fonts, Microsoft PowerPoint/Office roundtrip and live cloud schema capability. Automated CI and macOS source Electron smoke do not complete those gates. PRE-02 stays pending acceptance until the separate device/cloud evidence exists.
