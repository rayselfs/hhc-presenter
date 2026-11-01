"""Build deterministic local TTS fixtures, without microphone or cloud synthesis."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import random
import re
import subprocess
import wave

from num2words import num2words
from opencc import OpenCC


def chinese_number(n):
    if n < 10:
        return '零一二三四五六七八九'[n]
    if n < 100:
        return ('' if n < 20 else chinese_number(n // 10)) + '十' + (chinese_number(n % 10) if n % 10 else '')
    return chinese_number(n // 100) + '百' + (('零' if n % 100 < 10 else '') + chinese_number(n % 100) if n % 100 else '')


def books_from_source(repo):
    source = (repo / 'src/renderer/src/lib/bible-book-matcher.ts').read_text()
    rows = re.findall(r"code: '([^']+)'.*?zhTW: '([^']+)'.*?zhCN: '([^']+)'.*?en: '([^']+)'", source, re.S)
    assert len(rows) == 66
    return [dict(zip(('code', 'zh', 'zhCN', 'en'), row)) for row in rows]


def build(repo, root):
    books = books_from_source(repo)
    scriptures = {lang: json.loads((root / 'sources' / name).read_text(encoding='utf-8-sig'))
                  for lang, name in [('zh', 'zh_cuv.json'), ('en', 'en_kjv.json')]}
    converter = OpenCC('s2t')
    assert all(len(b) == 66 for b in scriptures.values())
    rows = []

    def add(lang, kind, text, target=None, **extra):
        number = len(rows)
        voices = ['Meijia', 'Eddy (Chinese (Taiwan))'] if lang == 'zh' else ['Samantha', 'Daniel']
        rows.append(dict(id=f'{number:04d}', language=lang, kind=kind, text=text,
                         target=target, voice=voices[number % 2], rate=[150, 175, 195][number % 3],
                         split='calibration' if number % 5 == 0 else 'holdout', **extra))

    for lang in ['zh', 'en']:
        for book_idx, book in enumerate(books):
            chapters = scriptures[lang][book_idx]['chapters']
            for variant in range(3):
                chapter = [1, max(1, len(chapters) // 2), len(chapters)][variant]
                verse = min([1, 3, 5][variant], len(chapters[chapter - 1]))
                if lang == 'zh':
                    text = f"{book['zh']}第{chinese_number(chapter)}章第{chinese_number(verse)}節"
                    if variant == 1:
                        text = '請翻到' + text
                else:
                    name = re.sub(r'^[123]', lambda m: ['First', 'Second', 'Third'][int(m[0]) - 1], book['en'])
                    text = f'{name} chapter {num2words(chapter)} verse {num2words(verse)}'
                    if variant == 1:
                        text = 'Please turn to ' + text
                add(lang, 'reference', text, [book_idx + 1, chapter, verse])
        for book_idx, chapter, verse in [(19, 101, 1), (63, 1, 5)]:
            book = books[book_idx - 1]
            text = (f"{book['zh']}第{chinese_number(chapter)}章第{chinese_number(verse)}節" if lang == 'zh'
                    else f"{book['en']} chapter {num2words(chapter)} verse {num2words(verse)}")
            add(lang, 'reference', text, [book_idx, chapter, verse])

        rng = random.Random(20261101)
        candidates = []
        for bi, book in enumerate(scriptures[lang]):
            for ci, chapter in enumerate(book['chapters']):
                for vi, verse in enumerate(chapter):
                    text = converter.convert(verse) if lang == 'zh' else verse
                    length = len(text) if lang == 'zh' else len(text.split())
                    if (15 <= length <= 60 if lang == 'zh' else 8 <= length <= 28):
                        candidates.append(([bi + 1, ci + 1, vi + 1], text))
        for index, (target, text) in enumerate(rng.sample(candidates, 100)):
            cross_verse = index >= 90
            b, c, v = target
            chapter = scriptures[lang][b - 1]['chapters'][c - 1]
            if cross_verse and v < len(chapter):
                following = chapter[v]
                text += ' ' + (converter.convert(following) if lang == 'zh' else following)
            add(lang, 'quotation', text, target, cross_verse=cross_verse)

    for i in range(50):
        book_idx = [40, 43, 46, 63, 19][i % 5]
        book = books[book_idx - 1]
        chapter, verse = (1, 5) if book_idx == 63 else (3, 1 + i % 10)
        verse = min(verse, len(scriptures['zh'][book_idx - 1]['chapters'][chapter - 1]))
        text = (f"{book['zh']}第{chinese_number(chapter)}章 verse {num2words(verse)}" if i % 2 == 0
                else f"{book['en']}第{chinese_number(chapter)}章第{chinese_number(verse)}節")
        add('zh', 'mixed', text, [book_idx, chapter, verse])

    for text in ['請大家坐下，今天聚會結束後請留下來一起吃飯。', '我們需要關心身邊的朋友，這是今天分享的重點。',
                 '請檢查麥克風的音量，我們要準備開始了。', '週六下午三點到四點，我們在二樓開會。',
                 '現在請安靜片刻，接著我們一起禱告。']:
        add('zh', 'negative', text)
    for text in ['Please take a seat. Lunch will be served after the meeting.',
                 'We need to care for our friends and neighbors.', 'Please check the microphone volume.',
                 'The meeting is on the second floor at three thirty.', 'Let us pause for a moment before we continue.']:
        add('en', 'negative', text)

    (root / 'audio').mkdir(exist_ok=True)
    (root / 'books.json').write_text(json.dumps(books, ensure_ascii=False, indent=2))
    previous_file = root / 'corpus.json'
    previous = {r['id']: r for r in json.loads(previous_file.read_text())} if previous_file.exists() else {}

    def synthesize(row):
        path = root / 'audio' / f"{row['id']}.wav"
        old = previous.get(row['id'], {})
        valid = path.exists() and all(old.get(k) == row[k] for k in ('text', 'voice', 'rate'))
        valid = valid and old.get('sha256') == hashlib.sha256(path.read_bytes()).hexdigest()
        if not valid:
            subprocess.run(['say', '-v', row['voice'], '-r', str(row['rate']), '-o', str(path),
                            '--file-format=WAVE', '--data-format=LEI16@16000', row['text']], check=True, timeout=60)
        with wave.open(str(path)) as audio:
            assert audio.getnchannels() == 1 and audio.getframerate() == 16000 and audio.getsampwidth() == 2
            row['duration_s'] = audio.getnframes() / 16000
        row['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        return row

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for i, row in enumerate(pool.map(synthesize, rows)):
            if i % 50 == 0:
                print(f'Generated {i + 1}/{len(rows)}', flush=True)
    (root / 'corpus.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(f'{len(rows)} fixtures; {sum(x["duration_s"] for x in rows):.1f} audio seconds', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    args = parser.parse_args()
    build(args.repo, args.root)
