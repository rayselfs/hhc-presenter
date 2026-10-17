# R6 Timer runtime authority decisions

Status: implementation of the existing improvement audit is under validation. The separately reviewed command parser, finite-settings guard and pure time rules are merged prerequisites. No ProPresenter feature, new Timer mode or user-facing option is included.

## Evidence recorded before implementation

- TimerEngineContext ignores adapter tick values and calls renderer stores with Date.now(). React status effects then infer commands for another runtime.
- Renderer timer owns targetEndTime; main TimerService and Browser Worker maintain independent deadlines. Issue 9's heartbeat fix is merged, but does not complete R6.
- Renderer countdown stops at zero, retains phase overtime and displays zero. Main service can continue overtime; its formatter and start/setDuration behavior also differ. Stopwatch has separate renderer/main anchors.
- LAN timer commands go straight to main while the LAN snapshot reads renderer state. A successful command can therefore leave the operator and remote snapshot stale.
- Timer preferences persist separately from runtime. Timer navigation's deliberate projection-reclaim rule remains unchanged.

## Decisions

1. A small shared runtime owns countdown and stopwatch state and calls injected `nowMs`. Main and Worker own runtime instances and scheduling. The runtime imports no React, Zustand, Electron, DOM or provider modules. The already reviewed pure deadline/phase/progress rules remain shared. No global engine, renderer fallback engine or parallel renderer deadline is retained.
2. Renderer keeps useTimerStore/useStopwatchStore facades, preference persistence, presets and projection presentation selectors. Their actions dispatch explicit typed commands. Only accepted host snapshots update runtime fields; TimerEngineContext owns the adapter/subscription lifecycle and never derives commands from status effects or calculates elapsed time.
3. Preserve the present operator behavior: ceil countdown seconds; existing hour/stopwatch formatting in presentation selectors; add/subtract reminder modes; paused adjustments; duration bounds; preset restrictions; clock-mode reset; zero stops the operator countdown with phase overtime and no forced continuing overtime. Characterize each difference before porting it. Main's legacy direct-IPC behavior must not silently become the operator contract.
4. Keep existing timer:command, timer:get-state, timer:initialize and timer-tick callers and fields valid. Use a separately typed runtime command/configuration entry point for the presenter facade, guarded by the same known-window checks and runtime validation. Keep legacy command normalization at ingress. Where legacy direct-main completion differs, preserve that existing behavior explicitly in its host compatibility path, without exposing a new UI setting. Both compatibility paths still use one host runtime, never two clocks.
5. Add a full typed runtime snapshot containing accepted configuration, countdown/stopwatch state and a monotonic host revision. Attach it additively to timer-tick and return it at runtime initialization; legacy tick fields remain. Worker uses the same shared command/snapshot types inside its transport envelopes. All private millisecond Worker callers migrate together to these typed envelopes; renderer-specific types never enter main.
6. Use monotonic time in each host. Inject the same fake-clock contract into both host tests. Renderer never converts wall-clock time into a deadline. Delay/background ticks read the current host clock rather than decrementing a counter. Wall-clock display is separate. Host clock units, second rounding and pause/resume precision are explicit characterization cases.
7. Commands and initialization are ordered on each adapter. Initialization must not reset a live main runtime on renderer reload. A snapshot revision rejects an older asynchronous initial response after a newer tick. Adapter generation/identity rejects late messages after cleanup; StrictMode creates disposable resources in effects. A newly created Browser Worker starts a new runtime lifetime, as on a page reload; no runtime persistence schema is added.
8. Route local controls, presets/reminder changes, stopwatch, media-presenter pause and LAN timer actions through the same presenter command path. Accepted main snapshots update renderer state, so LAN readback reflects the command. Preserve legacy API validation, permissions, projection ownership/reclaim, persisted preference names/version/migration and all existing wire field meanings.

## Compatibility and bootstrap details

- A new presenter start pins `stop-at-zero` to that run; a legacy start pins `continue-overtime` and retains its configured-duration restart semantics. Pause, resume and time adjustments through either ingress retain the current run's policy. Reset ends that run without choosing a future policy; the next start selects it. There is one deadline and run state. Legacy tick/get-state expose that actual state, with legacy formatting only at the presentation boundary. These policies are internal compatibility decisions, not new user modes.
- Accepted configuration is `{ settings: TimerSettings, reminderMode: 'subtract' | 'add' }`. The new typed bootstrap is separate from legacy initialize. Persisted renderer preferences seed only an uninitialized host; an initialized main host returns its accepted configuration and runtime without applying stale renderer preferences, including after renderer reload. Renderer adopts/persists accepted configuration without command echo. A fresh Browser Worker is seeded from preferences for its new lifetime. Legacy initialize retains its explicitly characterized compatibility behavior.
- Changing reminder mode while stopped recalculates remaining time. While running or paused, it preserves the deadline/remaining time and changes the progress denominator and the next reset/start total, matching the current operator behavior. Reminder mode is included in initialization, commands and snapshots rather than read implicitly from renderer settings by the host.
- A new runtime command returns a discriminated accepted/rejected result. Rejection covers invalid payload, unauthorized sender and unavailable initialization; it cannot be mistaken for the legacy void IPC success. An accepted result includes its full snapshot and host revision. Adapters order bootstrap and commands, apply that accepted frame unless a newer frame is already applied, and only then resolve. LAN gateway awaits that result; the LAN bridge publishes the resulting snapshot before acknowledging, so immediate renderer/HTTP readback includes at least the accepted host revision. Host revision is distinct from the existing LAN protocol revision.

## Reach and staging

- Shared runtime/types/parser and the existing pure time rules.
- Main TimerService/IPC validation, shared invoke contracts, preload API/types.
- Worker/adapter, TimerEngineContext, runtime/config/stopwatch facades and command callers.
- TimerProjectionBridge, LAN command gateway/snapshot and media-presenter pause.

First land the three existing reviewed prerequisites independently. Then implement one complete presenter command/snapshot path across both hosts; do not ship only a renderer half or replace tests with a fake engine. Keep the compatibility ingress and runtime transport explicit rather than adding generic mode/force flags to business actions.

## Acceptance before merge

- Same fake-clock host scenarios: start/pause/resume/reset, stopped/running/paused add/remove, reminder add/subtract and changes during a run, zero, stopwatch, delayed/background tick and non-finite input rejection.
- Mixed-ingress completion policy: presenter start followed by legacy pause/resume/adjust, reset then legacy start, and the reverse direction; all retain one actual run state. Stale preference hydration cannot reset an initialized main host. Reminder-mode changes while running/paused preserve remaining time.
- Accepted/rejected command results, delayed bootstrap responses and immediate LAN read-after-write at or above the accepted host revision.
- Production facade → real adapter → real Worker/TimerService contracts. A LAN command must reach the same state consumed by the operator and projection bridge.
- No command echo from applying a snapshot; no deadline calculation in renderer; no duplicate commands under StrictMode; stale initial snapshot/old adapter messages cannot overwrite current state.
- Preserve legacy timer ingress tests, preference migrations, countdown formatting and operator zero behavior. Any genuinely conflicting legacy expectation is documented and resolved at compatibility ingress rather than hidden by changing assertions.
- Full unit suite, lint, node/web/E2E typechecks, default/web builds and budgets; real Browser Worker/UI smoke and real Electron source Timer/LAN smoke. Packaged Windows/projector/device acceptance remains separate. No tags, releases or manual deployment.
