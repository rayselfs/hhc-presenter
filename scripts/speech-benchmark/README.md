# Local Bible ASR benchmark

## Private recording review

Keep recordings, AI transcripts, inference results and listening worksheets in a
private data directory outside this repository. AI transcripts are hints, not
ground truth. Do not publish source names or transcript snippets in evidence.

`prepare_real_audio.py SOURCE PRIVATE DATA` creates 16 kHz mono WAVs and 20-second
windows with a two-second overlap. It records source hashes without changing
originals. Run each engine sequentially against PRIVATE. These fixed windows are
for review, not a live endpointing or microphone latency benchmark.

`real_audio_review.py PRIVATE` builds a local listening page and an unlabeled
candidate worksheet from any available `whisper-large-v3-turbo-q5_0.jsonl`,
`whisper-small.jsonl`, or `sensevoice.jsonl`, plus optional `recording-XX-reference-context.json` paragraph pairs. Pair transcripts
to source recordings by filename, not directory ordering. The page includes
private text and file links: do not upload it. Matching paragraphs and model
agreement never set `human_verified` or `expected_reference`. Turbo is shown
first; each row shows only completed profiles, whose corpus coverage may differ.

The worksheet selects reference-like windows only. Full-session false-jump
evaluation also requires labeling ordinary speech, silence and ambiguous
quotations, and replaying the production navigation policy. Overlapping windows
must not be counted as independent correct references. Accuracy evaluators reject
unlabeled inputs; earlier raw timing runs may contain meaningless empty-reference
edit counts, which must not be reported as accuracy.

## Synthetic comparison

### Reference-format v3 candidate

Keep `locate-v2.mjs` frozen. `evaluate_v2.py ... --reference-v3` selects the
candidate `locate-v3.mjs` grammar while retaining the same quotation policy and
measured ASR output. Existing `v2_reference` transport fields are reused; the
protocol and file names identify the grammar revision. Timing includes measured
new normalization/localization plus recorded ASR, not another inference run.

The candidate preserves Chinese book text before the chapter number, repairs
structural markers only with exact canonical book names, collapses only identical
repeated citations, accepts explicit English verse markers without `chapter`, and
supports the standard `Psalm` alias. Dot/space numeric references require an
explicit navigation command and exact book name. Chapter/verse fields cannot be
reinterpreted as book names. Fuzzy thresholds and quotation gates are unchanged.

`reference_v3_fixtures.py DATA` generates 66 Chinese and 40 English new references
plus 20 negatives per language (10 texts, two voices each). Positive source text
is checked against earlier corpora. Run Chinese Turbo with fitted context and
English Small with the fixed prompt sequentially, then replay both v2 and v3 on
each output. Use `compare_turbo.py ... --language zh --labels v2 v3` (or `en`) for
policy comparisons; never label a parser-only comparison as a different model.

The initial policy was frozen before this new audio run. Follow-up fixes for the
field-in-book guard and `Psalm` alias used its outputs, so final results are
regression/challenge evidence, not blind acceptance. Preserve initial and final
policy/results. No private recordings or AI transcripts are used in this corpus.

### Turbo context validation

`--audio-ctx 768` reproduces the fixed reduced-context experiment. It can miss
speech late in a longer waveform. Add `--fit-audio-context` to choose full context
before inference whenever the waveform exceeds 768 audio tokens (15.36 seconds).
This is a benchmark setting, not a user-facing model option or a second-pass retry.

Run `run.py whisper-large-v3-turbo-q5_0` sequentially on
`optimization-final-corpus.json` and `v2-fresh-corpus.json`, with `--language zh
--audio-ctx 768 --fit-audio-context`. Evaluate each output with
`optimization_evaluate.py`, then `evaluate_v2.py` and the frozen `phonetic-0.85`
policy. `compare_turbo.py BASELINE_DECISIONS TURBO_DECISIONS OUTPUT` checks paired
IDs, WAV hashes, targets and durations before summarizing. For the second dataset,
pass `--exclude v2-097 v2-129` to retain the earlier text-deduplication rule.

