import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BulletinHighlight } from '@shared/bulletin-reader'
import { createPersistName, hhcPersistStorage } from '@renderer/lib/persist-storage'

export function bulletinHighlightKey(
  accountId: string,
  documentId: string,
  series: string,
  locale: string,
  revision: number
): string {
  return JSON.stringify([accountId, documentId, series, locale, revision])
}

interface BulletinHighlightsState {
  byEdition: Record<string, BulletinHighlight[][]>
  add: (key: string, ranges: BulletinHighlight[]) => void
  undo: (key: string) => void
}

export const useBulletinHighlightsStore = create<BulletinHighlightsState>()(
  persist(
    (set) => ({
      byEdition: {},
      add: (key, ranges) => {
        if (!ranges.length) return
        set(({ byEdition }) => ({
          byEdition: { ...byEdition, [key]: [...(byEdition[key] ?? []), ranges] }
        }))
      },
      undo: (key) =>
        set(({ byEdition }) => {
          const updated = { ...byEdition }
          const remaining = updated[key]?.slice(0, -1)
          if (remaining?.length) updated[key] = remaining
          else delete updated[key]
          return { byEdition: updated }
        })
    }),
    {
      name: createPersistName('bulletin-highlights'),
      storage: hhcPersistStorage,
      version: 0,
      partialize: ({ byEdition }) => ({ byEdition })
    }
  )
)
