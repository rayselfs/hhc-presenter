export interface EditableTextSelection {
  elementId: string
  start: number
  end: number
}

export type TextEditFinalizer = (() => boolean) & {
  flush?: () => boolean
  restoreSelection?: () => void
  getSelection?: () => EditableTextSelection | null
  hasUnsafeWork?: () => boolean
  isComposing?: () => boolean
}
