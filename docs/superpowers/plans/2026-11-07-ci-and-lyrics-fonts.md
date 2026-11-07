# CI and lyrics typography implementation record

Engineering issue: #204. Version: 2.8.3.

## Completed scope

- Shared typography validation, persistent bold/crop migration and font-loading synchronization.
- Automatic/searchable local fonts, bundled choices, live crop controls and reusable HeroUI controls.
- Original source/crop preview and explicit red camera projection action; global header open/close behavior.
- Parallel CI/release jobs, shared verified model artifact, PR cancellation and scoped speech checks.

## Local verification

Initial complete regression: 365 Vitest files, 4,594 passing tests and one existing skip; Chromium 104 passes and three existing skips with two workers and zero retries. Later projection/preview corrections passed 111 focused tests. Final component changes passed 16 focused tests, one native Electron OCR workflow and seven browser camera/lyrics workflows. Both live OCR suites cover 30 cue changes; browser coverage includes CPU fallback.

Desktop/web builds, node/web/E2E typechecks, bundle budgets and workflow validation passed. Lint has zero errors and one inherited FolderBrowser warning. Light/dark font popovers were visually verified as opaque. Local UI review was accepted and push, merge and release 2.8.3 were explicitly authorized.

Remote CI, publication and deployed smoke evidence will be recorded in the PR/engineering issue. Physical Windows and projection hardware were not retested for this revision.
