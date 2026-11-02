"""Experimental outer-silence cropping; never split an internal pause."""
import numpy as np


def is_digital_silence(audio):
    return not np.any(audio)


def speech_span(audio, mode='energy'):
    frame = 320  # 20 ms at the benchmark's fixed 16 kHz sample rate.
    padding = 4800
    if not len(audio):
        return 0, 0
    if mode == 'digital':
        frame = 1
        active = np.flatnonzero(audio != 0)
    else:
        padded = np.pad(audio, (0, (-len(audio)) % frame))
        rms = np.sqrt(np.mean(padded.reshape(-1, frame) ** 2, axis=1))
        active = np.flatnonzero(rms >= 0.001)
    # Ambiguous/silent input retains the original audio and rejection policy.
    if not len(active):
        return 0, len(audio)
    return max(0, int(active[0]) * frame - padding), min(
        len(audio), (int(active[-1]) + 1) * frame + padding)
