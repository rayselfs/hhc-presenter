"""Stationary-noise endpoint screen. Synthetic fixtures only; no audio is discarded inside a turn."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import wave
import numpy as np
from stationary_noise import windows, denoise, balance_volume, mix_noise

ROOT = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
RATE = 16000


def read_audio(row):
    path = ROOT / 'audio' / (row['id'] + '.wav')
    assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256']
    with wave.open(str(path)) as wav:
        assert (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) == (1, RATE, 2)
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768


def preprocess(audio):
    if '--rnnoise' in sys.argv:
        model = ROOT / 'models/rnnoise/sh.rnnn'
        result = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(RATE), '-ac', '1',
                                 '-i', 'pipe:0', '-af', 'aresample=48000,arnndn=m=' + str(model) + ',aresample=16000',
                                 '-f', 'f32le', 'pipe:1'], input=audio.astype('<f4').tobytes(), capture_output=True, check=True)
        filtered = np.frombuffer(result.stdout, dtype='<f4')
        # FFmpeg flushes a final partial 10 ms frame; the input already ends with >=1.5 s of background.
        assert len(audio) <= len(filtered) <= len(audio) + 320, (len(filtered), len(audio))
        return filtered[:len(audio)]
    filtered = denoise(audio) if '--denoise' in sys.argv else audio
    return balance_volume(filtered) if '--agc' in sys.argv else filtered


corpus = json.loads((ROOT / 'segmentation-paired-corpus.json').read_text())
original = json.loads((ROOT / 'segmentation-regression-corpus.json').read_text())
baseline = {r['id']: r for r in map(json.loads, (ROOT / 'segmentation/regression-digital-v3.decisions.jsonl').read_text().splitlines())}
selected = [r for r in corpus if r['split'] == 'segmentation-challenge'][:8]
selected += [r for r in original if r['kind'] == 'reference' and baseline[r['id']]['phonetic-0.85']['correct']][:12]
selected += [r for r in original if r['id'] in ['0291', '0298']]
selected += [r for r in original if r['kind'] == 'negative' and r['id'].startswith('ref3-')][:4]
if '--quiet-suffix' in sys.argv:
    selected = [r for r in corpus if r.get('boundary_kind') == 'suffix-negation']
elif '--holdout' in sys.argv:
    selected = [r for r in corpus if r['split'] == 'segmentation-challenge'][8:]
protocol = {'ids': [r['id'] for r in selected], 'source_sha256': {r['id']: r['sha256'] for r in selected}, 'profiles': ['fan-40db', 'hum-40db'] if '--light' in sys.argv else ['fan-20db', 'hum-10db'], 'seed': 20261102, 'holdout': '--holdout' in sys.argv, 'quiet_suffix': '--quiet-suffix' in sys.argv, 'agc': '--agc' in sys.argv,
            'calibration_s': 1, 'endpoint_s': 1.5, 'threshold_ratio': 1.15, 'denoise': 'rnnoise-sh' if '--rnnoise' in sys.argv else 'spectral' if '--denoise' in sys.argv else 'none',
            'measurement': 'Offline screening: estimated last clean source sample to endpoint plus native processing. Not screen latency.'}
if '--rnnoise' in sys.argv:
    model_hash = hashlib.sha256((ROOT / 'models/rnnoise/sh.rnnn').read_bytes()).hexdigest()
    assert model_hash == '70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0'
    protocol['rnnoise_sha256'] = model_hash
(OUT / 'protocol.json').write_text(json.dumps(protocol, indent=2))
child = subprocess.Popen([sys.executable, '-u', str(Path(__file__).with_name('live_runtime.py')), str(ROOT)],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                         env={**os.environ, 'HHC_SPEECH_NOISE_GAIN': '0',
                              'HHC_SPEECH_NOISE_CONTEXT': '0', 'HHC_SPEECH_NOISE_WARMUP': '0'})
assert json.loads(child.stdout.readline()) == {'ready': True}


def decode(audio):
    child.stdin.write(json.dumps({'pcm': base64.b64encode(audio.astype('<f4').tobytes()).decode()}) + '\n')
    child.stdin.flush()
    return json.loads(child.stdout.readline())


results = []
try:
    for profile_index, profile in enumerate(protocol['profiles']):
        for index, row in enumerate(selected):
            clean = read_audio(row)
            if '--quiet-suffix' in sys.argv:
                clean[round(row['second_phrase_start_s'] * RATE):round(row['speech_end_s'] * RATE)] *= .02
            snr = 40 if '--light' in sys.argv else 20 if profile_index == 0 else 10
            audio = mix_noise(clean, snr, 20261102 + index, bool(profile_index))
            assert np.max(np.abs(audio)) <= 1
            floor = float(np.sqrt(np.mean(audio[:RATE] ** 2)))
            spans = windows(audio, floor)
            source_end = RATE + int(np.flatnonzero(clean)[-1])
            filtered = preprocess(audio)
            full = decode(filtered[RATE:RATE + len(clean)])
            decisions = []
            for first, end, _detected in spans:
                preprocessing = time.perf_counter()
                # Use only calibration and samples available at the endpoint, never future audio.
                prefix = preprocess(audio[:end])
                preprocessing_ms = (time.perf_counter() - preprocessing) * 1000
                answer = decode(prefix[first:end])
                answer['estimated_ms'] = (end - source_end) / 16 + answer['asrMs'] + answer['locateMs'] + preprocessing_ms
                answer['endpoint_sample'] = end
                decisions.append(answer)
            correct = row['target'] is not None and any(d['reference'] == row['target'] for d in decisions)
            wrong = any(d['reference'] is not None and d['reference'] != row['target'] for d in decisions)
            result = {'id': row['id'], 'profile': profile, 'target': row['target'], 'floor': floor,
                      'full': full, 'decisions': decisions, 'correct': correct, 'wrong': wrong,
                      'lost_vs_noisy_full': row['target'] is not None and full['reference'] == row['target'] and not correct,
                      'lost_vs_clean': row['target'] is not None and not correct}
            results.append(result)
            (OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
            print(profile, row['id'], 'correct', correct, 'wrong', wrong, 'windows', len(spans), flush=True)
finally:
    child.stdin.close()
    child.wait(timeout=30)
summary = {'n': len(results), 'correct': sum(r['correct'] for r in results),
           'wrong': sum(r['wrong'] for r in results), 'lost_vs_noisy_full': sum(r['lost_vs_noisy_full'] for r in results),
           'lost_vs_clean': sum(r['lost_vs_clean'] for r in results)}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
print(summary)
