# Chinese stationary-noise endpoint experiments

## Decision

Retain the previously validated Chinese Turbo Electron pilot unchanged by default. English and private recordings are untouched. Bounded local volume balancing is promising for quiet, stationary noise; stronger noise still violates the no-new-wrong-navigation gate. Do not enable general noisy-room automatic following or advance production acceptance on these results.

The experiments live in benchmark scripts, behind explicit test flags. No renderer, preload, shared API, or production configuration changes are part of this checkpoint.

## Protocol

Apple M4 / 24 GiB, Metal, four ASR threads; same Chinese Turbo Q5_0, greedy, zh hint, no prompt and unchanged v3 locator/rejection rules. Synthetic Chinese fixtures retain their preassigned targets. No private recording, AI transcript label or English inference is used.

Noise is a reproducible broadband Gaussian proxy and a 60/120 Hz hum plus broadband component, not a recording of a particular fan or room. SNR is relative to each utterance's nonzero-sample RMS, not room dBA. Light noise uses 40 dB; stronger profiles use broadband 20 dB and hum 10 dB. The quiet-negation prefix is intentionally 2% of the later phrase's amplitude, so whole-utterance SNR does not describe the intelligibility of every word.

The candidate calibrates from a supplied one-second noise-only prefix, averages three 20 ms frame powers, and treats RMS above 1.15 times the floor as activity. It retains up to five seconds of preceding PCM and every internal sample, waits 1.5 seconds below the activity threshold, and then processes the whole retained turn. This is a stationary-noise prototype; calibration contaminated by speech, changing noise, music and competing speakers are not accepted.

Offline paired comparisons run full noisy utterances and detected-turn payloads through the same resident model. Their latency is **an estimate**: detector endpoint minus the last clean source sample, plus measured preprocessing, ASR and lookup. It excludes capture, IPC and screen rendering. Negative cases remain negative after adding noise; dropping a quiet negation is a failure, even if the complete noisy utterance also fails.

## Offline results

Each 52-case screen contains 32 positive instances and 20 negative instances across two noise profiles. The held-out screen contains eight positives and 24 negatives, including the second synthetic speaker and 1.2-second internal pauses. Held-out source utterances were not used to choose volume balancing. There are 408 experiment observations across 148 distinct noisy mixtures from 42 source utterances, not 396 independent recordings.

| Method                                 | Noise    | Positive correct | Wrong candidate cases | Estimated P95 / max | Over 3 s |
| -------------------------------------- | -------- | ---------------- | --------------------- | ------------------- | -------- |
| Calibrated endpoint, original PCM      | stronger | 28/32            | 4                     | 2.792 / 2.979 s     | 0        |
| Spectral reduction                     | stronger | 28/32            | 4                     | 2.796 / 3.049 s     | 2        |
| RNNoise `sh`                           | stronger | 27/32            | 4                     | 3.057 / 3.136 s     | 3        |
| Calibrated endpoint, original PCM      | light    | 32/32            | 4                     | 2.860 / 3.005 s     | 1        |
| Spectral reduction + bounded gain      | light    | 31/32            | 0                     | 3.198 / 3.437 s     | 4        |
| Bounded gain only                      | light    | **32/32**        | **0**                 | **2.766 / 2.948 s** | **0**    |
| Bounded gain only                      | stronger | 30/32            | **4**                 | 2.881 / 3.035 s     | 2        |
| Bounded gain only, held-out utterances | light    | **8/8**          | **0**                 | **2.156 / 2.167 s** | **0**    |

Bounded gain uses 100 ms blocks with interpolated gain, a maximum 10x increase and a peak limiter. It preserves sample count and timing. Unlike aggressive denoising, it does not remove low-energy bins. The light-noise screen plus holdout retained **40/40 positive locations and rejected 44/44 negatives**. An additional 12 light-noise probes attenuated the **trailing** negative phrase to 2% of its original amplitude (two voices, three pause lengths, two noise profiles). All 12 remained safely rejected. Thus the gain-only light-noise checks total 96 instances: 40 positive locations retained and 56 negatives rejected. Stronger noise still loses two positives and produces four wrong candidates; this is an explicit blocker, not an acceptable tradeoff.

Spectral reduction and RNNoise were not selected. The model's own complete-noisy-input control also loses the quiet negation in the failing cases, showing that a better endpoint alone does not restore the missing semantic cue. No book aliases, expected-answer prompts or confidence thresholds were added to make these examples pass.

## Actual Electron probe

A separate eight-case probe uses real-time PCM16 noisy playback, the actual AudioWorklet, native IPC, resident Turbo, unchanged locator, Bible navigation and visible-verse checks. Volume balancing executes inside the native worker and is included in elapsed time. The benchmark driver schedules the existing **Finish** action at the experimental detector's causal endpoint. This is an integration probe of the algorithm, **not a shipped autonomous noisy-room endpoint**. The detector uses noisy samples; clean source-end labels are used only for latency scoring.

