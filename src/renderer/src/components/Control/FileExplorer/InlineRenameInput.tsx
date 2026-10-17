import { useEffect, useRef, useState } from 'react'

interface InlineRenameInputProps {
  initialValue: string
  ariaLabel: string
  onSubmit: (value: string) => boolean | void | Promise<boolean | void>
  onCancel: () => void
}

export function InlineRenameInput({
  initialValue,
  ariaLabel,
  onSubmit,
  onCancel
}: InlineRenameInputProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const composingRef = useRef(false)
  const submittedRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }, [value])

  const submit = (): void => {
    if (submittedRef.current) return
    submittedRef.current = true
    setIsSubmitting(true)
    void (async () => {
      let completed = false
      try {
        completed = (await onSubmit(value)) !== false
      } finally {
        setIsSubmitting(false)
        if (!completed) {
          submittedRef.current = false
          inputRef.current?.focus()
        }
      }
    })().catch(() => undefined)
  }

  const cancel = (): void => {
    if (submittedRef.current) return
    submittedRef.current = true
    onCancel()
  }

  return (
    <textarea
      ref={inputRef}
      aria-label={ariaLabel}
      value={value}
      rows={1}
      readOnly={isSubmitting}
      aria-busy={isSubmitting}
      className="max-h-24 w-full resize-none overflow-hidden rounded border border-primary/40 bg-background px-1 text-center text-sm text-foreground outline-none"
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={submit}
      onCompositionStart={() => {
        composingRef.current = true
      }}
      onCompositionEnd={() => {
        composingRef.current = false
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
          return
        }
        if (event.key === 'Enter' && !composingRef.current) {
          event.preventDefault()
          submit()
        }
      }}
    />
  )
}
