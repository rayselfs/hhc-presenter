# Capture header modes and lyrics GPU validation

## Behavior

- Header: lyrics switch on the left, source selectors centered, explicit projection takeover/stop on the right. Switching modes alone does not change projection ownership.
- Raw mode retains its preview, X/Y/width, lock and reset controls. Lyrics mode shows subtitle preview and recognition controls. Switching back preserves raw framing and lock.
- Default crop is the upper 40% (`x=0, y=0, width=1, height=0.4`); all four crop fields remain editable. Cropping must still include every source row.
- The pinned SDK chooses WebGPU when available, falling back to WASM during initialization. An inference/worker failure is retried once using a fresh CPU worker. Disabling or cancelling a session cannot revive a worker.
- No new dependencies, models, cloud OCR, confidence changes, one-frame acceptance, or release changes.

## Local measurements (Apple M4, macOS)

All end-to-end measurements use the existing 30-change, two/three-row Traditional Chinese corpus on black, dark-photo and bright-photo backgrounds. They include source drawing, capture, OCR, the unchanged two-observation gate, and preview polling at 100 ms. These are controlled fixture measurements, not real capture-card or arbitrary moving-background acceptance.

| Run                                       | Correct changes | Median   | P95      |
| ----------------------------------------- | --------------- | -------- | -------- |
| Base `4c8a1250`, Electron, CPU, upper 60% | 30/30           | 1,038 ms | 1,390 ms |
| New Electron, first successful run        | 30/30           | 379 ms   | 543 ms   |
| New Electron, retained-artifact run       | 30/30           | 420 ms   | 492 ms   |
| New hosted Chromium                       | 30/30           | 322 ms   | 433 ms   |

Both new Electron and browser runs report `detProvider=webgpu` and `recProvider=webgpu`. The retained Electron run's first cold cue took 2,342 ms (model/session initialization alone: 1,123 ms); its subsecond P95 must not be read as a cold-start guarantee. Browser initialization was 1,846 ms.

A separate direct-worker comparison using the same images measured warm median inference of approximately 604 ms (CPU, 60%), 530 ms (CPU, 40%), 81 ms (GPU, 60%), and 70 ms (GPU, 40%). This exploratory comparison overlapped other local verification work; use the isolated end-to-end runs above for product latency claims.

## Validation

- Desktop and hosted builds, node/web/E2E types and bundle budgets pass.
- Lint has zero errors and the existing unrelated `FolderBrowser.tsx` unused-disable warning.
- Initial full unit run: 4,583 passed, one skipped, three 5-second timeouts in the unrelated PPTX export-source file during parallel build/test load. That complete file passes 27/27 in isolation. The full bounded-concurrency rerun (`--maxWorkers=2`) passes all 363 files: 4,586 passed, one existing skip.
- Sandboxed Electron OCR workflow passes, including projection, style overflow, manual correction, and return to raw video.
- Five browser camera workflows and the browser OCR workflow pass, including header non-overlap at 800/1280 px and projection takeover across navigation.
- Real CPU fallback recognition passes with `navigator.gpu` unavailable and both model providers verified as WASM. Its test blocks service workers so the injected unavailable-GPU condition cannot be bypassed by a cached worker. Production/offline coverage remains enabled in the normal OCR workflow.
- The accessible Switch input is visually hidden by HeroUI. E2E clicks the visible label and checks the input state instead of forcing clicks through the switch thumb.
- Independent code review found no actionable issue in the implementation and lifecycle tests.

## Remaining acceptance

CI at `86dfbaa6` passes all quality gates, including 363 unit files (4,585 passed, two existing skips), desktop/hosted builds, full browser regression (104 passed, three existing skips), Windows lyrics recognition and local speech runtime checks. Windows CI uses WASM for both models because the runner has no WebGPU adapter: Electron median/P95 867/1,231 ms; browser 861/1,210 ms. This validates CPU fallback, not physical GPU acceleration.

The target Windows machine exposed a non-fallback NVIDIA adapter in isolated Electron renderer/Worker checks, with RTX 4060 active. Actual OCR providers and same-machine latency were not measured before recording began. On 2026-11-07, Ray cancelled further automated target-machine testing and chose manual device acceptance; this is not a passed GPU/device gate. He accepted first-activation model/session initialization and authorized proceeding with version 2.8.2. Cleanup is limited to this run's disposable Windows testing resources; existing Presenter and OBS are preserved.

Release tracking: engineering issue #203 and PR #202. Version 2.8.2 changes only package metadata beyond the validated implementation. PR validation, merge, tag, draft package creation, publication and manual device acceptance remain separate evidence stages.