The primary clock remains the independent source's last clean speech sample to visible target verse. The existing UI's last-nonzero-sample clock is unsuitable for continuous noise and is not used to score this probe. Every case starts after model readiness; setup time is separate. The final partial capture packet is flushed before native inference.

The first probe retained all four positive destinations and rejected all four negatives, but long quotations took **3.249 and 3.175 seconds**. Warming a full inference before readiness did not reliably help: the warm-up probe still exceeded the deadline, with a maximum **3.740 seconds**, and preparation increased from about 5.9 to 11.1 seconds. It is not selected.

The next experimental context setting keeps short inputs unchanged. For long input it allocates enough 20 ms audio tokens for **every input sample**, rounds up to 64-token blocks, and adds another 64-token margin; it uses full context when that would reach the model limit. This changes computation size, not the audio length. It remains behind a separate test flag and is not promoted to the normal Chinese policy without broader acceptance.

With bounded gain and the sample-covering context setting, the final eight-case Electron probe passed: four positive destinations retained, four negatives rejected, no wrong navigation and no over-three-second outcomes. Successfully located cases took **2.366–2.834 seconds**. Two additional long quotations, not used to choose the setting, also passed at **2.798 and 2.678 seconds**. Across these **10** integration cases, all six positive destinations and all four negative decisions were retained; the maximum was **2.834 seconds**. Preparation was approximately 5.9–7.0 seconds, separate from recognition latency.

The two additional cases cover the remaining long quotations above 14 seconds in the existing Chinese regression corpus. This is still a small synthetic integration sample; it does not establish an overall accuracy rate or a worst-case latency guarantee. In particular, the stronger-noise safety failures remain blockers even though the light-noise integration probe passed.

The default mode was then rerun with all noise flags off: both long quotations located correctly in **1.610 and 1.695 seconds**. Cancellation ignored late results, microphone tracks ended, and no projection window opened. Noise probes use explicit end-of-turn completion and therefore do not claim the default cancellation replay as newly tested in noise mode.

## Validation and retained changes

- **30 Python benchmark tests passed**, including deterministic noise, quiet-prefix retention, internal pauses, noise-only input, gain bounds and complete context coverage.
- **12 affected runtime/capture/lifecycle tests passed**; desktop build and changed-harness lint passed.
- The normal application source under `src/` is unchanged. Native-worker gain, covered-context and warm-up experiments are disabled unless their explicit benchmark environment flags are set. No new app dependency, language setting or confidence threshold was introduced.
- Full app/browser CI was not repeated for this benchmark-only checkpoint; remote CI, merge, tag and release were not performed. Evidence is retained locally for the next safety/acceptance iteration.

## Limits and next gate

- Stronger-noise automatic following is blocked by wrong candidates on quiet negation. Passing light-noise tests does not grant permission to relax this gate or exclude refusals from the accuracy denominator.
- Neither automatic calibration UX nor a robust changing-noise/competing-speech detector is delivered here. The benchmark driver is not a substitute for integrating and validating those behaviors.
- A five-second pre-roll and finite pause threshold cannot preserve arbitrarily long quiet context or anticipate a later correction. Long/noisy-room negative audio, microphone capture, human labels, Windows and packaged-runtime acceptance remain open.
- Keep manual operation and the previously retained runtime as the default. Continue with low-volume semantic safety and independent noise-level/speaker holdouts before enabling noisy-room automatic following.

## Reproduction and sources

Use the existing Phase 0 data directory and its Python environment. Run `noisy_endpoint.py DATA OUTPUT` with `--denoise`, `--rnnoise`, `--light`, `--agc`, `--holdout` and `--quiet-suffix` as recorded in each protocol. `noise_flow_fixtures.py DATA` exports the fixed Electron subset. Run `electron-flow.mjs DATA OUTPUT --noisy-probe --fit-noise`; add `--long-noise` for the independent long-quotation subset. `--warm-noise` reproduces the rejected warm-up experiment. Omit all noise flags for the unchanged default flow.

RNNoise experiments use the [model author's pinned `sh` model](https://github.com/GregorR/rnnoise-models/blob/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/somnolent-hogwash-2018-09-01/sh.rnnn) through the locally installed [FFmpeg `arnndn` filter](https://ffmpeg.org/ffmpeg-filters.html#arnndn). Model SHA256: `70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0`. It was downloaded for this local experiment only; packaging/distribution acceptance is not asserted. No new application dependency was installed.

Raw synthetic decisions, protocols and rejected runs are retained in [the evidence directory](evidence/chinese-noise-endpoint-20261102/). No private audio or transcript is included.
