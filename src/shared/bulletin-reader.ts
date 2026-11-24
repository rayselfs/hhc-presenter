export interface BulletinFragment {
  sentenceId: string
  /** Unicode code-point offset of the fragment in the published sentence. */
  start: number
  text: string
}

export interface BulletinBlock {
  id: string
  kind?: 'heading' | 'paragraph' | 'lyrics'
  fragments: BulletinFragment[]
  image?: { src: string; alt: string }
}

export interface BulletinPage {
  id: string
  label: string
  blocks: BulletinBlock[]
}

export interface BulletinHighlight {
  sentenceId: string
  start: number
  end: number
}

export type BulletinPosition =
  | { scrollRatio: number }
  | {
      sentenceId: string
      offset: number
      /** Position of the anchored character relative to the viewport height. */
      within: number
    }
