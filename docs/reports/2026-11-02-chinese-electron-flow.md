# Chinese Turbo: actual Electron navigation pilot

## Scope and measurement

This checkpoint connects the retained Chinese Turbo Q5_0 / greedy / zh / no-prompt / ctx768 policy to the actual Electron Bible page. English settings and the legacy provider implementation remain unchanged. The pilot is available only in an unpackaged app with explicit developer runtime environment variables; this is not the final model installation or distribution experience.

The measured path is real-time synthetic WebAudio input → AudioWorklet → bounded IPC → resident native Turbo → resident scripture locator → Bible store navigation → rendered, visible target verse. Only the microphone device and Bible content download transport are replaced by deterministic local fixtures. Speech inference, IPC, navigation, rendering, and scrolling are real. No private recordings or AI-generated transcript labels are used.

The source AudioContext independently timestamps the last nonzero fixture sample. Elapsed time ends after two animation frames and confirmation that the actual target verse is visible in the Bible preview. Capture-clock offset is recorded separately. Model/index preparation is measured separately and must complete before listening starts. Results do not include physical microphone/driver latency, room noise, real speakers, Windows, or packaged runtime behavior.

## Retained safety policy

- Preserve every nonzero sample, including quiet prefixes and internal pauses. Trim only exterior exact digital zeros; bypass all-zero audio.
- Speculatively decode the complete retained buffer after 300 ms of exact-zero silence; publish only after 1,500 ms of silence. New speech invalidates the provisional candidate and retains the whole utterance. Do not shorten utterances into independently navigable fragments.
- Reject overlong input as a whole at 30 seconds. Manual finish flushes the final AudioWorklet packet before decoding.
- Prewarm the model and character/phonetic indexes before microphone capture. One request in flight; session tokens invalidate cancelled or expired results.
- Stop capture on unmount, version changes, manual passage navigation, search edits, processor errors, and explicit stop. A stale startup cannot reopen the microphone.
- Navigate only the operator preview; this pilot never starts projection.

`shortcut: Exact-zero endpointing is a deterministic fixture policy, not a room-noise VAD. Replace it only after quiet-prefix/negation and human-audio regression acceptance. Continuous background noise currently requires manual finish.`

## Evidence and limitations

Results are being recorded in the accompanying evidence directory. The first 40-case run retained all 22 correct model destinations and rejected all 18 negatives, but one destination did not pass the strict rendered-visibility check within three seconds. This failure is retained rather than omitted from the results. The same two long quotations passed in isolation, and a second unchanged 40-case run passed. The precise browser scheduling cause was not established. The pilot now checks actual visibility and performs one immediate container scroll if the normal asynchronous preview scroll has not reached the target, then verifies again; it never treats a correct model destination alone as a successful screen result. Final measurements and an injected scroll-failure regression are recorded below.

The selected flow cases test retention and navigation safety, not population accuracy. They cannot replace the broader Chinese reference result of 212/292, the 98% goal, or human verification. A 1.5-second pause can still precede a later correction in natural speech; passing these fixtures does not establish continuous-sermon false-positive performance.

Production gates still include automatic model installation, a packaged native runtime, cloud-provider removal, browser on-device capability handling, language selection UX, human labels, Windows hardware, long-running/noisy-room tests, and projection/keyboard ownership acceptance. No merge, tag, or release is implied by this pilot.

## Final 56-case result

Hardware: Apple M4, 24 GiB, Metal, four ASR threads. Model/index readiness took **5.923 seconds** before microphone capture. This startup cost is separate from last-syllable latency.

