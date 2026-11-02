"""Experimental short Chinese command retry eligibility; no parser relaxation."""
import re


def retryable(text, reference, samples):
    return (reference is None and 0 < samples <= 768 * 320
            and re.match(r'^\s*[請请]翻到', text) is not None
            and re.search(r'[不別别勿例]', text) is None
            and '章' in text and re.search(r'[節节]', text) is not None)
