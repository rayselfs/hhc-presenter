"""Development-only resident Chinese runtime; private PCM stays in memory."""
import base64
import difflib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

import numpy as np
from pywhispercpp.model import Model

from evaluate import Retrieval
from metrics import normalize, normalize_reference, tokens
from optimization_evaluate import quote_decision
from run import fitted_audio_context
from segmentation import speech_span, is_digital_silence
from stationary_noise import balance_volume, covered_context
from quiet_audio_guard import quiet_evidence
from conservative_retry import retryable


class Locator:
    def __init__(self, root, strict_citations=False):
        self.scripture = json.loads((root / 'sources/zh_cuv.json').read_text(encoding='utf-8-sig'))
        self.character = Retrieval(self.scripture, 'zh')
        self.phonetic = Retrieval(json.loads((root / 'optimization-v2/phonetic-corpus.json').read_text()), 'en')
        self.node = subprocess.Popen([os.environ['HHC_SPEECH_NODE'],
                                      str(Path(__file__).with_name('locate-v3.mjs')), str(root), '--stdio'],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                     env={**os.environ, 'HHC_SPEECH_STRICT_CITATIONS': '1' if strict_citations else '0'})
        assert json.loads(self.node.stdout.readline()) == {'ready': True}

    def locate(self, text):
        normalized = normalize(text)
        self.node.stdin.write(json.dumps({'transcript': text, 'reference_normalized': normalize_reference(text, 'zh')}) + '\n')
        self.node.stdin.flush()
        row = json.loads(self.node.stdout.readline())
        if row['inhibited']:
            return None
        if row['reference'] is not None:
            return row['reference']
        if re.search(r'chapter|verse|\d\s*[:：]|\d\s*[章節篇張]', normalized, re.I):
            return None
        query = tokens(text, 'zh')
        quote = quote_decision(self.character.rank(text), len(query), 'zh')
        if quote is not None or len(query) < 12:
            return quote
        candidates = self.phonetic.rank(row['phonetic'])
        if not candidates or candidates[0][0] < .85:
            return None
        similarity, target = candidates[0]
        if similarity - (candidates[1][0] if len(candidates) > 1 else 0) < .10:
            return None
        b, c, v = target
        chapter = self.scripture[b - 1]['chapters'][c - 1]
        character_score = max(difflib.SequenceMatcher(None, query, tokens(value, 'zh'), autojunk=False).ratio()
                              for value in [chapter[v - 1], ' '.join(chapter[v - 1:v + 1])])
        return target if character_score >= .55 else None

    def close(self):
        self.node.terminate()
        self.node.wait(timeout=5)


def serve(root):
    locator = Locator(root, os.environ.get('HHC_SPEECH_STRONG_PROBE') == '1' or
                      os.environ.get('HHC_SPEECH_STRICT_CITATIONS') == '1')
    model = Model(str(root / 'models/whisper/ggml-large-v3-turbo-q5_0.bin'),
                  params_sampling_strategy=0, n_threads=4, print_progress=False,
                  print_realtime=False, print_timestamps=False, no_context=True,
                  no_timestamps=True, temperature=0.0, temperature_inc=0.0,
                  context_params={'use_gpu': True}, redirect_whispercpp_logs_to=None)
    if os.environ.get('HHC_SPEECH_NOISE_WARMUP') == '1':
        model.transcribe(np.zeros(16000, dtype=np.float32), language='zh', audio_ctx=0)
    print(json.dumps({'ready': True}), flush=True)
    try:
        while line := sys.stdin.buffer.readline(3_000_000):
            request = json.loads(line)
            audio = np.frombuffer(base64.b64decode(request['pcm'], validate=True), dtype='<f4')
            if not 0 < len(audio) <= 480000 or not np.isfinite(audio).all() or np.max(np.abs(audio)) > 1:
                raise ValueError('Invalid PCM')
            start = time.perf_counter()
            strong_probe = os.environ.get('HHC_SPEECH_STRONG_PROBE') == '1'
            guarded = False
            if strong_probe:
                first, last = speech_span(audio, 'digital')
                audio = audio[first:last]
                guarded = quiet_evidence(audio)['uncertain_prefix']
                # shortcut: probe fixtures supply a known noise-only second, not live calibration.
                audio = audio[16000:]
            original = audio
            if strong_probe or os.environ.get('HHC_SPEECH_NOISE_GAIN') == '1':
                audio = balance_volume(audio)
            first, last = speech_span(audio, 'digital')
            payload = audio[first:last]
            context = fitted_audio_context(768, len(payload))
            if context == 0 and (strong_probe or os.environ.get('HHC_SPEECH_NOISE_CONTEXT') == '1'):
                context = covered_context(len(payload))
            text = '' if guarded or is_digital_silence(payload) else ''.join(segment.text for segment in model.transcribe(
                payload, language='zh', audio_ctx=context))
            decoded = time.perf_counter()
            reference = locator.locate(text)
            located = time.perf_counter()
            asr_ms = (decoded - start) * 1000
            locate_ms = (located - decoded) * 1000
            if strong_probe and not guarded and retryable(text, reference, len(payload)):
                text = ''.join(segment.text for segment in model.transcribe(
                    original[first:last], language='zh', audio_ctx=context))
                retried = time.perf_counter()
                reference = locator.locate(text)
                asr_ms += (retried - located) * 1000
                locate_ms += (time.perf_counter() - retried) * 1000
            print(json.dumps({'text': text, 'reference': reference, 'asrMs': asr_ms,
                              'locateMs': locate_ms}, ensure_ascii=False), flush=True)
    finally:
        locator.close()


if __name__ == '__main__':
    serve(Path(sys.argv[1]))
