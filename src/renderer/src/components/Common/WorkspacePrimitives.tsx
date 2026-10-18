import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@heroui/react/button'
import { Modal } from '@heroui/react/modal'
import { List, PanelRight, X } from 'lucide-react'

type WorkspaceOverlay = 'navigator' | 'inspector' | null

export function WorkspaceShell({
  children,
  className = '',
  ...props
}: ComponentPropsWithoutRef<'section'>): React.JSX.Element {
  return (
    <section className={`flex h-full min-h-0 flex-col overflow-hidden ${className}`} {...props}>
      {children}
    </section>
  )
}

export function StageViewport({
  children,
  className = '',
  ...props
}: ComponentPropsWithoutRef<'main'>): React.JSX.Element {
  return (
    <main
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${className}`}
      {...props}
    >
      {children}
    </main>
  )
}

export function NavigatorRail({
  children,
  className = '',
  ...props
}: ComponentPropsWithoutRef<'aside'>): React.JSX.Element {
  return (
    <aside
      className={`min-h-0 min-w-0 overflow-hidden ${className}`}
      data-workspace-navigator
      {...props}
    >
      {children}
    </aside>
  )
}

export function InspectorPanel({
  children,
  className = '',
  ...props
}: ComponentPropsWithoutRef<'aside'>): React.JSX.Element {
  return (
    <aside
      className={`min-h-0 min-w-0 overflow-hidden ${className}`}
      data-workspace-inspector
      {...props}
    >
      {children}
    </aside>
  )
}

export function ResponsivePanelGroup({
  navigator,
  stage,
  inspector,
  overlay: controlledOverlay,
  onOverlayChange,
  inspectorReturnFocusRef,
  navigatorWidth = 240,
  inspectorWidth = 300,
  navigatorLabel = 'Navigator',
  inspectorLabel = 'Inspector',
  className = ''
}: {
  navigator: ReactNode
  stage: ReactNode
  inspector?: ReactNode
  overlay?: WorkspaceOverlay
  onOverlayChange?: (overlay: WorkspaceOverlay) => void
  inspectorReturnFocusRef?: RefObject<HTMLElement | null>
  navigatorWidth?: number
  inspectorWidth?: number
  navigatorLabel?: string
  inspectorLabel?: string
  className?: string
}): React.JSX.Element {
  const [uncontrolledOverlay, setUncontrolledOverlay] = useState<WorkspaceOverlay>(null)
  const [navigatorHost] = useState(createPaneHost)
  const [inspectorHost] = useState(createPaneHost)
  const navigatorTriggerRef = useRef<HTMLButtonElement>(null)
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null)
  const navigatorSlotRef = useRef<HTMLDivElement>(null)
  const inspectorSlotRef = useRef<HTMLDivElement>(null)
  const compactDialogRef = useRef<HTMLDivElement>(null)
  const compactCloseRef = useRef<HTMLButtonElement>(null)
  const compactOverlayHadFocusRef = useRef(false)
  const previousCompactOverlayRef = useRef<WorkspaceOverlay>(null)
  const compactNavigator = useMediaQuery('(max-width: 1023px)')
  const compactInspector = useMediaQuery('(max-width: 1279px)')
  const overlay = controlledOverlay === undefined ? uncontrolledOverlay : controlledOverlay
  const compactOverlay =
    (overlay === 'navigator' && compactNavigator) || (overlay === 'inspector' && compactInspector)
      ? overlay
      : null
  const attachNavigatorDock = useCallback(
    (target: HTMLDivElement | null): void => {
      if (target && compactOverlay !== 'navigator') target.append(navigatorHost)
    },
    [compactOverlay, navigatorHost]
  )
  const attachInspectorDock = useCallback(
    (target: HTMLDivElement | null): void => {
      if (target && compactOverlay !== 'inspector') target.append(inspectorHost)
    },
    [compactOverlay, inspectorHost]
  )
  const attachCompactPane = useCallback(
    (target: HTMLDivElement | null): void => {
      if (!target) return
      if (compactOverlay === 'navigator') target.append(navigatorHost)
      else if (compactOverlay === 'inspector') target.append(inspectorHost)
    },
    [compactOverlay, inspectorHost, navigatorHost]
  )
  const setOverlay = (nextOverlay: WorkspaceOverlay): void => {
    if (controlledOverlay === undefined) setUncontrolledOverlay(nextOverlay)
    onOverlayChange?.(nextOverlay)
  }
  const closeNavigator = (): void => {
    setOverlay(null)
    queueMicrotask(() => navigatorTriggerRef.current?.focus())
  }
  const closeInspector = (): void => {
    setOverlay(null)
    queueMicrotask(() => (inspectorReturnFocusRef?.current ?? inspectorTriggerRef.current)?.focus())
  }
  const style = {
    '--workspace-navigator-width': `${navigatorWidth}px`,
    '--workspace-inspector-width': `${inspectorWidth}px`
  } as CSSProperties
  const closeCompactOverlay = (): void => {
    if (compactOverlay === 'navigator') closeNavigator()
    else if (compactOverlay === 'inspector') closeInspector()
  }
  useLayoutEffect(() => {
    const previousCompactOverlay = previousCompactOverlayRef.current
    const previousSlot =
      previousCompactOverlay === 'navigator'
        ? navigatorSlotRef.current
        : previousCompactOverlay === 'inspector'
          ? inspectorSlotRef.current
          : null
    if (
      previousCompactOverlay !== null &&
      compactOverlay === null &&
      overlay === previousCompactOverlay &&
      compactOverlayHadFocusRef.current
    ) {
      const paneControl = previousSlot
        ? getFocusableElements(previousSlot).find(
            (element) => !element.classList.contains('workspace-overlay-close')
          )
        : undefined
      const returnTarget =
        previousCompactOverlay === 'inspector'
          ? (inspectorReturnFocusRef?.current ?? inspectorTriggerRef.current)
          : navigatorTriggerRef.current
      ;(paneControl ?? returnTarget)?.focus()
      compactOverlayHadFocusRef.current = false
    }

    compactCloseRef.current?.focus()
    previousCompactOverlayRef.current = compactOverlay
  }, [compactOverlay, inspectorReturnFocusRef, overlay])

  useLayoutEffect(() => {
    const dialog = compactDialogRef.current
    const close = compactCloseRef.current
    if (!dialog || !close) return
    const rememberFocus = (): void => {
      compactOverlayHadFocusRef.current = dialog.contains(document.activeElement)
    }
    close.focus()
    rememberFocus()
    document.addEventListener('focusin', rememberFocus)
    return () => {
      document.removeEventListener('focusin', rememberFocus)
    }
  }, [compactOverlay])

  return (
    <div
      className={`workspace-panel-group relative min-h-0 flex-1 ${
        inspector ? '' : 'workspace-two-panel'
      } ${className}`}
      style={style}
    >
      <div className="workspace-compact-switcher z-30 flex gap-1">
        <Button
          ref={navigatorTriggerRef}
          className="workspace-navigator-trigger"
          size="sm"
          variant="tertiary"
          onPress={() => (overlay === 'navigator' ? closeNavigator() : setOverlay('navigator'))}
          aria-expanded={overlay === 'navigator'}
        >
          <List size={14} />
          {navigatorLabel}
        </Button>
        {inspector && (
          <Button
            ref={inspectorTriggerRef}
            size="sm"
            variant="tertiary"
            onPress={() => (overlay === 'inspector' ? closeInspector() : setOverlay('inspector'))}
            aria-expanded={overlay === 'inspector'}
          >
            <PanelRight size={14} />
            {inspectorLabel}
          </Button>
        )}
      </div>
      <div
        ref={navigatorSlotRef}
        className={`workspace-navigator-slot ${overlay === 'navigator' ? 'workspace-overlay-open' : ''}`}
        aria-hidden={compactOverlay !== null ? true : undefined}
        inert={compactOverlay !== null}
      >
        <div ref={attachNavigatorDock} className="contents" />
        {overlay === 'navigator' && compactOverlay === null && (
          <OverlayClose label={`Close ${navigatorLabel}`} onPress={closeNavigator} />
        )}
      </div>
      <div
        className="workspace-stage-slot flex min-h-0 min-w-0"
        aria-hidden={compactOverlay !== null ? true : undefined}
        inert={compactOverlay !== null}
      >
        {stage}
      </div>
      {inspector && (
        <div
          ref={inspectorSlotRef}
          className={`workspace-inspector-slot ${
            overlay === 'inspector' ? 'workspace-overlay-open' : ''
          }`}
          aria-hidden={compactOverlay !== null ? true : undefined}
          inert={compactOverlay !== null}
        >
          <div ref={attachInspectorDock} className="contents" />
          {overlay === 'inspector' && compactOverlay === null && (
            <OverlayClose label={`Close ${inspectorLabel}`} onPress={closeInspector} />
          )}
        </div>
      )}
      {compactOverlay && (
        <Modal.Backdrop
          isOpen
          isDismissable={false}
          variant="transparent"
          onOpenChange={(isOpen) => !isOpen && closeCompactOverlay()}
        >
          <Modal.Container
            placement="top"
            className={`!h-full !w-full !max-w-none !p-0 sm:!w-full sm:!p-0 ${
              compactOverlay === 'navigator' ? '!items-start' : '!items-end'
            }`}
          >
            <Modal.Dialog
              aria-label={compactOverlay === 'navigator' ? navigatorLabel : inspectorLabel}
              className="!my-0 !h-full !min-h-full !max-w-none !rounded-none !bg-background !p-0"
              style={{
                width: `min(${
                  compactOverlay === 'navigator' ? navigatorWidth : inspectorWidth
                }px, 90vw)`
              }}
            >
              <div ref={compactDialogRef} className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-1 p-2 pr-12">
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => setOverlay('navigator')}
                    aria-pressed={compactOverlay === 'navigator'}
                  >
                    <List size={14} />
                    {navigatorLabel}
                  </Button>
                  {inspector && (
                    <Button
                      size="sm"
                      variant="tertiary"
                      onPress={() => setOverlay('inspector')}
                      aria-pressed={compactOverlay === 'inspector'}
                    >
                      <PanelRight size={14} />
                      {inspectorLabel}
                    </Button>
                  )}
                </div>
                <div ref={attachCompactPane} className="min-h-0 flex-1 overflow-hidden" />
                <OverlayClose
                  ref={compactCloseRef}
                  label={`Close ${compactOverlay === 'navigator' ? navigatorLabel : inspectorLabel}`}
                  onPress={closeCompactOverlay}
                />
              </div>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      )}
      {createPortal(navigator, navigatorHost, 'workspace-navigator')}
      {inspector ? createPortal(inspector, inspectorHost, 'workspace-inspector') : null}
    </div>
  )
}

function createPaneHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.className = 'contents'
  return host
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = (event: MediaQueryListEvent): void => setMatches(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => {
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

function OverlayClose({
  ref,
  label,
  onPress
}: {
  ref?: RefObject<HTMLButtonElement | null>
  label: string
  onPress: () => void
}): React.JSX.Element {
  return (
    <Button
      isIconOnly
      ref={ref}
      size="sm"
      variant="ghost"
      className="workspace-overlay-close absolute right-2 top-2 z-20"
      onPress={onPress}
      aria-label={label}
    >
      <X size={16} />
    </Button>
  )
}
