import { create } from 'zustand'
import { isEditablePresentationMimeType } from '@renderer/lib/presentation-media'
import type {
  PresentationMirrorWarning,
  PresentationSaveStatus
} from '@renderer/lib/presentation-save-coordinator'
import type { FileItemRecord } from '@shared/types/folder'
import { isPersonalRecordVisible } from './personal-sync'

export interface PresentationWorkspaceDocument {
  itemId: string
  mode: 'pptx' | 'editable'
  name: string
  mimeType: string
  url: string
  size: number
  openedAt: number
  isUnsaved?: boolean
  personalOwnerId?: string
  slideCount?: number
  saveStatus?: PresentationSaveStatus
  mirrorWarnings?: PresentationMirrorWarning[]
  canUndo?: boolean
  canRedo?: boolean
}

type PresentationEditorMetadata = Pick<
  PresentationWorkspaceDocument,
  'saveStatus' | 'mirrorWarnings' | 'canUndo' | 'canRedo' | 'isUnsaved'
>

interface PresentationWorkspaceState {
  documents: PresentationWorkspaceDocument[]
  activeItemId: string | null
  activeSlideIdByItemId: Record<string, string | null>

  openDocument: (item: FileItemRecord) => void
  closeDocument: (itemId: string) => void
  setActiveDocument: (itemId: string) => void
  updateDocumentName: (itemId: string, name: string) => void
  updateEditorMetadata: (itemId: string, patch: PresentationEditorMetadata) => void
  setActiveSlideId: (itemId: string, slideId: string | null) => void
  setSlideCount: (itemId: string, slideCount: number) => void
  getActiveDocument: () => PresentationWorkspaceDocument | null
  getActiveSlideId: (itemId: string) => string | null
}

function toWorkspaceDocument(item: FileItemRecord): PresentationWorkspaceDocument {
  return {
    itemId: item.id,
    isUnsaved: item.parentId === 'presentation-drafts',
    mode: isEditablePresentationMimeType(item.mimeType) ? 'editable' : 'pptx',
    name: item.name,
    mimeType: item.mimeType,
    url: item.url,
    size: item.size,
    openedAt: Date.now(),
    personalOwnerId: item.personalOwnerId
  }
}

export const usePresentationWorkspaceStore = create<PresentationWorkspaceState>()((set, get) => ({
  documents: [],
  activeItemId: null,
  activeSlideIdByItemId: {},

  openDocument: (item) =>
    set((state) => {
      if (!isPersonalRecordVisible(item)) return state
      const existing = state.documents.find((document) => document.itemId === item.id)
      const documents = existing
        ? state.documents.map((document) =>
            document.itemId === item.id ? { ...document, ...toWorkspaceDocument(item) } : document
          )
        : [...state.documents, toWorkspaceDocument(item)]
      return {
        documents,
        activeItemId: item.id,
        activeSlideIdByItemId: {
          ...state.activeSlideIdByItemId,
          [item.id]: state.activeSlideIdByItemId[item.id] ?? null
        }
      }
    }),

  closeDocument: (itemId) =>
    set((state) => {
      const index = state.documents.findIndex((document) => document.itemId === itemId)
      const documents = state.documents.filter((document) => document.itemId !== itemId)
      const { [itemId]: _removed, ...activeSlideIdByItemId } = state.activeSlideIdByItemId
      const activeItemId =
        state.activeItemId !== itemId
          ? state.activeItemId
          : ((documents[Math.max(0, index - 1)] ?? documents[index] ?? null)?.itemId ?? null)
      return { documents, activeItemId, activeSlideIdByItemId }
    }),

  setActiveDocument: (itemId) => {
    const document = get().documents.find((entry) => entry.itemId === itemId)
    if (!document || isPersonalRecordVisible(document)) set({ activeItemId: itemId })
  },

  updateDocumentName: (itemId, name) =>
    set((state) => ({
      documents: state.documents.map((document) =>
        document.itemId === itemId ? { ...document, name } : document
      )
    })),

  updateEditorMetadata: (itemId, patch) =>
    set((state) => ({
      documents: state.documents.map((document) =>
        document.itemId === itemId ? { ...document, ...patch } : document
      )
    })),

  setActiveSlideId: (itemId, slideId) =>
    set((state) => ({
      activeSlideIdByItemId: {
        ...state.activeSlideIdByItemId,
        [itemId]: slideId
      }
    })),

  setSlideCount: (itemId, slideCount) =>
    set((state) => ({
      documents: state.documents.map((document) => {
        if (document.itemId !== itemId || document.slideCount === slideCount) return document
        return { ...document, slideCount }
      })
    })),

  getActiveDocument: () => {
    const state = get()
    return state.documents.find((document) => document.itemId === state.activeItemId) ?? null
  },

  getActiveSlideId: (itemId) => get().activeSlideIdByItemId[itemId] ?? null
}))
