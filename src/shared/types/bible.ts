export interface BibleVersion {
  id: number
  code: string
  name: string
  locale: string
  updatedAt: number
}

export interface BibleVerse {
  id: number
  number: number
  text: string
}

export interface BibleChapter {
  number: number
  verses: BibleVerse[]
}

export interface BibleBook {
  number: number
  code: string
  name: string
  abbreviation: string
  chapters: BibleChapter[]
}

export interface BiblePassage {
  endVerse?: number
  bookNumber: number
  chapter: number
  verse: number
}

export interface BibleSearchResult {
  verseId: number
  bookNumber: number
  chapter: number
  verse: number
  text: string
  score?: number
}

export interface BibleBookConfig {
  number: number
  code: string
  chapterCount: number
}

/**
 * Complete list of Bible books (Old Testament + New Testament)
 * 66 books total: 39 OT + 27 NT
 */
export const BIBLE_BOOKS: BibleBookConfig[] = [
  // Old Testament (1-39)
  { number: 1, code: 'Gen', chapterCount: 50 },
  { number: 2, code: 'Exo', chapterCount: 40 },
  { number: 3, code: 'Lev', chapterCount: 27 },
  { number: 4, code: 'Num', chapterCount: 36 },
  { number: 5, code: 'Deu', chapterCount: 34 },
  { number: 6, code: 'Jos', chapterCount: 24 },
  { number: 7, code: 'Jdg', chapterCount: 21 },
  { number: 8, code: 'Rut', chapterCount: 4 },
  { number: 9, code: '1Sa', chapterCount: 31 },
  { number: 10, code: '2Sa', chapterCount: 24 },
  { number: 11, code: '1Ki', chapterCount: 22 },
  { number: 12, code: '2Ki', chapterCount: 25 },
  { number: 13, code: '1Ch', chapterCount: 29 },
  { number: 14, code: '2Ch', chapterCount: 36 },
  { number: 15, code: 'Ezr', chapterCount: 10 },
  { number: 16, code: 'Neh', chapterCount: 13 },
  { number: 17, code: 'Est', chapterCount: 10 },
  { number: 18, code: 'Job', chapterCount: 42 },
  { number: 19, code: 'Psa', chapterCount: 150 },
  { number: 20, code: 'Pro', chapterCount: 31 },
  { number: 21, code: 'Ecc', chapterCount: 12 },
  { number: 22, code: 'Sol', chapterCount: 8 },
  { number: 23, code: 'Isa', chapterCount: 66 },
  { number: 24, code: 'Jer', chapterCount: 52 },
  { number: 25, code: 'Lam', chapterCount: 5 },
  { number: 26, code: 'Eze', chapterCount: 48 },
  { number: 27, code: 'Dan', chapterCount: 12 },
  { number: 28, code: 'Hos', chapterCount: 14 },
  { number: 29, code: 'Joe', chapterCount: 3 },
  { number: 30, code: 'Amo', chapterCount: 9 },
  { number: 31, code: 'Oba', chapterCount: 1 },
  { number: 32, code: 'Jon', chapterCount: 4 },
  { number: 33, code: 'Mic', chapterCount: 7 },
  { number: 34, code: 'Nah', chapterCount: 3 },
  { number: 35, code: 'Hab', chapterCount: 3 },
  { number: 36, code: 'Zep', chapterCount: 3 },
  { number: 37, code: 'Hag', chapterCount: 2 },
  { number: 38, code: 'Zec', chapterCount: 14 },
  { number: 39, code: 'Mal', chapterCount: 4 },
  // New Testament (40-66)
  { number: 40, code: 'Mat', chapterCount: 28 },
  { number: 41, code: 'Mar', chapterCount: 16 },
  { number: 42, code: 'Luk', chapterCount: 24 },
  { number: 43, code: 'Joh', chapterCount: 21 },
  { number: 44, code: 'Act', chapterCount: 28 },
  { number: 45, code: 'Rom', chapterCount: 16 },
  { number: 46, code: '1Co', chapterCount: 16 },
  { number: 47, code: '2Co', chapterCount: 13 },
  { number: 48, code: 'Gal', chapterCount: 6 },
  { number: 49, code: 'Eph', chapterCount: 6 },
  { number: 50, code: 'Phi', chapterCount: 4 },
  { number: 51, code: 'Col', chapterCount: 4 },
  { number: 52, code: '1Th', chapterCount: 5 },
  { number: 53, code: '2Th', chapterCount: 3 },
  { number: 54, code: '1Ti', chapterCount: 6 },
  { number: 55, code: '2Ti', chapterCount: 4 },
  { number: 56, code: 'Tit', chapterCount: 3 },
  { number: 57, code: 'Phm', chapterCount: 1 },
  { number: 58, code: 'Heb', chapterCount: 13 },
  { number: 59, code: 'Jas', chapterCount: 5 },
  { number: 60, code: '1Pe', chapterCount: 5 },
  { number: 61, code: '2Pe', chapterCount: 3 },
  { number: 62, code: '1Jo', chapterCount: 5 },
  { number: 63, code: '2Jo', chapterCount: 1 },
  { number: 64, code: '3Jo', chapterCount: 1 },
  { number: 65, code: 'Jud', chapterCount: 1 },
  { number: 66, code: 'Rev', chapterCount: 22 }
]
