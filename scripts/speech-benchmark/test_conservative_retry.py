import unittest
from conservative_retry import retryable


class RetryTests(unittest.TestCase):
    def test_only_failed_short_explicit_commands(self):
        text = '請翻到刷世紀第一章第一節'
        self.assertTrue(retryable(text, None, 16000))
        self.assertTrue(retryable(text.replace('請', '请').replace('節', '节'), None, 768 * 320))
        self.assertFalse(retryable(text, [1, 1, 1], 16000))
        self.assertFalse(retryable(text, None, 768 * 320 + 1))
        self.assertFalse(retryable(text, None, 0))

    def test_negation_examples_and_corrupt_commands_are_not_retried(self):
        for text in ['請三道創世紀第一章第一節', '創世紀第一章第一節',
                     '請翻到創世紀第一章第一節，只是舉例',
                     '請翻到創世紀第一章第一節，不要切換', '請不要翻到創世紀第一章第一節',
                     '請翻到創世紀', 'Please turn to Genesis chapter 1 verse 1']:
            self.assertFalse(retryable(text, None, 16000))


if __name__ == '__main__':
    unittest.main()
