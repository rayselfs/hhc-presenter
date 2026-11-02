from copy import deepcopy
import unittest

from compare_turbo import compare, POLICY


class PairedComparisonTests(unittest.TestCase):
    def test_languages_are_not_pooled_and_empty_selection_fails(self):
        chinese = self.row('zh')
        english = {**self.row('en'), 'language': 'en'}
        result = compare([chinese, english], [chinese, english], language='en')
        self.assertEqual(result['groups']['all']['n'], 1)
        with self.assertRaises(ValueError):
            compare([chinese], [chinese], language='en')

    def row(self, ident, correct=False, seconds=1):
        return {'id': ident, 'language': 'zh', 'sha256': ident, 'target': [1, 1, 1],
                'kind': 'mixed', 'duration_s': 5,
                POLICY: {'correct': correct, 'wrong': False, 'rejected': not correct,
                         'correct_within_3s': correct and seconds <= 3, 'total_s': seconds}}

    def test_gain_over_budget_does_not_count_as_timely_success(self):
        result = compare([self.row('a')], [self.row('a', True, 3.1)])
        self.assertEqual(result['changes']['gained'], ['a'])
        self.assertEqual(result['groups']['mixed']['turbo']['correct_within_3s'], 0)
        self.assertEqual(result['changes']['over_3s'], ['a'])

    def test_pairs_cannot_silently_drop_or_change_audio(self):
        row = self.row('a')
        changed = deepcopy(row)
        changed['sha256'] = 'different'
        for candidate in [[], [row, row], [changed]]:
            with self.assertRaises(ValueError):
                compare([row], candidate)

    def test_new_wrong_and_exclusion(self):
        row = self.row('a')
        changed = deepcopy(row)
        changed[POLICY].update(wrong=True, rejected=False)
        result = compare([row, self.row('duplicate')], [changed, self.row('duplicate')], ['duplicate'])
        self.assertEqual(result['changes']['new_wrong'], ['a'])
        self.assertEqual(result['groups']['all']['n'], 1)


if __name__ == '__main__':
    unittest.main()
