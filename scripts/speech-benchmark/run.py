"""Sequential in-process ASR timing on pre-segmented local WAV fixtures."""
import argparse
import importlib.metadata
import hashlib
import json
from pathlib import Path
import sys
import time
import wave

import psutil
try:
    import resource
except ImportError:
    resource = None

import numpy as np
from metrics import score


def peak_rss_bytes():
    if resource is not None:
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return value if sys.platform == 'darwin' else value * 1024
    return psutil.Process().memory_info().peak_wset


def read_audio(path, expected_hash=None):
    if expected_hash and hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
        raise ValueError(f'Audio checksum mismatch: {path}')
    with wave.open(str(path)) as wav:
        assert wav.getframerate() == 16000 and wav.getnchannels() == 1 and wav.getsampwidth() == 2
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768


def fitted_audio_context(requested, samples):
    # Whisper audio tokens cover 20 ms at 16 kHz; long input needs the full context.
    return requested if samples <= requested * 320 else 0


def run(args):
    rows = json.loads((args.root / args.corpus).read_text())
    books = json.loads((args.root / 'books.json').read_text())
    if args.subset == 'screen':
        rows = [r for r in rows if r['split'] == 'calibration' or r['kind'] == 'negative']
    elif args.subset == 'calibration':
        rows = [r for r in rows if r['split'] == 'calibration']
    if args.language:
        rows = [r for r in rows if r['language'] == args.language]
    if args.limit:
        rows = rows[:args.limit]
    started = time.perf_counter()
    if args.engine.startswith('whisper-'):
        from pywhispercpp.model import Model
        model = Model(str(args.root / 'models/whisper' / f'ggml-{args.engine[8:]}.bin'),
                      params_sampling_strategy=1 if args.beam_size else 0,
                      n_threads=4, print_progress=False, print_realtime=False, print_timestamps=False,
                      no_context=True, no_timestamps=True, temperature=0.0, temperature_inc=0.0,
                      context_params={'use_gpu': not args.cpu}, redirect_whispercpp_logs_to=None)
        def transcribe(audio, language):
            options = {'language': args.decode_language or language}
            if args.audio_ctx:
                options['audio_ctx'] = (fitted_audio_context(args.audio_ctx, len(audio))
                                        if args.fit_audio_context else args.audio_ctx)
            if args.beam_size:
                options['beam_search'] = {'beam_size': args.beam_size, 'patience': 1.0}
            if args.short_prompt:
                options['initial_prompt'] = ('聖經經文，書卷、章、節。耶和華、耶穌、以色列。' if language == 'zh'
                                             else 'Bible scripture, book, chapter, verse. Jesus, Israel, Corinthians.')
            if args.bias:
                options['initial_prompt'] = ', '.join(book[language] for book in books)
            return ''.join(s.text for s in model.transcribe(audio, **options))
        version = importlib.metadata.version('pywhispercpp')
    elif args.engine == 'sensevoice':
        import sherpa_onnx
        folder = args.root / 'models/sensevoice'
        model = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(folder / 'model.int8.onnx'), tokens=str(folder / 'tokens.txt'),
            num_threads=4, provider='cpu', language='auto', use_itn=True)
        def transcribe(audio, language):
            stream = model.create_stream()
            stream.accept_waveform(16000, audio)
            model.decode_stream(stream)
            return stream.result.text
        version = importlib.metadata.version('sherpa-onnx')
    else:
        import sherpa_onnx
        from opencc import OpenCC
        folder = args.root / 'models/sherpa'
        suffix = '.onnx' if args.engine == 'sherpa-fp32' else '.int8.onnx'
        hotwords = args.root / 'hotwords.txt'
        if args.bias:
            converter = OpenCC('t2s')
            hotwords.write_text('\n'.join(converter.convert(book['zh']) + '\n' + book['en'].upper() for book in books))
        model = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(folder / 'tokens.txt'), encoder=str(folder / f'encoder-epoch-99-avg-1{suffix}'),
            decoder=str(folder / f'decoder-epoch-99-avg-1{suffix}'), joiner=str(folder / f'joiner-epoch-99-avg-1{suffix}'),
            num_threads=4, provider='cpu', decoding_method='modified_beam_search' if args.beam or args.bias else 'greedy_search',
            hotwords_file=str(hotwords) if args.bias else '',
            modeling_unit='cjkchar+bpe', bpe_vocab=str(folder / 'bpe.vocab'))
        def transcribe(audio, language):
            stream = model.create_stream()
            # Chunked computation, not a wall-clock microphone latency measurement.
            for offset in range(0, len(audio), 1600):
                stream.accept_waveform(16000, audio[offset:offset + 1600])
                while model.is_ready(stream):
                    model.decode_stream(stream)
            stream.accept_waveform(16000, np.zeros(4800, dtype=np.float32))
            stream.input_finished()
            while model.is_ready(stream):
                model.decode_stream(stream)
            return model.get_result(stream)
        version = importlib.metadata.version('sherpa-onnx')
    load_s = time.perf_counter() - started
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w') as out:
        out.write(json.dumps({'type': 'metadata', 'engine': args.engine, 'version': version,
                              'load_s': load_s, 'threads': 4, 'cpu_only': args.cpu or args.engine.startswith('sherpa') or args.engine == 'sensevoice',
                              'bias': args.bias, 'subset': args.subset, 'short_prompt': args.short_prompt,
                              'beam_size': args.beam_size, 'corpus': args.corpus, 'language': args.language,
                              'decode_language': args.decode_language, 'audio_ctx': args.audio_ctx,
                              'fit_audio_context': args.fit_audio_context,
                              'beam': args.beam or (args.bias and args.engine.startswith('sherpa')),
                              'timing': 'presegmented waveform decode; excludes capture, VAD endpoint and UI'}) + '\n')
        for i, row in enumerate(rows):
            audio = read_audio(args.root / 'audio' / f"{row['id']}.wav", row['sha256'])
            start_cpu = time.process_time()
            start = time.perf_counter()
            text = transcribe(audio, row['language'])
            elapsed = time.perf_counter() - start
            result = {**row, 'transcript': text, 'decode_s': elapsed, 'cpu_s': time.process_time() - start_cpu,
                      'rtf': elapsed / row['duration_s'], 'max_rss_bytes': peak_rss_bytes(),
                      **score(row, text, books)}
            out.write(json.dumps(result, ensure_ascii=False) + '\n')
            out.flush()
            if i % 25 == 0:
                print(f'{args.engine}: {i + 1}/{len(rows)} {elapsed:.3f}s {text[:75]}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('engine', choices=['sensevoice', 'sherpa', 'sherpa-fp32', 'whisper-base', 'whisper-small', 'whisper-large-v3-turbo-q5_0'])
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--subset', choices=['all', 'screen', 'calibration'], default='all')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--corpus', default='corpus.json')
    parser.add_argument('--language', choices=['zh', 'en'])
    parser.add_argument('--decode-language', choices=['zh', 'en', 'auto'])
    parser.add_argument('--audio-ctx', type=int, choices=[512, 768])
    parser.add_argument('--fit-audio-context', action='store_true')
    parser.add_argument('--short-prompt', action='store_true')
    parser.add_argument('--beam-size', type=int, choices=[3, 5])
    parser.add_argument('--bias', action='store_true')
    parser.add_argument('--cpu', action='store_true')
    parser.add_argument('--beam', action='store_true')
    run(parser.parse_args())
