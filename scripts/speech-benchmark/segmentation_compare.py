"""Alternate paired full/cropped inference on one resident Chinese Turbo model."""
import argparse
from contextlib import ExitStack
import hashlib
import importlib.metadata
import json
from pathlib import Path
import time

from pywhispercpp.model import Model

from run import fitted_audio_context, read_audio
from segmentation import speech_span


def run(root, corpus, output):
    rows = json.loads((root / corpus).read_text())
    assert rows and len({row['id'] for row in rows}) == len(rows)
    assert all(row['language'] == 'zh' for row in rows)
    output.mkdir(parents=True, exist_ok=True)
    model = Model(str(root / 'models/whisper/ggml-large-v3-turbo-q5_0.bin'),
                  params_sampling_strategy=0, n_threads=4, print_progress=False,
                  print_realtime=False, print_timestamps=False, no_context=True,
                  no_timestamps=True, temperature=0.0, temperature_inc=0.0,
                  context_params={'use_gpu': True}, redirect_whispercpp_logs_to=None)
    with ExitStack() as stack:
        files = {mode: stack.enter_context((output / f'{mode}.jsonl').open('w'))
                 for mode in ['whole', 'digital']}
        for mode, file in files.items():
            file.write(json.dumps({'type': 'metadata', 'engine': 'whisper-large-v3-turbo-q5_0',
                                   'version': importlib.metadata.version('pywhispercpp'),
                                   'mode': mode, 'corpus': corpus, 'threads': 4,
                                   'order': 'whole first on even row index, digital first on odd',
                                   'timing': 'resident model; crop + decode; excludes capture, endpoint and UI'}) + '\n')
        for index, row in enumerate(rows):
            audio = read_audio(root / 'audio' / f"{row['id']}.wav", row['sha256'])
            for mode in (['whole', 'digital'] if index % 2 == 0 else ['digital', 'whole']):
                start = time.perf_counter()
                bounds = speech_span(audio, mode) if mode == 'digital' else (0, len(audio))
                payload = audio[bounds[0]:bounds[1]]
                segmentation_s = time.perf_counter() - start
                text = ''.join(segment.text for segment in model.transcribe(
                    payload, language='zh', audio_ctx=fitted_audio_context(768, len(payload))))
                elapsed = time.perf_counter() - start
                result = {**row, 'transcript': text, 'decode_s': elapsed,
                          'segmentation_s': segmentation_s, 'audio_start_s': bounds[0] / 16000,
                          'audio_end_s': bounds[1] / 16000, 'payload_samples': len(payload),
                          'payload_sha256': hashlib.sha256(payload.tobytes()).hexdigest()}
                files[mode].write(json.dumps(result, ensure_ascii=False) + '\n')
                files[mode].flush()
            if index % 20 == 0:
                print(f'Paired {index + 1}/{len(rows)}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('corpus')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    run(args.root, args.corpus, args.output)
