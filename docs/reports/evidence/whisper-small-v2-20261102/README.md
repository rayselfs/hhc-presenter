# Small v2 evidence

The fixed policy was selected on calibration before final evaluation.
Regression replays 584 prior ASR transcripts. Fresh inference has 130 records;
exclude v2-097 and v2-129 (exact prior-text duplicates) for the 128-row fresh table.
Raw inference JSONL has one metadata row; decision JSONL has no metadata row.

The selected policy is phonetic-0.85. Other thresholds are retained for audit,
not selected after looking at final results. The v2 evaluator remeasures
localization and reuses measured ASR decode. No live microphone latency is claimed.
Models and WAVs remain outside the repository. The phonetic index manifest
records its hash; regenerate it using the scripts rather than committing it.
SHA256SUMS.json verifies evidence integrity, not authorship.
