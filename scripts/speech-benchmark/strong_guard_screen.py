"""Guard evaluation against fixed noisy decisions; waveform-only guard never reads target/text."""
import hashlib
import json
from pathlib import Path
import sys
import wave
import numpy as np
from stationary_noise import mix_noise
from quiet_audio_guard import quiet_evidence

root, output = map(Path, sys.argv[1:3])
output.mkdir(parents=True, exist_ok=True)
source = {r['id']: r for r in json.loads((root / 'segmentation-paired-corpus.json').read_text()) +
          json.loads((root / 'segmentation-regression-corpus.json').read_text())}
results = []
for run in ['gain-strong-1', 'gain-light-1', 'gain-holdout-1', 'strong-holdout']:
    directory = root / ('strong-negation' if run == 'strong-holdout' else 'noisy-endpoint') / run
    baseline = json.loads((directory / 'results.json').read_text())
    per_profile = len(baseline) // 2
    for index, row in enumerate(baseline):
        path = root / 'audio' / (row['id'] + '.wav')
        assert hashlib.sha256(path.read_bytes()).hexdigest() == source[row['id']]['sha256']
        with wave.open(str(path)) as wav:
            assert (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) == (1, 16000, 2)
            clean = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
        hum = index >= per_profile
        snr = 40 if run not in ['gain-strong-1', 'strong-holdout'] else 10 if hum else 20
        audio = mix_noise(clean, snr, 20261102 + index % per_profile, hum)
        end = row['decisions'][0]['endpoint_sample']
        evidence = quiet_evidence(audio[:end])
        guarded = evidence['uncertain_prefix']
        results.append({'id':row['id'],'run':run,'profile':row['profile'],'target':row['target'],
                        'guarded':guarded,'lost_correct':guarded and row['correct'],
                        'wrong_after_guard':row['wrong'] and not guarded,'evidence':evidence})
(output/'results.json').write_text(json.dumps(results,indent=2))
print(json.dumps({'cases':len(results),'guarded':sum(x['guarded'] for x in results),
                  'lost_correct':sum(x['lost_correct'] for x in results),
                  'wrong_after_guard':sum(x['wrong_after_guard'] for x in results)}))
