"""Known synthetic boundaries for pauses, quiet negation and trailing corrections."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import wave

import numpy as np

from run import read_audio


def build(root):
    folder = root / 'segmentation'
    folder.mkdir(exist_ok=True)
    rows = []
    phrases = ['請翻到創世記', '第一章第一節', '請不要切換到',
               '創世記第一章第一節', '只是舉例，請不要切換']
    for voice_index, voice in enumerate(['Meijia', 'Eddy (Chinese (Taiwan))']):
        parts = []
        for index, text in enumerate(phrases):
            path = folder / f'part-{voice_index}-{index}.wav'
            subprocess.run(['say', '-v', voice, '-r', '175', '-o', str(path),
                            '--file-format=WAVE', '--data-format=LEI16@16000', text], check=True)
            audio = read_audio(path)
            active = np.flatnonzero(audio != 0)
            assert len(active)
            parts.append(audio[active[0]:active[-1] + 1])
        for pause in [.2, .8, 1.2]:
            for label, first, second, target, gain in [
                ('reference', 0, 1, [1, 1, 1], 1),
                ('prefix-negation', 2, 3, None, 1),
                ('suffix-negation', 3, 4, None, 1),
                ('quiet-negation', 2, 3, None, .02)
            ]:
                audio = np.r_[np.zeros(16000), parts[first] * gain,
                              np.zeros(round(pause * 16000)), parts[second], np.zeros(16000)]
                ident = f'segment-{len(rows):03d}'
                path = root / 'audio' / f'{ident}.wav'
                with wave.open(str(path), 'wb') as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(16000)
                    wav.writeframes(np.round(audio * 32768).astype('<i2').tobytes())
                rows.append({'id': ident, 'language': 'zh', 'kind': 'reference' if target else 'negative',
                             'target': target, 'text': phrases[first] + '，' + phrases[second],
                             'split': 'segmentation-challenge', 'voice': voice, 'rate': 175,
                             'duration_s': len(audio) / 16000,
                             'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                             'boundary_kind': label, 'internal_pause_s': pause,
                             'prefix_gain': gain, 'first_phrase_start_s': 1,
                             'first_phrase_end_s': 1 + len(parts[first]) / 16000,
                             'second_phrase_start_s': 1 + len(parts[first]) / 16000 + pause,
                             'speech_end_s': (len(audio) - 16000) / 16000})
    assert len(rows) == 24
    (root / 'segmentation-challenge-corpus.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print('Generated 24 synthetic boundary challenges', flush=True)


def prepare_endpoint_probes(root):
    # Diagnostic only: known splice boundaries emulate a naive 600 ms endpoint.
    # Targets retain the whole utterance intent, including a later negation.
    rows = json.loads((root / 'segmentation-challenge-corpus.json').read_text())
    probes = []
    for row in rows:
        audio = read_audio(root / 'audio' / f"{row['id']}.wav", row['sha256'])
        spans = [(0, len(audio))] if row['internal_pause_s'] < .6 else [
            (0, round((row['first_phrase_end_s'] + .3) * 16000)),
            (round((row['second_phrase_start_s'] - .3) * 16000), len(audio))]
        for index, (start, end) in enumerate(spans):
            ident = row['id'] + f'-endpoint-{index}'
            path = root / 'audio' / f'{ident}.wav'
            with wave.open(str(path), 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(np.round(audio[start:end] * 32768).astype('<i2').tobytes())
            probes.append({**row, 'id': ident, 'source_id': row['id'], 'source_sha256': row['sha256'],
                           'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                           'split': 'diagnostic-endpoint', 'duration_s': (end - start) / 16000,
                           'slice_start_s': start / 16000, 'slice_end_s': end / 16000})
    (root / 'segmentation-endpoint-corpus.json').write_text(json.dumps(probes, ensure_ascii=False, indent=2))
    print('Prepared', len(probes), 'diagnostic endpoint pieces', flush=True)


if __name__ == '__main__':
    build(Path(sys.argv[1]))
    prepare_endpoint_probes(Path(sys.argv[1]))
