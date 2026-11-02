import json
from pathlib import Path
import tempfile
import unittest

from real_audio_review import build, match_paragraph


class PrivateReviewTests(unittest.TestCase):
    def test_turbo_only_review_stays_unlabeled(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = {'id': 'recording-01-000', 'recording': 'recording-01', 'offset_s': 0, 'duration_s': 20}
            (root / 'corpus.json').write_text(json.dumps([row]))
            (root / 'whisper-large-v3-turbo-q5_0.jsonl').write_text(json.dumps({**row, 'transcript': '約翰福音三章十六節', 'decode_s': 1.2}))
            build(root)
            self.assertIn('目前中文方案（Turbo）', (root / 'review.html').read_text())
            item = json.loads((root / 'review-candidates.json').read_text())[0]
            self.assertFalse(item['human_verified'])
            self.assertIsNone(item['expected_reference'])

    def test_match_is_a_hint_not_a_target(self):
        match = match_paragraph('請大家讀約翰福音三章十六節', [(2, '請大家讀約翰福音三章十六節')])
        self.assertEqual(match['paragraph'], 2)
        self.assertIsNone(match_paragraph('三章', [(2, '約翰福音三章十六節')]))

    def test_html_escapes_untrusted_transcript_and_has_no_gold(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = {'id': 'recording-01-000', 'recording': 'recording-01', 'offset_s': 0, 'duration_s': 20}
            (root / 'corpus.json').write_text(json.dumps([row]))
            output = {**row, 'transcript': '三章十六節<script>alert(1)</script>', 'decode_s': 0.4}
            (root / 'whisper-small.jsonl').write_text(json.dumps({'type': 'metadata'}) + '\n' + json.dumps(output))
            build(root)
            html = (root / 'review.html').read_text()
            self.assertNotIn('<script>', html)
            self.assertIn('&lt;script&gt;', html)
            item = json.loads((root / 'review-candidates.json').read_text())[0]
            self.assertFalse(item['human_verified'])
            self.assertIsNone(item['expected_reference'])


if __name__ == '__main__':
    unittest.main()
