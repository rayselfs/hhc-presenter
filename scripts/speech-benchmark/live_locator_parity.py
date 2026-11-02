"""Compare resident localization with the frozen 505-transcript baseline, without ASR."""
import json
from pathlib import Path
import sys
from live_runtime import Locator

root = Path(sys.argv[1])
rows = [json.loads(line) for line in (root / 'segmentation/regression-digital-v3.decisions.jsonl').read_text().splitlines()]
locator = Locator(root)
try:
    mismatches = []
    for row in rows:
        located = locator.locate(row['transcript'])
        actual = list(located) if located is not None else None
        if actual != row['phonetic-0.85']['actual']:
            mismatches.append({'id': row['id'], 'expected': row['phonetic-0.85']['actual'], 'actual': actual})
    print(json.dumps({'cases': len(rows), 'mismatches': mismatches}))
    assert len(rows) == 505 and not mismatches
finally:
    locator.close()
