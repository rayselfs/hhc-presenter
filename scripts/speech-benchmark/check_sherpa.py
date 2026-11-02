"""Check quantization and chunk-size effects on upstream and fixed corpus audio."""
import argparse
import json
from pathlib import Path
import numpy as np
import sherpa_onnx
from run import read_audio

parser = argparse.ArgumentParser()
parser.add_argument('root', type=Path)
args = parser.parse_args()
folder = args.root / 'models/sherpa'
results = []
for suffix in ['.int8.onnx', '.onnx']:
    model = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(folder / 'tokens.txt'), encoder=str(folder / f'encoder-epoch-99-avg-1{suffix}'),
        decoder=str(folder / f'decoder-epoch-99-avg-1{suffix}'), joiner=str(folder / f'joiner-epoch-99-avg-1{suffix}'),
        num_threads=4, provider='cpu')
    for name in ['sherpa-upstream-test.wav', 'audio/0000.wav', 'audio/0300.wav', 'audio/0600.wav']:
        audio = read_audio(args.root / name)
        for chunk_size in [1600, len(audio)]:
            stream = model.create_stream()
            for start in range(0, len(audio), chunk_size):
                stream.accept_waveform(16000, audio[start:start + chunk_size])
                while model.is_ready(stream):
                    model.decode_stream(stream)
            stream.accept_waveform(16000, np.zeros(4800, dtype=np.float32))
            stream.input_finished()
            while model.is_ready(stream):
                model.decode_stream(stream)
            result = {'suffix': suffix, 'audio': name, 'chunk_size': chunk_size,
                      'text': model.get_result(stream)}
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
(args.root / 'sherpa-diagnostic.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