For English, calibrate `run.py` with `--language en --subset calibration`: Small
uses the previously selected `--short-prompt`; compare Turbo with and without
that prompt while keeping `--audio-ctx 768 --fit-audio-context`. Freeze the prompt
selection before running both final corpora. Re-run both engines sequentially
and use `compare_turbo.py ... --language en`, with the same second-dataset
exclusions. Empty language selections fail instead of producing an empty success
summary. Report Chinese, English and mixed speech separately; mixed-speech recall
is a compatibility metric, not a primary-language acceptance gate.

Boundary probes use the original synthetic `0000` and `0600` WAVs, placed at
offset 0 or 16 seconds in a 22-second, 16 kHz mono PCM waveform, padded with zeros.
Add pure zero-valued 16- and 22-second waveforms as negatives. These deliberate
boundary probes are reported separately, not added to accuracy totals. Preserve
the four original long quotations; do not discard them to improve timing results.

Isolated Phase 0 experiment. No application runtime changes, microphone capture,
cloud ASR, or remote model code. Model files and synthesized audio live outside
the repository. The Python bindings are benchmark tooling, not a proposed Python
dependency for the Electron application.

Use Python 3.13 in a separate virtual environment. Install the versions recorded
in the evidence `requirements.lock.txt`. `fetch_models.py` downloads pinned
revisions and verifies upstream SHA-256 when provided. The resulting manifest
records every local hash. Download the two scripture sources from the pinned
URLs in the evidence `sources-manifest.json`; store them as `sources/zh_cuv.json`
and `sources/en_kjv.json` under the chosen data directory.

Run from the worktree root, substituting an absolute data directory for DATA:

```sh
python scripts/speech-benchmark/fetch_models.py DATA/models
python scripts/speech-benchmark/corpus.py DATA
python -m unittest discover -s scripts/speech-benchmark -p 'test_*.py'
python scripts/speech-benchmark/run.py sherpa DATA DATA/sherpa.jsonl
python scripts/speech-benchmark/run.py sherpa-fp32 DATA DATA/sherpa-fp32.jsonl
python scripts/speech-benchmark/run.py whisper-base DATA DATA/whisper-base.jsonl
python scripts/speech-benchmark/run.py whisper-small DATA DATA/whisper-small.jsonl
python scripts/speech-benchmark/run.py whisper-large-v3-turbo-q5_0 DATA DATA/turbo-screen.jsonl --subset screen
node scripts/speech-benchmark/transformers.mjs DATA DATA/transformers-screen.jsonl screen
python scripts/speech-benchmark/evaluate.py DATA DATA/summary.json DATA/sherpa.jsonl DATA/whisper-base.jsonl DATA/whisper-small.jsonl DATA/sherpa-fp32.jsonl DATA/transformers-screen.jsonl DATA/turbo-screen.jsonl
```

Generate audio before timing inference; never benchmark engines concurrently.
The corpus generator uses local macOS voices. Windows must use the same hashed
WAV files, not regenerated audio. Audio files are local test artifacts; their
redistribution rights have not been established, so do not publish them.

`--subset calibration` selects the frozen 20% calibration split; `--bias` enables
all-book prompting/hotwords without the sample's expected answer. For Sherpa,
compare `--beam` against `--beam --bias` to keep decoding method constant.
`--cpu` disables whisper.cpp GPU execution; it does not emulate an Intel CPU.
`--subset screen` selects calibration plus all negatives (140 balanced-voice fixtures),
not the final accuracy gate. Turbo and Transformers were only screened.

Metrics are normalized Chinese character / English word edit rates and a
benchmark-only reference parser. Gold references must all parse correctly before
scoring ASR. Retrieval is a separate bounded text-ranking probe against all verses,
not the application's current search worker. Report its gold-text baseline too.
These scores are not proof of production navigation or projection correctness.

Timing measures pre-segmented waveform computation. Sherpa receives 100 ms chunks
without wall-clock pacing; Whisper processes a completed utterance. Neither is
the full microphone-to-stable-preview latency. Transformers.js uses the installed
3.8.1 package with Node CPU ONNX Runtime as a proxy, not Electron renderer/WASM.
Peak RSS is process high-water memory and may omit GPU allocations.

