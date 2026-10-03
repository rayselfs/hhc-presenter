# Presenter controls and unsaved copies implementation plan

> Execute inline using executing-plans; the user approved the design and implementation in chat.

**Goal:** Implement approved items 1–7. Item 8 and all VLC behavior are excluded.
**Architecture:** Keep existing controls and save coordinator. Place FAB inside the content area. Use responsive panel sizing. Store unsaved converted presentations separately from the file catalog, preserving recovery snapshots until a writable destination is committed.
**Tech Stack:** React, TypeScript, HeroUI v3, Zustand, IndexedDB, Vitest, Playwright.
**Spec:** Approved conversation on 2026-10-03.

## Constraints
- Electron and browser parity; preserve projection ownership and normal autosave.
- No dependencies; never write editable copies into readonly sync/share folders.
- Drafts are not listed in multimedia, synchronized, or expired automatically.
- Save cancellation/failure preserves draft; explicit discard removes it; recovery survives restart.
- No merge or release in this implementation task.

## Tasks
- [x] UI: Shell owns FAB; centered red camera start; accessible lock/reset icons and guarded confirmation; 48–64px media controls with height-constrained preview. Test reset confirmation and compact layout.
- [x] Persistence: Add draft store and source lookup; convert readonly copies to drafts; validate writable destinations at commit; recover snapshots and atomically promote local drafts. Test catalog isolation, stale revision, discard, invalid destination, save failure and successful promotion.
- [x] Integration: Route/header/registry support drafts, Save dialog and close decision, recovery entry. Test save cancel, close clean-but-unsaved draft, projection snapshot and account boundaries.
- [x] Verify: targeted tests, lint, full suite, build and browser layout smoke; review diff and commit UI separately from storage.

## Review focus
- Draft stays unsaved even when recovery snapshot is durable.
- Changing source/account cannot disclose or destroy another owner's recovery data.
- Switching to projection must not force Save As or discard active draft.
- In-flight saves must finish before promotion/discard.
- Destination can disappear or become readonly after dialog opens.

## Progress
- Worktree created from origin/main f46b32ab; original checkout preserved.
- Combined implementation passed lint, build, 283 Vitest files (3271 tests at the full-suite checkpoint), targeted follow-up tests and two review passes.
- Browser smoke passed camera confirmation, unsaved-copy recovery/projection/save cancellation/save completion, and layouts at 1920×1080, 1366×768, 1024×768 and 910×512.
- Shared confirmation-dialog shortcut guard is committed separately; UI and draft changes are split into main-targeted PRs.
- Windows physical-device validation, merge and release remain outside this task.
