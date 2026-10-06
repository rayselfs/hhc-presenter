import { create } from 'zustand'

interface MediaImportState {
  running: boolean
  cancelRequested: boolean
  total: number
  completed: number
  succeeded: number
  destinationNames: string[]
  currentNames: string[]
  failures: Array<{ name: string; reason: string }>
  cancel: () => void
  dismiss: () => void
}

export const useMediaImportStore = create<MediaImportState>((set) => ({
  running: false,
  cancelRequested: false,
  total: 0,
  completed: 0,
  succeeded: 0,
  destinationNames: [],
  currentNames: [],
  failures: [],
  cancel: () => set({ cancelRequested: true }),
  dismiss: () =>
    set((state) => (state.running ? {} : { total: 0, failures: [], destinationNames: [] }))
}))
