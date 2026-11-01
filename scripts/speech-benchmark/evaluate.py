"""Summarize ASR and independent retrieval-probe results, not product readiness."""
import argparse
from collections import Counter, defaultdict
import difflib
import json
import math
from pathlib import Path

from metrics import score, tokens


def percentile(values, p):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * p) - 1)] if values else None


class Retrieval:
    def __init__(self, scriptures, language):
        self.language = language
        self.docs = []
        self.index = defaultdict(list)
        for b, book in enumerate(scriptures, 1):
            for c, chapter in enumerate(book['chapters'], 1):
                for v, text in enumerate(chapter, 1):
                    units = tokens(text, language)
                    doc_id = len(self.docs)
                    self.docs.append(([b, c, v], units))
                    for term in set(self.terms(units)):
                        self.index[term].append(doc_id)

    def terms(self, units):
        return units if self.language == 'en' else [''.join(units[i:i + 2]) for i in range(len(units) - 1)]

    def rank(self, text):
        query = tokens(text, self.language)
        votes = Counter()
        for term in set(self.terms(query)):
            postings = self.index.get(term, [])
            weight = math.log(1 + len(self.docs) / (1 + len(postings)))
            for doc in postings:
                votes[doc] += weight
        best = []
        for doc, _ in votes.most_common(40):
            target, units = self.docs[doc]
            similarity = difflib.SequenceMatcher(None, query, units, autojunk=False).ratio()
            # The corpus includes adjacent-verse quotes; compare both windows.
            if doc + 1 < len(self.docs) and self.docs[doc + 1][0][:2] == target[:2]:
                similarity = max(similarity, difflib.SequenceMatcher(
                    None, query, units + self.docs[doc + 1][1], autojunk=False).ratio())
            best.append((similarity, target))
        return sorted(best, reverse=True)[:3]

    def search(self, text):
        return [target for _, target in self.rank(text)]


def evaluate(root, files, output):
    books = json.loads((root / 'books.json').read_text())
    retrieval = {lang: Retrieval(json.loads((root / 'sources' / filename).read_text(encoding='utf-8-sig')), lang)
                 for lang, filename in [('zh', 'zh_cuv.json'), ('en', 'en_kjv.json')]}
    corpus = json.loads((root / 'corpus.json').read_text())
    for row in corpus:
        if row['kind'] in ('reference', 'mixed'):
            assert score(row, row['text'], books)['reference_correct'], row
    summary = []
    for file in files:
        if not file.exists():
            summary.append({'file': file.name, 'error': 'No result file; inspect execution log'})
            continue
        records = [json.loads(line) for line in file.read_text().splitlines()]
        if any(row.get('kind') == 'unlabeled' for row in records):
            raise ValueError('Unlabeled audio requires human verification before accuracy evaluation')
        if len(records) < 2:
            summary.append({'file': file.name, 'error': 'No completed inference records'})
            continue
        metadata, rows = records[0], records[1:]
        groups = defaultdict(list)
        for row in rows:
            row.update(score(row, row['transcript'], books))
            if row['kind'] == 'quotation':
                row['top3'] = retrieval[row['language']].search(row['transcript'])
                row['retrieved'] = row['target'] in row['top3']
                row['oracle_retrieved'] = row['target'] in retrieval[row['language']].search(row['text'])
            groups[(row['language'], row['kind'])].append(row)
        detail = file.with_suffix('.scored.jsonl')
        detail.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in rows) + '\n')
        result = {'file': file.name, 'metadata': metadata, 'n': len(rows), 'groups': {}}
        for (lang, kind), group in groups.items():
            result['groups'][f'{lang}/{kind}'] = {
                'n': len(group), 'normalized_error_rate': sum(r['edits'] for r in group) / sum(r['units'] for r in group),
                'reference_correct': sum(r['reference_correct'] is True for r in group) if kind in ('reference', 'mixed') else None,
                'decode_p50_s': percentile([r['decode_s'] for r in group], .5),
                'decode_p95_s': percentile([r['decode_s'] for r in group], .95),
                'rtf_p95': percentile([r['rtf'] for r in group], .95),
                'cpu_core_equivalent': sum(r['cpu_s'] for r in group) / sum(r['decode_s'] for r in group),
                'peak_rss_mib': max(r['max_rss_bytes'] for r in group) / 1024 ** 2,
                'quote_top3_correct': sum(r['retrieved'] for r in group) if kind == 'quotation' else None,
                'oracle_top3_correct': sum(r['oracle_retrieved'] for r in group) if kind == 'quotation' else None,
                'negative_reference_count': sum(r['reference'] is not None for r in group) if kind == 'negative' else None,
            }
        slices = defaultdict(list)
        for row in rows:
            slices[(row['language'], row['kind'], row['voice'], row['split'])].append(row)
        result['slices'] = {'/'.join(key): {
            'n': len(group), 'edits': sum(r['edits'] for r in group), 'units': sum(r['units'] for r in group),
            'reference_correct': sum(r['reference_correct'] is True for r in group),
            'quote_top3_correct': sum(r.get('retrieved', False) for r in group)
        } for key, group in slices.items()}
        summary.append(result)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('files', nargs='+', type=Path)
    args = parser.parse_args()
    evaluate(args.root, args.files, args.output)
