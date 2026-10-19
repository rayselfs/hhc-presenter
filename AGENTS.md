# PROJECT KNOWLEDGE BASE

## OVERVIEW

Electron desktop app for church projection (`hhc-client`). React 19 + TypeScript + Vite via `electron-vite`. Dual-window architecture: main window (sidebar + pages) + projection window (fullscreen display). **Dual-mode**: runs in both Electron (IPC) and browser (BroadcastChannel/Web Worker) environments.

**Double-src nesting**: Renderer lives at `src/renderer/src/` — electron-vite default. The `@renderer` alias resolves here.

## WHERE TO LOOK

| Task | Location | Notes |
| ---- | -------- | ----- |
| Main process / window creation | `src/main/index.ts` + `windowManager.ts` | WindowManager singleton manages both windows |
| IPC handlers | `src/main/ipc/` | app.ts, bible-api.ts, projection.ts, timer.ts, validate.ts |
| Timer runtime authority | `src/shared/timer-runtime.ts` + `src/main/timerService.ts` | Main/Worker hosts share rules; renderer consumes accepted snapshots |
| Shared types & constants | `src/shared/` | IPC channels, projection messages, API paths, shared types |
| Expose API to renderer | `src/preload/index.ts` + `src/shared/presenter-api.ts` | contextBridge implementation satisfies PresenterApi; Window.api aliases it |
| UI / React components | `src/renderer/src/components/` | Control/ (domain panels), Common/ (reusable), Projection/ (display) |
| File Explorer | `src/renderer/src/pages/FilesPage.tsx` + `stores/file-explorer.ts` | File upload, folder CRUD, favorites, trash |
| Trash / deletion flow | `src/renderer/src/pages/TrashPage.tsx` + `lib/app-init.ts` | Soft-deleted items |
| Folder store base | `src/renderer/src/stores/folder.ts` | `createFolderStore` factory shared by File Explorer + Bible |
| Folder persistence adapters | `src/renderer/src/lib/folder-db.ts` | Typed Bible/Explorer adapters; retain their distinct deletion policies |
| Timer engine | `src/renderer/src/contexts/TimerEngineContext.tsx` | Owns adapter lifetime; accepted runtime snapshots update Zustand facades |
| Timer adapter (dual-mode) | `src/renderer/src/lib/timer-adapter.ts` | BrowserTimerAdapter (Worker) vs ElectronTimerAdapter (IPC) |
| Projection messaging | `src/renderer/src/lib/projection-adapter.ts` | Electron IPC or BroadcastChannel adapter |
| Environment detection | `src/renderer/src/lib/env.ts` | `isElectron()` / `isWeb()` — renderer only |
| State (Zustand) | `src/renderer/src/stores/` | timer, stopwatch, settings, bible, folder, update |
| Persist storage adapter | `src/renderer/src/lib/persist-storage.ts` | Shared `hhcPersistStorage` + `createPersistName()` |
| Theme system | `src/renderer/src/contexts/ThemeContext.tsx` | Dark/light/system, syncs with Electron nativeTheme |
| Routing | `src/renderer/src/router.tsx` | HashRouter; `/projection` is outside Layout |
| Keyboard shortcuts | `src/renderer/src/config/shortcuts.ts` + `lib/shortcut-registry.ts` | Centralized definitions + runtime registry |
| Path alias config | `electron.vite.config.ts` + `tsconfig.web.json` | Keep `@renderer` alias in sync between both |

## CONVENTIONS

### Code Style

- No semicolons, single quotes, print width 100, no trailing commas, 2-space indent
- Separate tsconfigs: `tsconfig.node.json` (main/preload) and `tsconfig.web.json` (renderer)
- Path alias: `@renderer/*` → `src/renderer/src/*`

### Git Workflow

