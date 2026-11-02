"""Export bounded strong-noise integration probes, including benign quiet-prefix controls."""
import hashlib
import json
from pathlib import Path
import sys
import wave
import numpy as np
from stationary_noise import mix_noise, windows
from strong_final import read_audio

root = Path(sys.argv[1])
output = root / 'strong-final/flow-fixtures'
output.mkdir(parents=True, exist_ok=True)
cases = json.loads((root / 'strong-final/screen/protocol.json').read_text())['cases']
keys = [('segment-016', 'fan-20db'), ('segment-008', 'fan-20db'),
        ('segment-011', 'fan-20db'), ('segment-011', 'hum-10db'),
        ('benign-0-0-0.02', 'fan-20db'), ('benign-1-0-0.1', 'hum-10db'), ('benign-1-1-0.02', 'fan-20db')]
rows = []
for ident, profile in keys:
    row = next(r for r in cases if r['id'] == ident and r['profile'] == profile)
    path = Path(row['path'])
    assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256']
    clean = read_audio(path)
    audio = mix_noise(clean, 10 if profile.startswith('hum') else 20, row['seed'], profile.startswith('hum'))
    assert np.max(np.abs(audio)) < 1
    audio = np.round(audio * 32768).astype('<i2').astype(np.float32) / 32768
    spans = windows(audio, float(np.sqrt(np.mean(audio[:16000] ** 2))))
    assert len(spans) == 1
    _, endpoint, _ = spans[0]
    name = ident + '-' + profile
    path = output / (name + '.wav')
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(np.round(audio * 32768).astype('<i2').tobytes())
    rows.append({**row, 'id': name, 'kind': 'reference' if row['target'] else 'negative',
                 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'duration_s': len(audio)/16000,
                 'endpoint_sample': endpoint, 'speech_end_sample': 16000 + int(np.flatnonzero(clean)[-1])})
(output / 'corpus.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
