"""Experimental acoustic ambiguity evidence; does not infer words or intent."""
import numpy as np

RATE = 16000


def quiet_evidence(audio):
    audio = np.asarray(audio)
    if audio.ndim != 1 or not np.isfinite(audio).all() or np.max(np.abs(audio), initial=0) > 1:
        raise ValueError('Invalid normalized mono PCM')
    # shortcut: requires supplied noise-only calibration; not suitable for automatic live use.
    frame, hop = 512, 160
    if len(audio) < RATE + frame:
        raise ValueError('A one-second noise calibration is required')
    chunks = np.lib.stride_tricks.sliding_window_view(audio, frame)[::hop]
    spectra = np.abs(np.fft.rfft(chunks * np.hanning(frame))) ** 2
    bins = (np.fft.rfftfreq(frame, 1 / RATE) >= 250) & (np.fft.rfftfreq(frame, 1 / RATE) <= 4000)
    noise = np.mean(spectra[:(RATE - frame) // hop], axis=0)[bins]
    rms = np.sqrt(np.mean(chunks ** 2, axis=1))
    floor = float(np.sqrt(np.mean(audio[:RATE] ** 2)))
    strong = np.flatnonzero((rms > floor * 3) & (np.arange(len(rms)) * hop >= RATE))
    if not len(strong):
        return {'strong_start_s': None, 'prefix_max': 0, 'prefix_frames': [], 'uncertain_prefix': False}
    first = int(strong[0])
    scores = []
    for i in range(RATE // hop, max(RATE // hop, first - 20), 10):
        power = np.mean(spectra[i:i + 20], axis=0)[bins]
        ratios = power / np.maximum(noise, 1e-20)
        score = float(np.mean(np.sort(ratios)[-5:]))
        scores.append([round(i * hop / RATE, 2), score])
    uncertain = any(scores[i][1] > 3 and scores[i + 1][1] > 3 for i in range(len(scores) - 1))
    return {'uncertain_prefix': uncertain, 'strong_start_s': first * hop / RATE, 'prefix_max': max((r[1] for r in scores), default=0),
            'prefix_frames': scores}
