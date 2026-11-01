# Small optimization evidence

Four calibration runs use 132 fixtures each. The fixed selection uses baseline
Chinese decoding and a short English prompt. Final files contain 584 identical
fixture IDs: 528 original holdout records and 56 new challenge records. The
English-only optimized run contains 272 records; the combined optimized file
reuses baseline Chinese inference because those settings are unchanged.

Raw JSONL files start with one metadata record. Decision JSONL files have no
metadata record and include both localization policies for each transcript.
Expected targets are used for scoring only, never for choosing a candidate.
The scripts, fixed policy, selection, per-run exit codes, raw transcripts,
paired regressions and corpus hashes support the report's conclusions.

Model/runtime manifests and source scriptures are unchanged from the preceding
Phase 0 evidence directory. Audio, models and the virtual environment remain
outside the repository. SHA256SUMS.json checks file integrity, not authorship.
