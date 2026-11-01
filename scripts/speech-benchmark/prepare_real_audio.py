"""Prepare private, unlabeled recording windows. Never copy these artifacts into Git."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import wave


def prepare(source, destination, model_root):
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'audio').mkdir(exist_ok=True)
    for name in ['models', 'books.json', 'sources']:
        target = destination / name
        if not target.exists():target.symlink_to(model_root / name, target_is_directory=name != 'books.json')
    rows, manifest = [], []
    for index, file in enumerate(sorted(source.glob('*.mp3')), 1):
        recording = f'recording-{index:02d}'
        pcm = destination / (recording + '.wav')
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(file), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(pcm)], check=True)
        with wave.open(str(pcm)) as wav:
            assert wav.getframerate() == 16000 and wav.getnchannels() == 1 and wav.getsampwidth() == 2
            frames = wav.readframes(wav.getnframes())
        samples = len(frames) // 2
        manifest.append({'id': recording, 'source': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'duration_s': samples / 16000})
        for n, start in enumerate(range(0, samples, 18 * 16000)):
            end = min(start + 20 * 16000, samples)
            if end - start < 16000:continue
            ident = f'{recording}-{n:03d}'
            path = destination / 'audio' / (ident + '.wav')
            with wave.open(str(path), 'wb') as wav:
                wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                wav.writeframes(frames[start * 2:end * 2])
            rows.append({'id': ident, 'language': 'zh', 'kind': 'unlabeled', 'target': None, 'text': '',
                         'split': 'private-real-audio', 'voice': recording, 'rate': 0,
                         'recording': recording, 'offset_s': start / 16000, 'duration_s': (end - start) / 16000,
                         'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (destination / 'corpus.json').write_text(json.dumps(rows, indent=2))
    (destination / 'private-source-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print('Prepared',len(manifest),'recordings and',len(rows),'overlapping windows; not ground truth')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('model_root', type=Path)
    args = parser.parse_args()
    prepare(args.source, args.destination, args.model_root)
