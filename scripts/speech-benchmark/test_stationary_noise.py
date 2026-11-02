import unittest
import numpy as np
from stationary_noise import windows, denoise, balance_volume, covered_context, mix_noise, RATE


class StationaryNoiseTests(unittest.TestCase):
    def test_context_covers_every_sample_with_headroom(self):
        for count in [1, 245760, 245761, 320000, 400000, 480000]:
            context = covered_context(count)
            self.assertTrue(context == 0 or context * 320 >= count + 64 * 320)
        self.assertEqual(covered_context(480000), 0)

    def test_noise_fixture_is_repeatable_with_a_clean_calibration_prefix(self):
        signal = np.full(RATE * 2, .1, dtype=np.float32)
        first = mix_noise(signal, 40, 42)
        np.testing.assert_array_equal(first, mix_noise(signal, 40, 42))
        self.assertEqual(len(first), len(signal) + RATE * 4)
        self.assertLess(np.sqrt(np.mean(first[:RATE] ** 2)), .002)
        self.assertGreater(np.mean(first[RATE:RATE * 2]), .09)

    def test_zero_noise_filter_preserves_signal_and_length(self):
        audio = np.zeros(RATE * 4, dtype=np.float32)
        audio[RATE * 2:RATE * 3] = .1 * np.sin(np.arange(RATE) * .1)
        result = denoise(audio)
        self.assertEqual(len(result), len(audio))
        np.testing.assert_allclose(result, audio, atol=1e-6)

    def test_gain_is_bounded_and_keeps_silence_finite(self):
        np.testing.assert_array_equal(balance_volume(np.zeros(RATE)), np.zeros(RATE))
        audio = np.r_[np.full(RATE, .001), np.full(RATE, .8)].astype(np.float32)
        output = balance_volume(audio)
        self.assertGreater(output[0], audio[0])
        self.assertLessEqual(np.max(np.abs(output)), .980001)
        self.assertTrue(np.isfinite(output).all())

    def test_stationary_noise_does_not_open_a_turn(self):
        rng = np.random.default_rng(10)
        audio = rng.normal(0, .003, RATE * 30).astype(np.float32)
        floor = float(np.sqrt(np.mean(audio[:RATE] ** 2)))
        self.assertEqual(windows(audio, floor), [])
        filtered = denoise(audio)
        self.assertLess(np.mean(filtered ** 2), np.mean(audio ** 2))

    def test_keeps_quiet_prefix_and_internal_pause(self):
        rng = np.random.default_rng(20)
        audio = rng.normal(0, .001, RATE * 9).astype(np.float32)
        audio[RATE:RATE * 2] += .0001 * np.sin(np.arange(RATE) * .1)
        audio[RATE * 2:RATE * 3] += .1 * np.sin(np.arange(RATE) * .1)
        start = int(RATE * 4.2)
        audio[start:start + RATE] += .1 * np.sin(np.arange(RATE) * .1)
        spans = windows(audio, float(np.sqrt(np.mean(audio[:RATE] ** 2))))
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0][0], RATE)
        self.assertGreaterEqual(spans[0][1], int(RATE * 6.7))


if __name__ == '__main__':
    unittest.main()