660 synthetic fixtures do not establish human speech accuracy, accent/noise
robustness, two-hour stability, minimum hardware, or Windows compatibility.

Results and limitations: [Phase 0 report](../../docs/reports/2026-11-02-bible-speech-phase0-benchmark.md).

## Small optimization follow-up

See [optimization report](../../docs/reports/2026-11-02-whisper-small-optimization.md).
Run the four calibration configurations sequentially with `--subset calibration`:
no additional flags, `--short-prompt`, `--beam-size 3`, and both flags. The short
prompts are fixed in `run.py`; they do not contain the expected reference.

```sh
python scripts/speech-benchmark/optimization_evaluate.py DATA DATA/optimization/calibration-summary.json DATA/optimization/baseline-calibration.jsonl DATA/optimization/short-prompt-calibration.jsonl DATA/optimization/beam3-calibration.jsonl DATA/optimization/beam3-short-calibration.jsonl
python scripts/speech-benchmark/optimization-negatives.py DATA
```

Freeze the selection before final inference. The recorded selection retains
baseline decoding for Chinese and uses `--short-prompt` for English. The evidence
`optimization-final-corpus.json` contains the original 528 holdout records plus
56 new challenge records, with hashes. Copy that manifest into DATA and keep the
original and generated WAVs in DATA/audio. Do not regenerate TTS on Windows.

```sh
python scripts/speech-benchmark/run.py whisper-small DATA DATA/optimization/baseline-final.jsonl --corpus optimization-final-corpus.json
python scripts/speech-benchmark/run.py whisper-small DATA DATA/optimization/english-optimized-final.jsonl --corpus optimization-final-corpus.json --language en --short-prompt
```

`optimized-final.jsonl` combines the baseline Chinese rows and optimized English
rows under one metadata record, sorted by ID. Chinese inference is deliberately
reused because its selected model settings are unchanged. Evaluate both combined
files with `optimization_evaluate.py`; its Node helper directly exercises the
product parser and an isolated experimental grammar. The acceptance policy is
fixed in `localization-policy.json` in the evidence. No sample kind or expected
target is passed into the localization decision.

The end-to-end timing field is an offline estimate (decode + request-level
localization), with a prebuilt retrieval index. It excludes capture, endpoint
waiting, IPC and UI. Do not call it measured live microphone latency. Negative
fixtures test candidate errors, not actual projection changes.

## Chinese localization and reference safety v2

See [v2 report](../../docs/reports/2026-11-02-whisper-small-chinese-v2.md).
`locate-v2.mjs` is an experimental complete-reference grammar with whole-book
matching, ordinal handling and navigation negation guards. It does not replace
the application's parser. `evaluate_v2.py` compares prior decisions with a fixed
Chinese phonetic retrieval fallback. Calibration selects the threshold before
regression or fresh evaluation. Final reported policy is `phonetic-0.85`.

```sh
node scripts/speech-benchmark/locate-v2.mjs DATA --phonetic-corpus DATA/optimization-v2/phonetic-corpus.json
python scripts/speech-benchmark/evaluate_v2.py DATA DATA/optimization/baseline-calibration.decisions.jsonl DATA/optimization-v2/calibration.json
python scripts/speech-benchmark/evaluate_v2.py DATA DATA/optimization/optimized-final.decisions.jsonl DATA/optimization-v2/regression.json
python scripts/speech-benchmark/v2_fixtures.py DATA
python scripts/speech-benchmark/run.py whisper-small DATA DATA/optimization-v2/fresh-zh.jsonl --corpus v2-fresh-corpus.json --language zh
python scripts/speech-benchmark/run.py whisper-small DATA DATA/optimization-v2/fresh-en.jsonl --corpus v2-fresh-corpus.json --language en --short-prompt
```

Combine the two fresh runs under one metadata row, evaluate with
`optimization_evaluate.py` first, then pass its decision JSONL into
`evaluate_v2.py`. The source transcript is reused for all localization policies;
labels only score results. Fresh rows v2-097 and v2-129 duplicate previous texts:
retain their raw results but exclude them from the 128-row fresh report table.
Timing reuses recorded ASR decode and remeasures localization against prebuilt
indexes; it remains an offline estimate, not live microphone-to-preview latency.
