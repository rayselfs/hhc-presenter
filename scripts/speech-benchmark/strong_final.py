"""Final synthetic strong-noise screen; ambiguity guard and conservative raw retry."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import wave
import numpy as np
from stationary_noise import mix_noise, windows, balance_volume
from quiet_audio_guard import quiet_evidence


from conservative_retry import retryable


def read_audio(path):
    with wave.open(str(path)) as wav:
        assert (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) == (1, 16000, 2)
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768


def build_benign(root):
    output = root / 'strong-final/benign'
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for vi, voice in enumerate(['Meijia', 'Eddy (Chinese (Taiwan))']):
        command = read_audio(root / 'segmentation' / f'part-{vi}-3.wav')
        active = np.flatnonzero(command)
        command = command[active[0]:active[-1] + 1]
        for pi, phrase in enumerate(['我們一起來看', '接下來', '弟兄姊妹']):
            path = output / f'prefix-{vi}-{pi}.wav'
            subprocess.run(['say', '-v', voice, '-r', '175', '-o', str(path),
                            '--file-format=WAVE', '--data-format=LEI16@16000', phrase], check=True)
            prefix = read_audio(path)
            active = np.flatnonzero(prefix)
            prefix = prefix[active[0]:active[-1] + 1]
            for gain in [.02, .1]:
                ident = f'benign-{vi}-{pi}-{gain}'
                audio = np.r_[np.zeros(16000), prefix * gain, np.zeros(12800), command, np.zeros(16000)]
                path = output / f'{ident}.wav'
                with wave.open(str(path), 'wb') as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(16000)
                    wav.writeframes(np.round(audio * 32768).astype('<i2').tobytes())
                rows.append({'id': ident, 'target': [1, 1, 1], 'path': str(path), 'text': phrase + '，創世記第一章第一節',
                             'voice': voice, 'prefix_gain': gain, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (output / 'corpus.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    return rows


def main(root, output):
    output.mkdir(parents=True, exist_ok=True)
    source = {r['id']: r for r in json.loads((root / 'segmentation-paired-corpus.json').read_text()) +
              json.loads((root / 'segmentation-regression-corpus.json').read_text())}
    cases = []
    for folder in ['noisy-endpoint/gain-strong-1', 'strong-negation/strong-holdout', 'noisy-endpoint/gain-light-1', 'noisy-endpoint/gain-holdout-1']:
        baseline = json.loads((root / folder / 'results.json').read_text())
        for i, result in enumerate(baseline):
            row = source[result['id']]
            cases.append({**row, 'path': str(root / 'audio' / (row['id'] + '.wav')),
                          'profile': result['profile'], 'seed': 20261102 + i % (len(baseline) // 2),
                          'baseline': result['decisions'][0]['reference']})
    for i, row in enumerate(build_benign(root)):
        for profile in ['fan-20db', 'hum-10db']:
            cases.append({**row, 'profile': profile, 'seed': 20261120 + i, 'baseline': None})
    if '--benign-only' in sys.argv:
        cases = [row for row in cases if row['id'].startswith('benign-')]
    (output / 'protocol.json').write_text(json.dumps({'cases': cases, 'guard': 'frozen previous threshold',
        'measurement': 'Offline estimate; known one-second calibration. No display timing.'}, ensure_ascii=False, indent=2))
    child = subprocess.Popen([sys.executable, '-u', str(Path(__file__).with_name('live_runtime.py')), str(root)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        env={**os.environ, 'HHC_SPEECH_NOISE_GAIN': '0', 'HHC_SPEECH_NOISE_CONTEXT': '1', 'HHC_SPEECH_NOISE_WARMUP': '0', 'HHC_SPEECH_STRONG_PROBE': '0',
                           'HHC_SPEECH_STRICT_CITATIONS': '1'})
    assert json.loads(child.stdout.readline()) == {'ready': True}
    def decode(audio):
        import base64
        child.stdin.write(json.dumps({'pcm': base64.b64encode(audio.astype('<f4').tobytes()).decode()}) + '\n')
        child.stdin.flush()
        return json.loads(child.stdout.readline())
    results = []
    try:
        for row in cases:
            path = Path(row['path'])
            assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256']
            clean = read_audio(path)
            hum = row['profile'].startswith('hum')
            snr = int(row['profile'].split('-')[1].removesuffix('db'))
            audio = mix_noise(clean, snr, row['seed'], hum)
            spans = windows(audio, float(np.sqrt(np.mean(audio[:16000] ** 2))))
            decisions = []
            for first, end, _ in spans:
                start = time.perf_counter()
                guard = quiet_evidence(audio[:end])
                initial = decode(balance_volume(audio[:end])[first:end])
                retry = decode(audio[first:end]) if not guard['uncertain_prefix'] and retryable(initial['text'], initial['reference'], end-first) else None
                reference = None if guard['uncertain_prefix'] else (retry or initial)['reference']
                elapsed = (time.perf_counter()-start)*1000
                decisions.append({'guarded': guard['uncertain_prefix'], 'initial': initial, 'retry': retry,
                                  'reference': reference, 'endpoint_sample': end,
                                  'estimated_ms': (end - 16000 - int(np.flatnonzero(clean)[-1])) / 16 + elapsed})
            result = {'id': row['id'], 'profile': row['profile'], 'target': row['target'],
                      'baseline': row['baseline'], 'decisions': decisions,
                      'correct': row['target'] is not None and any(d['reference'] == row['target'] for d in decisions),
                      'wrong': any(d['reference'] is not None and d['reference'] != row['target'] for d in decisions)}
            results.append(result)
            (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
            print(row['id'], row['profile'], 'correct', result['correct'], 'wrong', result['wrong'], 'windows', len(spans), flush=True)
    finally:
        child.stdin.close()
        child.wait(timeout=30)


if __name__ == '__main__':
    main(*map(Path, sys.argv[1:3]))
