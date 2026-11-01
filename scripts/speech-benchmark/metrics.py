"""Benchmark-only scoring; not the application's production parser."""
import re
import unicodedata
from functools import lru_cache
from num2words import num2words
from opencc import OpenCC

CONVERTER = OpenCC('s2t')
WORDS = {num2words(i).replace('-', ' '): str(i) for i in range(1, 177)}
WORDS.update({'first': '1', 'second': '2', 'third': '3'})
NUMBER_WORDS = re.compile(r'\b(' + '|'.join(re.escape(x) for x in sorted(WORDS, key=len, reverse=True)) + r')\b')


def parse_chinese_number(text):
    digits = {'零': 0, '〇': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4,
              '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
    if not any(c in text for c in '十百'):
        return int(''.join(str(digits[c]) for c in text))
    result, current = 0, 0
    for c in text:
        if c in '十百':
            result += (current or 1) * {'十': 10, '百': 100}[c]
            current = 0
        else:
            current = digits[c]
    return result + current


@lru_cache(maxsize=4096)
def normalize(text):
    text = CONVERTER.convert(unicodedata.normalize('NFKC', text)).lower().replace('-', ' ')
    text = NUMBER_WORDS.sub(lambda m: WORDS[m[0]], text)
    text = re.sub('[零〇一二兩三四五六七八九十百]+', lambda m: str(parse_chinese_number(m[0])), text)
    return text


def reference(text, books):
    text = re.sub(r'\s+', '', normalize(text))
    matches = []
    for i, book in enumerate(books):
        for name in (book['zh'], book['en']):
            alias = re.sub(r'\s+', '', normalize(name))
            if alias in text:
                matches.append((len(alias), i + 1, text.split(alias, 1)[1]))
    if not matches:
        return None
    _, book, tail = max(matches)
    chapter = re.search(r'(?:chapter|chapters)(\d+)', tail) or re.search(r'(\d+)(?:章|篇)', tail)
    verse = re.search(r'(?:verse|verses)(\d+)', tail) or re.search(r'(\d+)(?:節|节)', tail)
    if chapter and verse:
        return [book, int(chapter[1]), int(verse[1])]
    numeric = re.fullmatch(r'[^\d]*(\d+)\s*[:：.,，]\s*(\d+)[^\d]*', tail)
    if numeric:
        return [book, int(numeric[1]), int(numeric[2])]
    return None


def tokens(text, language):
    text = normalize(text)
    if language == 'en':
        return re.findall(r'[a-z]+|\d+|[\u3400-\u9fff]', text)
    return list(''.join(re.findall(r'[a-z0-9\u3400-\u9fff]+', text)))


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1]


def score(row, text, books):
    if row['kind'] == 'unlabeled':
        return {'edits': None, 'units': None, 'reference': None, 'reference_correct': None}
    expected, actual = tokens(row['text'], row['language']), tokens(text, row['language'])
    predicted = reference(text, books)
    return {'edits': edit_distance(expected, actual), 'units': len(expected),
            'reference': predicted,
            'reference_correct': predicted == row['target'] if row['kind'] in ('reference', 'mixed') else None}
