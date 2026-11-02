"""Fresh synthetic evaluation fixtures, separate from the previously inspected holdout."""
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys
import wave
from num2words import num2words
from opencc import OpenCC
from corpus import chinese_number


def build(root):
    books = json.loads((root / 'books.json').read_text())
    scriptures = {lang: json.loads((root / 'sources' / name).read_text(encoding='utf-8-sig'))
                  for lang, name in [('zh', 'zh_cuv.json'), ('en', 'en_kjv.json')]}
    rng = random.Random(20261102)
    rows = []
    convert = OpenCC('s2t').convert
    def add(lang, kind, text, target=None):
        i = len(rows)
        voices = ['Meijia', 'Eddy (Chinese (Taiwan))'] if lang == 'zh' else ['Samantha', 'Daniel']
        rows.append(dict(id=f'v2-{i:03d}', language=lang, kind=kind, text=text, target=target,
                         split='fresh', voice=voices[i % 2], rate=175))
    for i, book in enumerate(books):
        chapters = scriptures['zh'][i]['chapters'];c = rng.randrange(len(chapters)) + 1;v = rng.randrange(len(chapters[c - 1])) + 1
        add('zh', 'reference', ['請翻開', '', '請看'][i % 3] + f"{book['zh']}第{chinese_number(c)}章第{chinese_number(v)}節", [i + 1, c, v])
    while sum(r['kind'] == 'quotation' for r in rows) < 20:
        b = rng.randrange(66);c = rng.randrange(len(scriptures['zh'][b]['chapters']));v = rng.randrange(len(scriptures['zh'][b]['chapters'][c]));text = convert(scriptures['zh'][b]['chapters'][c][v])
        if 15 <= len(text) <= 65:
            add('zh', 'quotation', text, [b + 1, c + 1, v + 1])
    for i in range(12):
        b = [40, 43, 46, 47, 62, 63][i % 6];c = 1;v = 2 + i % 4
        name = books[b - 1]['zh'] if i % 2 else books[b - 1]['en']
        add('zh', 'mixed', f'{name}第一章 verse {num2words(v)}', [b, c, v])
    for i in range(12):
        b = [46, 47, 52, 53, 62, 63][i % 6];name = books[b - 1]['en'];c = 1;v = 2 + i % 4
        add('en', 'reference', f"Please read {name} chapter {num2words(c)} verse {num2words(v)}", [b, c, v])
    negatives = {
        'zh': ['請不要切換到創世記第一章第一節。', '不要定位到詩篇第二十三篇第一節。',
               '約翰福音第三章第十六節只是範例。', '這不是約翰福音第三章第十六節。',
               '約翰在二樓第三間教室。', '請翻開課本第三章第十六節。',
               '約翰福音第三章。', '約翰福音第三章第九百節。',
               '不是詩篇第二十三篇第一節，是約翰福音第三章第十六節。', '請顯示第三張投影片。'],
        'en': ['Please do not navigate to Genesis chapter one verse one.', 'Do not switch to Psalm twenty three verse one.',
               'John chapter three verse sixteen is just an example.', 'This is not John chapter three verse sixteen.',
               'John is on floor two in room three.', 'Please read chapter three section sixteen in the textbook.',
               'John chapter three.', 'John chapter three verse nine hundred.',
               'Not Psalm twenty three verse one, John chapter three verse sixteen.', 'Please show slide number three.']}
    for lang, texts in negatives.items():
        for text in texts:add(lang, 'negative', text)
    for row in rows:
        path = root / 'audio' / (row['id'] + '.wav')
        subprocess.run(['say', '-v', row['voice'], '-r', str(row['rate']), '-o', str(path), '--file-format=WAVE', '--data-format=LEI16@16000', row['text']], check=True, timeout=60)
        row['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        with wave.open(str(path)) as wav:row['duration_s'] = wav.getnframes() / wav.getframerate()
    (root / 'v2-fresh-corpus.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print('Generated',len(rows),'fresh fixtures')


if __name__ == '__main__':
    build(Path(sys.argv[1]))
