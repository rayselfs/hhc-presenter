"""Paired offline localization policy; no actual UI navigation or production edits."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import subprocess
import time

from evaluate import Retrieval, percentile
from metrics import normalize, score, tokens


def quote_decision(ranked, unit_count, language):
    minimum = 8 if language == 'zh' else 5
    if unit_count < minimum or not ranked:
        return None
    best, target = ranked[0]
    runner_up = ranked[1][0] if len(ranked) > 1 else 0
    return target if best >= .82 and best - runner_up >= .10 else None


def evaluate(root, files, output):
    books = json.loads((root / 'books.json').read_text())
    scriptures = {lang: json.loads((root / 'sources' / name).read_text(encoding='utf-8-sig'))
                  for lang, name in [('zh', 'zh_cuv.json'), ('en', 'en_kjv.json')]}
    retrieval = {lang: Retrieval(source, lang) for lang, source in scriptures.items()}
    summaries = []
    for file in files:
        records = [json.loads(line) for line in file.read_text().splitlines()]
        if any(row.get('kind') == 'unlabeled' for row in records):
            raise ValueError('Unlabeled audio requires human verification before accuracy evaluation')
        metadata, rows = records[0], records[1:]
        for row in rows:
            start = time.perf_counter()
            row['normalized'] = normalize(row['transcript'])
            row['normalization_s'] = time.perf_counter() - start
            row.update(score(row, row['transcript'], books))
        temporary = file.with_suffix('.normalized.json')
        located = file.with_suffix('.located.json')
        temporary.write_text(json.dumps(rows, ensure_ascii=False))
        subprocess.run(['node', '--experimental-strip-types', 'scripts/speech-benchmark/optimization-locate.mjs',
                        str(temporary), str(located), str(root / 'sources/zh_cuv.json')], check=True)
        rows = json.loads(located.read_text())
        groups = defaultdict(list)
        for row in rows:
            start = time.perf_counter()
            ranked = retrieval[row['language']].rank(row['transcript'])
            quote = quote_decision(ranked, len(tokens(row['transcript'], row['language'])), row['language'])
            quote_s = time.perf_counter() - start
            # A malformed explicit reference must not silently fall through to a quotation.
            explicit = bool(re.search(r'chapter|verse|\d\s*[:：]|第?[\d零一二三四五六七八九十百]+\s*[章節篇]', row['normalized'], re.I))
            row['quote_top3'] = [target for _, target in ranked]
            row['quote_scores'] = [value for value, _ in ranked]
            for policy in ['baseline', 'optimized']:
                reference = row[policy + '_reference']
                actual = reference if reference is not None else (None if explicit else quote)
                total_s = row['decode_s'] + row[policy + '_reference_s']
                total_s += row['normalization_s']
                if reference is None and not explicit:
                    total_s += quote_s
                correct = actual is not None and actual == row['target']
                wrong = actual is not None and actual != row['target']
                result = dict(actual=actual, correct=correct, wrong=wrong, rejected=actual is None,
                              total_s=total_s, correct_within_3s=correct and total_s <= 3)
                row[policy] = result
                groups[(policy, row['split'], row['language'], row['kind'])].append(row)
        summary = {'file': file.name, 'metadata': metadata, 'n': len(rows), 'groups': {}}
        for (policy, split, lang, kind), group in groups.items():
            units = sum(x['units'] for x in group)
            summary['groups']['/'.join((policy, split, lang, kind))] = {
                'n': len(group), 'error_rate': sum(x['edits'] for x in group) / units if units else None,
                **{key: sum(x[policy][key] for x in group) for key in ['correct', 'wrong', 'rejected', 'correct_within_3s']},
                'p95_s': percentile([x[policy]['total_s'] for x in group], .95),
                'over_3s': sum(x[policy]['total_s'] > 3 for x in group),
                'top3_correct': sum(x['target'] in x['quote_top3'] for x in group) if kind == 'quotation' else None}
        file.with_suffix('.decisions.jsonl').write_text('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
        summaries.append(summary)
    output.write_text(json.dumps(summaries, ensure_ascii=False, indent=2))
    print('Evaluated', [(x['file'], x['n']) for x in summaries])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('files', nargs='+', type=Path)
    args = parser.parse_args()
    evaluate(args.root, args.files, args.output)
