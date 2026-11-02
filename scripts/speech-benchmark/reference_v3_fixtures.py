"""New deterministic reference audio and hard negatives after grammar selection."""
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys
import wave

from corpus import chinese_number
from num2words import num2words


def build(root):
    books = json.loads((root / 'books.json').read_text())
    scripture = json.loads((root / 'sources/zh_cuv.json').read_text(encoding='utf-8-sig'))
    old_texts = {r['text'] for name in ['corpus.json', 'optimization-final-corpus.json', 'v2-fresh-corpus.json']
                 for r in json.loads((root / name).read_text())}
    rng = random.Random(2026110203)
    rows = []
    def add(language, kind, text, target=None, voice=None):
        voices = ['Meijia', 'Eddy (Chinese (Taiwan))'] if language == 'zh' else ['Samantha', 'Daniel']
        rows.append({'id': f'ref3-{len(rows):03d}', 'language': language, 'kind': kind,
                     'text': text, 'target': target, 'split': 'fresh-reference-v3',
                     'voice': voice or voices[len(rows) % 2], 'rate': 175})
    for language, indices in [('zh', range(66)), ('en', rng.sample(range(66), 40))]:
        for i, book in enumerate(indices):
            while True:
                chapter = rng.randrange(len(scripture[book]['chapters'])) + 1
                verse = rng.randrange(len(scripture[book]['chapters'][chapter - 1])) + 1
                if language == 'zh':
                    text = ['請翻到', '請翻開', '請看'][i % 3] + books[book]['zh'] + f'第{chinese_number(chapter)}章第{chinese_number(verse)}節'
                else:
                    marker = 'chapter ' if i % 2 else ''
                    text = f"Please read {books[book]['en']} {marker}{num2words(chapter)} verse {num2words(verse)}"
                if text not in old_texts:
                    old_texts.add(text)
                    break
            add(language, 'reference', text, [book + 1, chapter, verse])
    negatives = {
        'zh': ['請不要讀約翰福音第三章第十六節。', '請翻到課本第八章第十二節。',
               '馬太福音第一章第一節。不是現在。', '約翰福音第三章第十六節只是練習例子。',
               '請看約翰福音第三章第十六節這個例子，不要跳轉。', '請翻到約翰福音第九十九章第三節。',
               '請翻到馬太福音第二章。', '約翰住三樓十六號房。',
               '不要翻到詩篇第二十三篇第四節，也不要跳轉。', '請讀第三章第八節。'],
        'en': ['Do not read Mark eight verse three.', 'Please read John three sixteen dollars.',
               'Mark eight verse three, not now.', 'Please read Mark eight verse three as an example.',
               'John is in room eight on floor three.', 'Please read John ninety nine verse three.',
               'Please read Mark chapter eight.', 'Please read chapter eight verse three.',
               'Do not turn to Second John one verse five.', 'John three point sixteen dollars.']}
    for language, texts in negatives.items():
        voices = ['Meijia', 'Eddy (Chinese (Taiwan))'] if language == 'zh' else ['Samantha', 'Daniel']
        for text in texts:
            assert text not in old_texts
            for voice in voices:
                add(language, 'negative', text, voice=voice)
    assert len(rows) == 146 and len({r['id'] for r in rows}) == 146
    assert all(scripture[b - 1]['chapters'][c - 1][v - 1] for r in rows if r['target'] for b, c, v in [r['target']])
    for row in rows:
        path = root / 'audio' / (row['id'] + '.wav')
        subprocess.run(['say', '-v', row['voice'], '-r', str(row['rate']), '-o', str(path), '--file-format=WAVE', '--data-format=LEI16@16000', row['text']], check=True, timeout=60)
        row['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        with wave.open(str(path)) as wav:
            assert wav.getframerate() == 16000 and wav.getnchannels() == 1
            row['duration_s'] = wav.getnframes() / wav.getframerate()
    (root / 'reference-v3-corpus.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print('Prepared 106 new references and 40 negative voice variants', flush=True)


if __name__ == '__main__':
    build(Path(sys.argv[1]))
