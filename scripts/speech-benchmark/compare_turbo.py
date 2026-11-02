"""Paired comparison of frozen localization decisions on identical synthetic audio."""
import argparse
from collections import defaultdict
import json
from pathlib import Path

from evaluate import percentile


POLICY = 'phonetic-0.85'


def compare(baseline, candidate, excluded=(), language='zh', labels=('small', 'turbo')):
    baseline = [row for row in baseline if row['language'] == language and row['id'] not in excluded]
    candidate = [row for row in candidate if row['language'] == language and row['id'] not in excluded]
    before = {row['id']: row for row in baseline}
    after = {row['id']: row for row in candidate}
    if not before or len(before) != len(baseline) or len(after) != len(candidate) or before.keys() != after.keys():
        raise ValueError('Paired IDs must be unique and identical')
    groups = defaultdict(list)
    changes = {'gained': [], 'lost': [], 'new_wrong': [], 'over_3s': [], 'long_audio': []}
    for ident, row in before.items():
        other = after[ident]
        if any(row[key] != other[key] for key in ['sha256', 'target', 'kind', 'duration_s']):
            raise ValueError(f'Paired audio/target mismatch: {ident}')
        old, new = row[POLICY], other[POLICY]
        groups[row['kind']].append((old, new))
        groups['all'].append((old, new))
        if row['kind'] != 'negative':
            groups['positive'].append((old, new))
        for key, condition in [('gained', new['correct'] and not old['correct']),
                               ('lost', old['correct'] and not new['correct']),
                               ('new_wrong', new['wrong'] and not old['wrong']),
                               ('over_3s', new['total_s'] > 3),
                               ('long_audio', row['duration_s'] > 15.36)]:
            if condition:
                changes[key].append(ident)
    summary = {}
    for kind, pairs in groups.items():
        summary[kind] = {'n': len(pairs)}
        for index, name in enumerate(labels):
            decisions = [pair[index] for pair in pairs]
            times = [decision['total_s'] for decision in decisions]
            summary[kind][name] = {
                **{key: sum(decision[key] for decision in decisions)
                   for key in ['correct', 'wrong', 'rejected', 'correct_within_3s']},
                'p95_s': percentile(times, .95), 'max_s': max(times),
                'over_3s': sum(value > 3 for value in times)}
    return {'groups': summary, 'changes': changes}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('baseline', type=Path)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--exclude', nargs='*', default=[])
    parser.add_argument('--language', choices=['zh', 'en'], default='zh')
    parser.add_argument('--labels', nargs=2, default=['small', 'turbo'])
    args = parser.parse_args()
    read = lambda path: [json.loads(line) for line in path.read_text().splitlines()]
    result = compare(read(args.baseline), read(args.candidate), args.exclude, args.language, args.labels)
    args.output.write_text(json.dumps(result, indent=2))