| Measure                                                                   | Result                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Previously correct destinations retained                                  | **22/22**                                                           |
| Previously refused positive cases                                         | **2/8 now correct; 6/8 still refused**                              |
| Negative/non-reference controls                                           | **26/26 rejected; no navigation**                                   |
| Total positive localization                                               | **24/30** (selected retention/refusal set, not population accuracy) |
| New wrong destinations / lost prior correct destinations                  | **0 / 0**                                                           |
| Located cases: last source sample to visible target, P50 / P95 / maximum  | **1.520 / 1.819 / 1.937 seconds**                                   |
| All decisions including rejection: P50 / P95 / maximum                    | **1.512 / 1.807 / 1.937 seconds**                                   |
| Outcomes over three seconds                                               | **0/56**                                                            |
| Capture clock versus independent source clock                             | **+9.7 to +23.7 ms**                                                |
| Stop cancels late result / capture tracks end / projection windows opened | **pass / pass / 0**                                                 |

Percentiles use nearest rank. Only positive, visibly located cases enter the localization-latency row; fast rejections do not inflate that statistic. The two recovered cases (`0017`, `0033`) had changed ASR transcripts in the live capture path; no confidence threshold was relaxed. Treat them as observations requiring repeated broader ASR evaluation, not an established accuracy improvement.

The 56 cases comprise 24 segmentation challenges, 12 previously correct references, four long quotations, eight previously refused references, and eight additional negative reference-format controls. The [prior segmentation report](2026-11-02-chinese-segmentation-latency.md) retains the full corpus result of 212/292 Chinese references; this selected set does not replace it. The resident locator separately reproduced **all 505 previous transcript decisions exactly**.

## Render recovery and lifecycle regression

A separate run suppressed the first two preview scroll requests and selected a verse far enough down the chapter to require scrolling. The corrective branch executed and the actual verse became visible in **2.020 seconds**. Stop still ignored late work, microphone tracks ended, and no projection window was opened. The first fault-injection attempt used verse 3, which was already visible; its assertion correctly reported that recovery had not been exercised. That harness precondition failure is retained alongside the successful distant-verse run, not counted as a model error.

The committed evidence directory retains the first 40-case visibility failure, the unchanged successful repeat, the final 56-case run, the fault-injection attempts, and the 505-transcript parity result. `final-code-sha256.json` records the source and built main/preload hashes at the start of the 56-case run; the harness subsequently gained the optional scroll-fault mode. No speech/runtime/UI source changed after that timed run began.

## Validation and delivery state

- Desktop build and final Electron runtime build: passed. Website build, all TypeScript checks and bundle budgets: passed.
- Full unit suite: **361 files / 4,652 tests passed**. Final affected suite after the render correction: **5 files / 12 tests passed**, plus real Electron recovery testing.
- Browser E2E: **103 passed, 3 skipped, 0 failed**. The three skips require a separately supplied packaged Electron executable for presentation/PPTX acceptance; they are not claimed as passed.
- Lint: zero errors; one existing unused-disable warning in unrelated `FolderBrowser.tsx`.
- No remaining native pilot/locator process after the test apps closed. All timed runs completed before build/browser load testing.
- Local checkpoint only. Remote CI, packaged/runtime distribution, merge, tag and release have not been performed.

## Reproduction

Use the existing local Phase 0 data directory, containing the pinned model, CUV source, benchmark WAVs and Python virtual environment. In the isolated worktree:

```sh
npm run build
node scripts/speech-benchmark/electron-flow.mjs "$speech_data" "$speech_output" --all
node scripts/speech-benchmark/electron-flow.mjs "$speech_data" "$speech_recovery_output" --scroll-recovery
HHC_SPEECH_NODE="$(command -v node)" "$speech_data/venv/bin/python" scripts/speech-benchmark/live_locator_parity.py "$speech_data"
```

The harness creates and removes its own temporary Electron profile. It does not touch the operator's profile. It verifies WAV checksums, records decisions before judging the run, rejects new wrong navigation/lost prior correct results/over-three-second outcomes, verifies capture shutdown and ignored late results, and asserts that no projection window was opened. Timing runs execute serially, without concurrent builds or other model inference.

To inspect the pilot interactively, launch the unpackaged Electron app with `HHC_SPEECH_DATA`, `HHC_SPEECH_PYTHON`, and `HHC_SPEECH_NODE` supplied by the developer. These paths are pilot configuration only; they are not the proposed customer workflow. Packaged builds cannot enable this pilot.
