# Strong-noise quiet-negation checkpoint

Decision: retain the previous default behavior and keep this acoustic ambiguity guard experimental. It blocks the observed false candidates, but does not recover all positive commands. Do not enable automatic noisy-room navigation on this evidence. English and private recordings remain unchanged.

## Method and results

Same local M4 / 24 GB, Chinese Turbo Q5_0, fixed synthetic source recordings and seeded stationary mixtures as the preceding noise report. Source hashes are checked. Strong profiles: broadband 20 dB and hum 10 dB. The quiet prefix has 2% of the later command amplitude. These are simulated conditions, not verified live-room recordings.

| Experiment | Positive locations | Wrong candidates | Interpretation |
| --- | --- | --- | --- |
| Previous strong gain-only baseline, 52 cases | 30/32 | 4 | Historical comparison |
| Fresh spectral suppression + gain, 52 cases | 27/32 | 4 | Rejected: loses more correct results |
| Fresh strong held-out challenge, 32 cases | 6/8 | 2 | Additional speakers/pause patterns; safety still fails without guard |
| Acoustic guard replay over both strong sets, 84 cases | 36/40 | 0 | Blocks observed errors; four existing refusals remain |
| Acoustic guard replay over prior light sets, 84 cases | 40/40 | 0 | No additional lost correct results |

The guard uses waveform evidence only: supplied one-second noise-only calibration, frequency power ratios, and two adjacent elevated windows before the clear command. It never reads the expected verse, transcript or label. It identifies ambiguity, not negation. Eleven of 168 cached decisions are inhibited, including all six observed wrong candidates; five were already rejected. These guard results replay actual cached ASR decisions, not 168 fresh inference runs or UI tests.

The threshold was developed on the initial set and frozen before the additional 32 strong challenge inferences. It still misses two quiet-prefix acoustic cases in that additional set; those happen to be refused by ASR. Therefore zero observed wrong candidates is not proof of reliable quiet-word detection. Benign quiet introductions, quiet trailing words, changing noise, and overlapping speakers remain material risks. A unit test deliberately shows that a quiet nonverbal tone also triggers ambiguity; it is not a speech classifier.

## Recovery and latency

A separate six-decode diagnostic compared context 768, sample-covering 512, and full context on the two original failed command mixtures. All six still refuse: the command prefix is transcribed as `请三个`, with additional structural-word errors. No retry path or parser exception is adopted. Processing spans 356–2245 ms, excluding endpoint and display; these values are not end-to-end latency. Retrying would add work without recovering these examples.

The additional strong challenge also loses two previously correct positive cases. The aggregate strong guard replay therefore retains 36/40 positives (90%), below the prior correct set and the quality target. The earlier light-noise Electron results do not establish strong-noise latency. No new Electron last-syllable-to-visible-verse test was run because this candidate fails the positive-location gate. The three-second requirement remains open.

## Retained scope and checks

Only diagnostic scripts, guard unit tests, report and synthetic evidence were added. No application source, native runtime default, English setting, projection behavior or private recording was changed. Guard requires explicit known noise-only calibration and is not wired to microphone capture. Default behavior remains the prior checkpoint.

34 Python tests pass, including calibration, invalid PCM, pure noise, silence and ambiguity cases. No new remote CI, merge, package, tag or release. Next step: improve acoustic evidence with benign quiet-prefix and trailing-negation controls before considering runtime integration; do not loosen citation parsing to compensate for missing words.

Evidence: `evidence/chinese-quiet-negation-20261102/`. Reproduce fresh challenge with `noisy_endpoint.py DATA OUT --agc --holdout`; diagnostic context comparison with `strong_context_screen.py DATA OUT`; replay with `strong_guard_screen.py DATA OUT`. Set `HHC_SPEECH_NODE` to the local Node executable for inference.
