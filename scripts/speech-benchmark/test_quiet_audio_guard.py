import unittest
import numpy as np
from quiet_audio_guard import quiet_evidence, RATE


class QuietEvidenceTests(unittest.TestCase):
    def test_invalid_pcm_is_rejected(self):
        for audio in [np.full(RATE * 2, np.nan), np.full(RATE * 2, 2), np.zeros((RATE, 2))]:
            with self.assertRaises(ValueError):
                quiet_evidence(audio)

    def test_requires_calibration(self):
        with self.assertRaises(ValueError):
            quiet_evidence(np.zeros(RATE))

    def test_noise_and_silence_do_not_imply_omitted_speech(self):
        self.assertFalse(quiet_evidence(np.zeros(RATE * 5))['uncertain_prefix'])
        for seed in range(10):
            audio = np.random.default_rng(seed).normal(0, .01, RATE * 5)
            audio[RATE * 4:] += .2 * np.sin(np.arange(RATE) * .15)
            self.assertFalse(quiet_evidence(audio)['uncertain_prefix'])

    def test_quiet_tonal_prelude_is_ambiguity_not_negation(self):
        audio = np.random.default_rng(2).normal(0, .01, RATE * 5)
        audio[RATE * 2:RATE * 3] += .01 * np.sin(np.arange(RATE) * .15)
        audio[RATE * 4:] += .2 * np.sin(np.arange(RATE) * .15)
        self.assertTrue(quiet_evidence(audio)['uncertain_prefix'])


if __name__ == '__main__':
    unittest.main()
