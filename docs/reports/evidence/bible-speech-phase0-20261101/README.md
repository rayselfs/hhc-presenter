# Phase 0 evidence

Raw `.jsonl` files contain one metadata row followed by utterance results.
`.scored.jsonl` files contain utterance results with independent retrieval scores,
without a metadata row. `summary-initial.json` covers the four 660-fixture runs
and five 140-fixture variants. `summary-turbo.json` covers the 140-fixture Turbo screen.

`product-parser.json` includes gold text, current-parser results and failure inputs.
Startup measurements reuse OS/Metal caches. Offline results are single-utterance
checks, not application E2E. Earlier failure and interruption statuses are retained;
only completed runs listed in the report count toward comparison.

`corpus.json` records synthesized text, source voice/rate/split and audio hashes.
Model/source manifests pin upstream revisions and files. Model cards are copied
unmodified for provenance. No model binaries, audio or Python environment are included.
The local data directory and reproduction instructions are in the report.

`SHA256SUMS.json` verifies the evidence files in this directory; it is not a signature.
