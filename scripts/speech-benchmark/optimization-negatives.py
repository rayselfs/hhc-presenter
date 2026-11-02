"""Additional synthetic rejection fixtures; never used to tune the selected model."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import wave

TEXTS = {
    'zh': ['今天下午三點十六分開始開會。', '請閱讀講義第三章第十六節。',
           '約翰今天沒有來，他在三樓十六號房間。', '我們今天談一談創世記的背景。',
           '約翰福音第九十九章第一節。', '創世記第一章第九百節。',
           '不要翻到約翰福音第三章第十六節。', '請先不要跳轉，約翰福音第三章第十六節只是範例。',
           '神愛世人。', '我們要彼此相愛。', '請把投影片換到第三頁。', '現在播放下一首詩歌。'],
    'en': ['The meeting starts at three sixteen this afternoon.', 'Read chapter three section sixteen of the manual.',
           'John is in room sixteen on the third floor.', 'We are discussing the background of Genesis today.',
           'John chapter ninety nine verse one.', 'Genesis chapter one verse nine hundred.',
           'Do not turn to John chapter three verse sixteen.', 'John chapter three verse sixteen is just an example, do not navigate.',
           'God loves the world.', 'We should love one another.', 'Please show slide number three.', 'Play the next song now.']
}


def build(root):
    rows = []
    for lang, texts in TEXTS.items():
        voices = ['Meijia', 'Eddy (Chinese (Taiwan))'] if lang == 'zh' else ['Samantha', 'Daniel']
        for voice in voices:
            for text in texts:
                row = dict(id=f'opt-neg-{len(rows):03d}', language=lang, kind='negative', text=text,
                           target=None, voice=voice, rate=175, split='challenge')
                path = root / 'audio' / (row['id'] + '.wav')
                subprocess.run(['say', '-v', voice, '-r', '175', '-o', str(path), '--file-format=WAVE',
                                '--data-format=LEI16@16000', text], check=True, timeout=60)
                rows.append(row)
    for lang in ['zh', 'en']:
        for seconds in [1, 3, 5, 10]:
            row = dict(id=f'opt-neg-{len(rows):03d}', language=lang, kind='negative', text='',
                       target=None, voice='silence', rate=0, split='challenge')
            with wave.open(str(root / 'audio' / (row['id'] + '.wav')), 'wb') as wav:
                wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                wav.writeframes(bytes(seconds * 16000 * 2))
            rows.append(row)
    for row in rows:
        path = root / 'audio' / (row['id'] + '.wav')
        row['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        with wave.open(str(path)) as wav:
            row['duration_s'] = wav.getnframes() / wav.getframerate()
    (root / 'optimization-negatives.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(f'Created {len(rows)} challenge fixtures')


if __name__ == '__main__':
    build(Path(sys.argv[1]))
