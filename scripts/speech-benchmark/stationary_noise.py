"""Experimental stationary-noise processing; not enabled in the product."""
import math
import numpy as np

RATE = 16000
FRAME = 320


def windows(audio, floor):
    # Three-frame power average reduces stationary noise jitter without changing PCM.
    powers = []
    start = None
    last = None
    spans = []
    for offset in range(RATE, len(audio) - FRAME + 1, FRAME):
        power = float(np.mean(audio[offset:offset + FRAME] ** 2))
        powers.append(power)
        powers = powers[-3:]
        active = math.sqrt(sum(powers) / len(powers)) > max(0.000001, floor * 1.15)
        if active:
            if start is None:
                start = max(RATE, offset - RATE * 5)
            last = offset + FRAME
        if last is not None and offset + FRAME - last >= RATE * 1.5:
            spans.append((start, offset + FRAME, last))
            start = last = None
    return spans


def denoise(audio):
    size, hop = 512, 128
    window = np.hanning(size)
    padded = np.pad(audio, (size, size))
    frames = np.lib.stride_tricks.sliding_window_view(padded, size)[::hop]
    spectrum = np.fft.rfft(frames * window)
    power = np.abs(spectrum) ** 2
    calibration = power[4:RATE // hop]
    noise = np.mean(calibration, axis=0)
    smooth = (np.pad(power, ((1, 1), (0, 0)), mode='edge')[:-2] + power +
              np.pad(power, ((1, 1), (0, 0)), mode='edge')[2:]) / 3
    gain = np.clip(1 - 1.2 * noise / np.maximum(smooth, 1e-20), .05, 1)
    rebuilt = np.fft.irfft(spectrum * gain, n=size) * window
    output = np.zeros(len(padded))
    weights = np.zeros(len(padded))
    for i, frame in enumerate(rebuilt):
        offset = i * hop
        output[offset:offset + size] += frame
        weights[offset:offset + size] += window ** 2
    return (output / np.maximum(weights, 1e-12))[size:size + len(audio)].astype(np.float32)



def balance_volume(audio):
    # Bounded local gain; preserve samples and never clip strong speech.
    hop = 1600
    padded = np.pad(audio, (0, (-len(audio)) % hop))
    blocks = padded.reshape(-1, hop)
    rms = np.sqrt(np.mean(blocks ** 2, axis=1))
    gain = np.clip(.05 / np.maximum(rms, 1e-8), 1, 10)
    centers = np.arange(len(gain)) * hop + hop / 2
    envelope = np.interp(np.arange(len(audio)), centers, gain)
    result = audio * envelope
    peak = np.max(np.abs(result))
    return (result / max(1, peak / .98)).astype(np.float32)


def mix_noise(clean, snr_db, seed, hum=False):
    active = clean[clean != 0]
    voice_rms = float(np.sqrt(np.mean(active ** 2)))
    level = voice_rms / (10 ** (snr_db / 20))
    padded = np.pad(clean, (RATE, RATE * 3))
    noise = np.random.default_rng(seed).normal(size=len(padded))
    if hum:
        t = np.arange(len(noise)) / RATE
        noise = .2 * noise + np.sin(2 * np.pi * 60 * t) + .4 * np.sin(2 * np.pi * 120 * t)
    noise *= level / np.sqrt(np.mean(noise ** 2))
    return (padded + noise).astype(np.float32)


def covered_context(samples):
    required = (samples + 319) // 320
    context = max(768, ((required + 63) // 64 + 1) * 64)
    return context if context < 1500 else 0
