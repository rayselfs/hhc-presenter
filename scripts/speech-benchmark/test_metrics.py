import unittest
import hashlib
from pathlib import Path
import tempfile
import wave
from metrics import edit_distance, reference, normalize, score
from corpus import chinese_number
from evaluate import Retrieval, percentile
from run import read_audio
from evaluate_v2 import evaluate as evaluate_v2


class MetricsTests(unittest.TestCase):
    def test_unlabeled_audio_has_no_accuracy_score(self):
        self.assertTrue(all(value is None for value in score({'kind': 'unlabeled'}, 'John 3:16', []).values()))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'unlabeled.jsonl'
            source.write_text('{"kind": "unlabeled"}\n')
            with self.assertRaisesRegex(ValueError, 'human verification'):
                evaluate_v2(root, source, root / 'output.json')
            self.assertFalse((root / 'output.json').exists())

    def test_numbers(self):
        for n in range(1, 177):
            self.assertEqual(normalize(chinese_number(n)), str(n))
        self.assertEqual(normalize('one hundred and one'), '101')

    def test_numbered_book_and_missing_verse(self):
        books = [{'zh': '約翰福音', 'en': 'John'}, {'zh': '約翰二書', 'en': '2 John'}]
        self.assertEqual(reference('Second John chapter one verse five', books), [2, 1, 5])
        self.assertEqual(reference('約翰福音第三章 verse sixteen', books), [1, 3, 16])
        self.assertIsNone(reference('約翰福音第三章', books))
        self.assertEqual(reference('John 3:16', books), [1, 3, 16])

    def test_errors_not_similarity_score(self):
        self.assertEqual(edit_distance(list('abc'), list('axc')), 1)
        self.assertEqual(edit_distance([], list('ab')), 2)

    def test_retrieval_uses_canonical_ids_and_adjacent_window(self):
        corpus = [{'chapters': [['God created the heaven and the earth.',
                                'The earth was without form and void.',
                                'Please test the microphone volume.']]}]
        search = Retrieval(corpus, 'en')
        self.assertEqual(search.search('God created the heaven and the earth. The earth was without form and void.')[0], [1, 1, 1])
        self.assertEqual(search.search('totally unrelated words'), [])
        self.assertEqual(percentile([4, 1, 3, 2], .5), 2)

    def test_pcm_and_checksum_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.wav'
            with wave.open(str(path), 'wb') as audio:
                audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                audio.writeframes(b'\x00\x40\x00\xc0')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(read_audio(path, digest).tolist(), [0.5, -0.5])
            with self.assertRaises(ValueError):
                read_audio(path, 'incorrect')


if __name__ == '__main__':
    unittest.main()
