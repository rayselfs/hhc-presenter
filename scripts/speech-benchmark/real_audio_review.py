"""Build a private listening worksheet; machine agreement is never a gold label."""
import argparse
from html import escape
import json
from pathlib import Path
import re

from opencc import OpenCC


CONVERTER = OpenCC('t2s')
REFERENCE = re.compile(r'[零〇一二兩三四五六七八九十百\d]+\s*[章章节]|\d+\s*[:：]\s*\d+')


def pairs(text):
    text = ''.join(re.findall(r'[\w]', CONVERTER.convert(text).lower()))
    return {text[i:i + 2] for i in range(len(text) - 1)}


def match_paragraph(text, paragraphs):
    query = pairs(text)
    if len(query) < 8 or not paragraphs:
        return None
    scores = [(len(query & pairs(paragraph)) / len(query), index, paragraph)
              for index, paragraph in paragraphs]
    score, index, paragraph = max(scores)
    return {'score': score, 'paragraph': index, 'text': paragraph} if score >= 0.35 else None


def read_rows(path):
    if not path.exists():
        return {}
    return {row['id']: row for line in path.read_text().splitlines()
            if 'id' in (row := json.loads(line))}


def build(root):
    corpus = json.loads((root / 'corpus.json').read_text())
    models = {name: read_rows(root / f'{name}.jsonl') for name in ['whisper-small', 'sensevoice']}
    paragraphs = {path.name.removesuffix('-reference-context.json'): json.loads(path.read_text())
                  for path in root.glob('recording-*-reference-context.json')}
    items, cards = [], []
    for row in corpus:
        outputs = {name: rows[row['id']] for name, rows in models.items() if row['id'] in rows}
        if not outputs:
            continue
        matches = [match_paragraph(output['transcript'], paragraphs.get(row['recording'], []))
                   for output in outputs.values()]
        match = max((match for match in matches if match), key=lambda item: item['score'], default=None)
        explicit = any(REFERENCE.search(output['transcript']) for output in outputs.values())
        # shortcut: reference-only triage misses paraphrases; sample all windows before acceptance.
        if not explicit and not match:
            continue
        item = {key: row[key] for key in ['id', 'recording', 'offset_s', 'duration_s']}
        item.update({'outputs': {name: {'text': output['transcript'], 'decode_s': output['decode_s']}
                                 for name, output in outputs.items()},
                     'ai_transcript_match': match, 'human_verified': False, 'expected_reference': None})
        items.append(item)
        minute, second = divmod(int(row['offset_s']), 60)
        title = f"{row['recording']} · {minute:02d}:{second:02d}"
        audio = (root / 'audio' / f"{row['id']}.wav").resolve().as_uri()
        content = ''.join(f'<h3>{escape(name)} · {output["decode_s"]:.2f}s</h3>'
                          f'<p>{escape(output["transcript"])}</p>' for name, output in outputs.items())
        if match:
            content += (f'<details><summary>AI 逐字稿相關段落（未核實）· 段落 {match["paragraph"]}</summary>'
                        f'<p>{escape(match["text"])}</p></details>')
        cards.append(f'<article id="{escape(row["id"])}"><h2>{escape(title)}</h2>'
                     f'<audio controls preload="none" src="{escape(audio, quote=True)}"></audio>{content}</article>')
    (root / 'review-candidates.json').write_text(json.dumps(items, ensure_ascii=False, indent=2))
    page = ('<!doctype html><html lang="zh-Hant"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>私人錄音核對</title><style>body{font:18px/1.6 system-ui;max-width:960px;margin:32px auto;padding:0 20px;'
            'color:#18212b;background:#f6f7f9}article{background:white;padding:24px;margin:24px 0;border:1px solid #ddd;'
            'border-radius:12px}h2{font-size:22px}h3{font-size:17px}audio{width:100%}summary{cursor:pointer}'
            'p{white-space:pre-wrap}</style><h1>私人錄音核對</h1>'
            '<p>所有項目尚未人工核聽。AI 逐字稿僅提供線索，兩個模型一致也不代表正確。'
            '下列為經文候選片段，未包含所有一般談話，不能用來計算整場誤跳率。</p>'
            '<p>每段最多 20 秒，相鄰片段重疊 2 秒。顯示的秒數只是模型處理時間，'
            '不代表說完到畫面定位的延遲。請核對書卷、章節，以及當下是否真的要跳轉。</p>'
            f'<p>共 {len(items)} 個候選片段；檔案與音訊只保留在本機。</p>' + ''.join(cards) + '</html>')
    (root / 'review.html').write_text(page)
    print(json.dumps({'candidate_windows': len(items), 'human_verified': 0,
                      'processed_windows': {name: len(rows) for name, rows in models.items()}}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    build(parser.parse_args().root)
