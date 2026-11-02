# Strong-noise final bounded experiment

Decision: close this optimization round as requested, retain the previous default behavior, and keep the new guard/retry/citation checks benchmark-only. This is not production acceptance. English and private recordings were not changed.

## Four failures explained

The four observations are three source utterances, not four different recordings:

| Source / mixture | Native transcript failure | Outcome |
| --- | --- | --- |
| 0001 / broadband 20 dB | `請三個` instead of the navigation command, plus a corrupted chapter marker | Raw audio, 120/200 Hz high-pass, and the previous context comparison do not recover it |
| 0001 / hum 10 dB | `請三個` instead of the navigation command | Same result; do not strip an arbitrary prefix to force a match |
| segment-012 / broadband 20 dB | `請三道` instead of the navigation command | Raw and both high-pass settings do not recover it |
| segment-016 / broadband 20 dB | `刷世紀` instead of the book name | Raw re-decode recovers the offline mixture, but not the captured Electron input |

Full noisy utterances and endpointed utterances both failed in the preceding evidence. The missing matches therefore are not explained by endpoint truncation alone. Paired preprocessing changes the fourth transcript; this does not establish that gain is the sole cause under live capture.

## Bounded retry and safety

Only short failed Chinese commands that still start with `請翻到`, contain chapter/verse markers, and contain no negation/example marker are eligible for one raw-audio retry. Existing successful matches are never retried. There is no citation grammar relaxation or answer-specific hint. The acoustic ambiguity guard still wins over retry.

Fresh native inference over the existing 168 mixtures retains 37/40 strong-noise positives versus the previous 36/40, and 40/40 light-noise positives. All 88 negative cases are rejected. The recovered offline case estimates 2724 ms from the clean source end through endpoint and processing; this is not display latency. The old 168-case set is regression data, not a new blind set.

The new normal-prefix set contains two synthetic voices, three benign introductions (`我們一起來看`, `接下來`, `弟兄姊妹`), two prefix gains (2% and 10%), and two strong-noise profiles: 24 mixtures. Results before the final citation gate:

- 18/24 cases trigger the acoustic guard; in six cases it suppresses an otherwise correct first-pass location.
- Only 1/24 locates correctly. One additional case incorrectly maps `十八世紀一章第一節` to Judges 1:1. This is a first-pass fuzzy-book failure, not a retry-created error.
- Three cases create two endpoint windows. The initial runner's single-window assertion aborted after the first three benign cases; all 24 were rerun with every emitted window scored. The failed partial run is retained separately.

A strict exact-pronunciation requirement removes that wrong mapping but loses seven strong and five light correct results; it is rejected. The retained, narrower experimental gate refuses fuzzy matching when a Chinese full book name starts with a number. Chinese full book names do not use a leading numeral; canonical numbered letters and English ordinals retain their existing rules. Assertions cover Genesis, 1 John, English 2nd John, negation, and numeric century phrases.

Replaying all 192 native transcript decisions with this final gate yields **37/40 strong positives, 40/40 light positives, 1/24 benign-prefix positives, and zero wrong destinations**. This replay adds no correct-location loss relative to the retry candidate, but it is not 192 fresh model runs. The guard still misses quiet acoustic evidence and cannot distinguish benign from negative meaning. Do not deploy it as automatic live speech detection.

## Actual Electron verification

The probe retains the supplied one-second noise-only calibration, runs real capture/IPC/native inference/lookup/preview, and scores from the known last source syllable to the rendered outcome. The driver schedules the existing Finish action from the stationary-noise endpoint; it is not a shipped automatic endpoint or calibration flow. No physical microphone or Windows acceptance is implied.

The initial six-case probe using the rejected exact-pronunciation gate fails retention. The recovered offline command is refused again (`請翻造…`) after actual capture. Rejected outcomes under three seconds are not successful navigation.

Final numeric-gate probe and default-mode verification are recorded in the evidence and completion note below. The overall feature remains blocked by the benign-prefix and real-flow retention failures, regardless of a fast successful control.

## Scope and reproducibility

Changes are confined to benchmark scripts, opt-in native benchmark flags, tests, this report, and the plan. Normal app defaults and English remain unchanged. `HHC_SPEECH_STRONG_PROBE=1` is a fixture-only mode requiring a supplied noise-only prefix; never enable it for normal microphones. No new dependencies or cloud speech services.

Use `strong_final.py DATA OUT` for fresh paired inference, `--benign-only` for the new controls, `strong_rescore.py DATA OUT` for transcript replay, and `strong_flow_fixtures.py DATA` followed by `electron-flow.mjs DATA OUT --strong-probe` for integration. `HHC_SPEECH_NODE` must point to local Node for Python inference. The final runner includes the numeric gate; retained earlier evidence explicitly separates ungated model decisions from final replay. Fixed source hashes, seeds, profiles and synthetic expected references are retained.

Remaining: human labels, Windows, real noise/calibration, benign-prefix retention, robust end-to-end <=3 s, and the broader production provisioning/CI/merge gates. No merge, tag, release or deployment is authorized by these failed acceptance results.

## Completion evidence

- Final strong numeric-gate Electron probe: seven planned cases, six completed traces, one capture timeout. Completed traces contain one correct control at 2057 ms, zero wrong/unexpected navigation, and five refusals. The failed recovery is refused at 2844 ms. Two completed benign-prefix cases are incorrectly refused. The seventh case produces no trace and the UI reports no captured speech; do not count it as a successful rejection. Root cause of that capture miss was not established in this bounded round. The integration gate fails.
- 36 Python tests, eight affected TypeScript runtime/capture/session tests, changed JavaScript lint, and desktop build (including all typechecks and bundle budget) pass. No remote CI or new full browser suite was run for these benchmark-only changes.
- Evidence is in `evidence/chinese-strong-closeout-20261102/`, including failed gates. The initial partial 171-result screen contains the 168 completed regression observations plus three benign observations before the multi-window assertion; use the separate complete 24-case benign rerun for totals. Do not add those duplicated observations to the 192-case aggregate.
- The observed improvement is bounded offline recovery plus a narrower numeric-book safety check. Actual automatic navigation under strong noise is not accepted. Keep default behavior and manual operation; no normal-prefix whitelist or guessed negation bypass is added.

Default-mode Electron control after the final build: both long quotations locate correctly at 1538/1556 ms, with late cancellation ignored, capture tracks ended, and no projection window opened. All experimental flags are off. This preserves the previous default control; it does not validate the strong-noise candidate.
