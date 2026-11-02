import unittest
import numpy as np

from segmentation import is_digital_silence, speech_span


class SegmentationTests(unittest.TestCase):
    def test_only_exact_digital_silence_can_skip_recognition(self):
        self.assertTrue(is_digital_silence(np.zeros(32000)))
        self.assertTrue(is_digital_silence(np.array([])))
        for value in [1 / 32768, -1 / 32768]:
            self.assertFalse(is_digital_silence(np.r_[np.zeros(16000), value]))

    def test_only_outer_silence_is_removed_with_padding(self):
        audio = np.r_[np.zeros(16000), np.ones(16000) * .1, np.zeros(16000)]
        self.assertEqual(speech_span(audio), (11200, 36800))

    def test_internal_pause_and_quiet_prefix_remain(self):
        audio = np.r_[np.ones(3200) * .002, np.zeros(32000), np.ones(16000) * .1]
        self.assertEqual(speech_span(audio), (0, len(audio)))

    def test_ambiguous_silence_and_empty_are_not_invented_speech(self):
        for audio in [np.array([]), np.zeros(100), np.ones(16000) * .0001]:
            self.assertEqual(speech_span(audio), (0, len(audio)))

    def test_partial_final_frame_is_retained(self):
        audio = np.r_[np.zeros(16000), np.ones(101) * .1]
        start, end = speech_span(audio)
        self.assertEqual(end, len(audio))
        self.assertLessEqual(start, 16000)

    def test_energy_crop_can_lose_quiet_negation_but_digital_cannot(self):
        audio = np.r_[np.ones(16000) / 32768, np.zeros(16000), np.ones(16000) * .1]
        self.assertGreater(speech_span(audio)[0], 16000)
        self.assertEqual(speech_span(audio, 'digital'), (0, len(audio)))

    def test_digital_crop_preserves_every_nonzero_sample(self):
        audio = np.r_[np.zeros(16000), np.ones(101) / 32768, np.zeros(16000)]
        start, end = speech_span(audio, 'digital')
        self.assertFalse(np.any(audio[:start]))
        self.assertFalse(np.any(audio[end:]))
        self.assertEqual(end - start, 9701)