- **Never commit directly to main** — always create a feature branch first
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/` prefix
- Conventional commits (`feat:`, `fix:`, `refactor:`, etc.), PR to main → CI must pass → merge

### Component Placement

- Domain-specific control UI → `components/Control/{Feature}/`
- Projection display → `components/Projection/{Feature}Projection.tsx`
- Reusable generic → `components/Common/`

## STATE MANAGEMENT

- **Context**: Non-serializable services only (adapters, window handles, DOM side-effects). Never plain business data.
- **Zustand**: Serializable app/domain state. If a context looks like plain state + setters, move it to Zustand.

### Zustand Persistence

Use `persist` middleware with shared adapter. Key rules:
- Always `hhcPersistStorage` — never call `localStorage` directly from stores
- Always `createPersistName('my-store')` — maintains `hhc-` prefix
- Always `partialize` — only persist config/preference fields, never runtime state
- Set `version: 0`, bump + add `migrate()` on schema changes

## DUAL-MODE ARCHITECTURE

Every feature must work in both Electron and browser.

| Adapter | Electron Mode | Browser Mode |
| ------- | ------------- | ------------ |
| `projection-adapter` | IPC via preload API | BroadcastChannel(`hhc-projection`) |
| `timer-adapter` | IPC via `window.api.timer` | Web Worker (`timer.worker.ts`) |

### Pitfalls

- **CSP only affects web mode**: When adding Workers/WebSockets/fetches — update CSP in `index.html` and test in browser.
- **StrictMode resource lifecycle**: Create disposable resources in `useEffect`, not `useState`. `BrowserAdapter.dispose()` terminates Worker (irreversible); `ElectronAdapter.dispose()` removes listeners (reversible).
- **Silent failures**: Browser-mode failures (CSP blocks, dead Workers) are silently swallowed. Always check browser DevTools.
- **Feature parity**: Test both `npm run dev` (Electron) AND `localhost:5173` (browser) when modifying adapters.

## CI / CD

| Workflow | File | Trigger | Steps |
| -------- | ---- | ------- | ----- |
| CI Quality Gates | `ci.yml` | PR → main | lint → node/web/E2E types → vitest → default/web build → Browser E2E |
| Azure Static Web Apps | `azure-static-web-apps-*.yml` | PR + published release | PR preview / production deploy after manual release publication |
| Build and Release | `build-release.yml` | tag `v*.*.*` | macOS (arm64) + Windows → draft GitHub Release |

## ANTI-PATTERNS

- No `as any`, no `@ts-expect-error`. Preload `@ts-ignore` on lines 19/21 is inherited scaffold — do not add more.
- No manual `localStorage` in Zustand stores — use `persist` with `hhcPersistStorage`.
- Keep `sandbox: true` in both BrowserWindow configurations; native access stays behind the preload bridge.
- Preserve the GitHub publish target in `electron-builder.yml`; packaging/release authorization is separate from PR CI.
- Preserve the distribution identity `tw.org.alive.presenter` in `electron-builder.yml`.

## PROJECT-SPECIFIC NOTES

- Use `electron-vite` CLI for dev/build (not raw Vite)
- `npm run typecheck` runs two separate `tsc` passes (node + web)
- HashRouter for Electron file:// compatibility
- **HeroUI v3** (react-aria-components based) — API differs from v2, check node_modules or use MCP
- No pre-commit hooks — lint/format are manual
- Vitest: jsdom environment, `globals: true`, run with `npx vitest run`
- **Projection owner rule**: Header/page navigation must not switch projection content just because the operator visits Bible or Media. Content switches only on explicit projection actions such as selecting a verse, presenting media, running a slide, or service cue. **Timer is the deliberate exception**: when projection is already open, navigating back to the Timer page may reclaim projection immediately so a countdown can keep showing while the operator searches Bible/media, and returning from Bible/media to Timer is one-step.
- **Projection fallback rule**: LAN remote blank control is removed. `DefaultProjection` is an internal fallback only: projection route has no content yet, web `window.close()` is blocked, or an invalid/no payload reaches projection. Do not expose blank as a user-facing projection mode.
- **Deletion flow — two paths**:
  - `useBibleFolderStore`: hard delete via `cleanupExpired()` on startup, no trash UI
  - `useFileExplorerStore`: soft-delete via `softDeleteExpired()` → trash → `purgeTrash()` after retention. Do **not** call `cleanupExpired()` here.
- **PresetChips right-click**: bypasses ContextMenu system intentionally — directly removes preset.

## COMMANDS

```bash
npm run dev              # Start electron-vite dev server with HMR
npm run build            # Typecheck + electron-vite build
npm run typecheck        # Run both node + web typechecks
npm run lint             # ESLint (cached)
npm run format           # Prettier --write .
npx vitest run           # Run all tests
npm run build:mac        # Build + package for macOS
npm run build:win        # Build + package for Windows
```

## Language

Respond in zh-TW (Traditional Chinese) when the user writes in Chinese.
Use English for all code, variable names, comments, and technical terms.

## Available Tools

- `squirrel` CLI is installed globally — use the `audit-website` skill for website auditing tasks.
- `codegraph` is available per-project — initialize with `codegraph init -i` when `.codegraph/` is missing.

## Coding Behavior (Always On)

1. **Think first**: Surface assumptions before implementing. Present interpretations — don't pick silently.
2. **Simplicity**: Minimum code to solve the problem. No speculative abstractions.
3. **Surgical**: Touch only what the request requires.
4. **Verify**: End every task with `lsp_diagnostics`, a build, or a passing test.

<!-- BEGIN HHC DELIVERY V1 -->
## HHC delivery coordination

Before retained implementation, use `.agents/skills/hhc-delivery/SKILL.md` and read the [pinned shared workflow](https://github.com/HallelujahHomeChurch/hhc-planning/blob/18710ef91f084b78a7d876a6ab37e35c2641b277/workflow/v1/WORKFLOW.md).
Reuse/create the owning-repository engineering issue, link its private canonical Feature and Project, verify current head/dependencies, and record coordinator acknowledgement plus run ID/environment/branch/HEAD. Read-only discovery needs no engineering ticket.
Assignees/comments/timeouts are not locks or takeover authority. Separate CI, merge, publication, deployment, flags and live/device acceptance; keep accepted Feature baselines visible and track improvements separately. Closed duplicates/cancellations are not delivery.
Project setup/linking is currently PENDING; do not expand OAuth permissions. Only this explicitly authorized documentation bootstrap may proceed with that pending state. External requests require Ray triage. Keep private/member/note content and raw sensitive evidence out of public repositories.
Preserve repository-specific rules. This adoption uses draft PRs and does not authorize engineering merge, deployment, permission changes or new full-suite CI.
<!-- END HHC DELIVERY V1 -->
