"""Frozen v2 policy replay on real ASR outputs; timings include measured prior decode."""
import argparse
from collections import defaultdict
import difflib
import json
from pathlib import Path
import re
import subprocess
import time

from evaluate import Retrieval, percentile
from metrics import tokens
from optimization_evaluate import quote_decision


def evaluate(root, file, output):
    original = [json.loads(x) for x in file.read_text().splitlines()]
    if any(row.get('kind') == 'unlabeled' for row in original):
        raise ValueError('Unlabeled audio requires human verification before accuracy evaluation')
    prepared = output.with_suffix('.prepared.json')
    input_file = output.with_suffix('.input.json')
    input_file.write_text(json.dumps(original, ensure_ascii=False))
    subprocess.run(['node', 'scripts/speech-benchmark/locate-v2.mjs', str(root), str(input_file), str(prepared)], check=True)
    rows = json.loads(prepared.read_text())
    phonetic = Retrieval(json.loads((root / 'optimization-v2/phonetic-corpus.json').read_text()), 'en')
    scripture = json.loads((root / 'sources/zh_cuv.json').read_text(encoding='utf-8-sig'))
    character = {'zh': Retrieval(scripture, 'zh'), 'en': Retrieval(json.loads((root / 'sources/en_kjv.json').read_text(encoding='utf-8-sig')), 'en')}
    for row in rows:
        start = time.perf_counter()
        query = tokens(row['transcript'], row['language'])
        explicit = bool(re.search(r'chapter|verse|\d\s*[:：]|\d\s*[章節篇張]', row['normalized'], re.I))
        eligible = row['v2_reference'] is None and not explicit and not row['v2_inhibited']
        ranked = character[row['language']].rank(row['transcript']) if eligible else []
        quote = quote_decision(ranked, len(query), row['language'])
        phonetic_candidate, phonetic_score = None, 0
        if row['language'] == 'zh' and len(query) >= 12 and eligible and quote is None:
            candidates = phonetic.rank(row['v2_phonetic'])
            if candidates and candidates[0][0] - (candidates[1][0] if len(candidates) > 1 else 0) >= .10:
                similarity, target = candidates[0]
                b, c, v = target
                chapter = scripture[b - 1]['chapters'][c - 1]
                character_score = max(difflib.SequenceMatcher(None, query, tokens(text, 'zh'), autojunk=False).ratio()
                                      for text in [chapter[v - 1], ' '.join(chapter[v - 1:v + 1])])
                if character_score >= .55:
                    phonetic_candidate, phonetic_score = target, similarity
        elapsed = time.perf_counter() - start
        for threshold in [None, .85, .88, .90, .92]:
            policy = 'strict' if threshold is None else f'phonetic-{threshold:.2f}'
            actual = None
            if not row['v2_inhibited']:
                actual = row['v2_reference']
                if actual is None and not explicit:
                    actual = quote
                    if actual is None and threshold is not None and phonetic_score >= threshold:
                        actual = phonetic_candidate
            total = row['decode_s'] + row['normalization_s'] + row['v2_prepare_s'] + elapsed
            row[policy] = dict(actual=actual, correct=actual is not None and actual == row['target'],
                               wrong=actual is not None and actual != row['target'], rejected=actual is None,
                               total_s=total, correct_within_3s=actual is not None and actual == row['target'] and total <= 3)
        row['phonetic_candidate'] = phonetic_candidate
        row['phonetic_similarity'] = phonetic_score
    groups = defaultdict(list)
    for row in rows:
        for policy in ['baseline', 'optimized', 'strict', 'phonetic-0.85', 'phonetic-0.88', 'phonetic-0.90', 'phonetic-0.92']:
            groups[(policy, row['split'], row['language'], row['kind'])].append(row)
    summary = {}
    for key, group in groups.items():
        policy = key[0]
        summary['/'.join(key)] = {'n': len(group), **{field: sum(x[policy][field] for x in group) for field in ['correct', 'wrong', 'rejected', 'correct_within_3s']},
                                'p95_s': percentile([x[policy]['total_s'] for x in group], .95), 'over_3s': sum(x[policy]['total_s'] > 3 for x in group)}
    output.write_text(json.dumps(summary, indent=2))
    output.with_suffix('.decisions.jsonl').write_text('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
    print('Evaluated', len(rows), file.name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('file', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    evaluate(args.root, args.file, args.output)
