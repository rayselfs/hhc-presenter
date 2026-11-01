import unittest
from optimization_evaluate import quote_decision


class OptimizationTests(unittest.TestCase):
    def test_quote_gate_rejects_short_ambiguous_and_low_similarity(self):
        a, b = [1, 1, 1], [2, 1, 1]
        self.assertIsNone(quote_decision([(.95, a)], 4, 'en'))
        self.assertIsNone(quote_decision([(.95, a), (.90, b)], 10, 'en'))
        self.assertIsNone(quote_decision([(.70, a), (.30, b)], 10, 'zh'))
        self.assertEqual(quote_decision([(.95, a), (.70, b)], 10, 'zh'), a)
        self.assertIsNone(quote_decision([], 10, 'zh'))


if __name__ == '__main__':
    unittest.main()
