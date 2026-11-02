"""Replay retained native transcripts through the strict noisy-room citation gate."""
import json
from pathlib import Path
import sys
from live_runtime import Locator

root, output = map(Path, sys.argv[1:3])
output.mkdir(parents=True, exist_ok=True)
rows = json.loads((root / 'strong-final/screen/results.json').read_text())[:168]
rows += json.loads((root / 'strong-final/benign-screen/results.json').read_text())
locator = Locator(root, strict_citations=True)
try:
    assert locator.locate('十八世紀一章第一節') is None
    assert locator.locate('十七世紀一章第一節') is None
    assert locator.locate('約翰一書第一章第一節') == [62, 1, 1]
    assert locator.locate('2nd John chapter 1 verse 3') == [63, 1, 3]
    assert locator.locate('創世紀第一章第一節') == [1, 1, 1]
    assert locator.locate('請不要翻到創世記第一章第一節') is None
    for row in rows:
        decisions = row.get('decisions', [row])
        for decision in decisions:
            answer = decision['retry'] or decision['initial']
            decision['strict_reference'] = None if decision['guarded'] else locator.locate(answer['text'])
        row['strict_correct'] = row['target'] is not None and any(d['strict_reference'] == row['target'] for d in decisions)
        row['strict_wrong'] = any(d['strict_reference'] is not None and d['strict_reference'] != row['target'] for d in decisions)
    (output / 'results.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    for name, cases in [('strong', rows[:84]), ('light', rows[84:168]), ('benign', rows[168:])]:
        print(name, len(cases), 'correct', sum(r['strict_correct'] for r in cases), 'wrong', sum(r['strict_wrong'] for r in cases))
finally:
    locator.close()
