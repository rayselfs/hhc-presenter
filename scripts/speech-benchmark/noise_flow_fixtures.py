"""Export a small actual-Electron screen from the successful light-noise offline set."""
import hashlib
import json
from pathlib import Path
import sys
import wave
import numpy as np
from stationary_noise import mix_noise, windows, RATE

root = Path(sys.argv[1])
output = root / 'noisy-endpoint/flow-fixtures'
output.mkdir(parents=True, exist_ok=True)
results = json.loads((root / 'noisy-endpoint/gain-light-1/results.json').read_text())
corpus = json.loads((root / 'segmentation-paired-corpus.json').read_text())
corpus += json.loads((root / 'segmentation-regression-corpus.json').read_text())
source = {r['id']: r for r in corpus}
selected = ['segment-003', 'segment-007', '0001', '0013', '0291', '0298', 'ref3-106', 'ref3-109']
rows = []
cases = [(i, r['id']) for i, r in enumerate(results[:26]) if r['id'] in selected]
cases += [(26, '0292'), (27, '0297')]
for index, ident in cases:
    row = source[ident]
    path = root / 'audio' / (row['id'] + '.wav')
    assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256']
    with wave.open(str(path)) as wav:
        clean = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
    audio = mix_noise(clean, 40, 20261102 + index)
    # Match the device's PCM16 representation before evaluating the endpoint.
    audio = np.round(audio * 32768).astype('<i2').astype(np.float32) / 32768
    floor = float(np.sqrt(np.mean(audio[:RATE] ** 2)))
    spans = windows(audio, floor)
    assert len(spans) == 1
    first, endpoint, _ = spans[0]
    payload = audio[first:]
    target = output / (row['id'] + '.wav')
    with wave.open(str(target), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(np.round(payload * 32768).astype('<i2').tobytes())
    rows.append({**row, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                 'duration_s': len(payload) / RATE, 'endpoint_sample': endpoint - first,
                 'speech_end_sample': RATE + int(np.flatnonzero(clean)[-1]) - first,
                 'noise_profile': 'fan-40db', 'noise_floor': floor})
assert len(rows) == 10
(output / 'corpus.json').write_text(json.dumps(rows[:8], ensure_ascii=False, indent=2))
(output / 'long-corpus.json').write_text(json.dumps(rows[8:], ensure_ascii=False, indent=2))
