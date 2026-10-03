import { app, screen, type BrowserWindow, type Display } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

type ProjectionDiagnosticMode = 'baseline' | 'after-show' | 'resize-after-fullscreen'

export function getProjectionDiagnosticMode(
  argv = process.argv,
  platform: string = process.platform
): ProjectionDiagnosticMode | undefined {
  if (platform !== 'win32') return undefined
  const argument = argv.find((value) => value.startsWith('--projection-diagnostic='))
  if (!argument) return undefined
  const mode = argument.slice('--projection-diagnostic='.length)
  if (mode === 'baseline' || mode === 'after-show' || mode === 'resize-after-fullscreen')
    return mode
  throw new Error('Unknown projection diagnostic mode')
}

export function recordProjectionDiagnostic(
  phase: string,
  window?: BrowserWindow,
  target?: Display
): void {
  const mode = getProjectionDiagnosticMode()
  if (!mode) return
  try {
    const directory = join(app.getPath('userData'), 'projection-diagnostics')
    mkdirSync(directory, { recursive: true })
    const live = window && !window.isDestroyed() ? window : undefined
    const displays = screen.getAllDisplays().map(({ id, bounds, workArea, scaleFactor }) => ({
      id,
      bounds,
      workArea,
      scaleFactor
    }))
    appendFileSync(
      join(directory, `${mode}-${process.pid}.jsonl`),
      JSON.stringify({
        time: new Date().toISOString(),
        phase,
        coordinateSpace: 'Electron DIP',
        mode,
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        primaryDisplayId: screen.getPrimaryDisplay().id,
        displays,
        requestedTarget: target && {
          id: target.id,
          bounds: target.bounds,
          workArea: target.workArea,
          scaleFactor: target.scaleFactor
        },
        window: live && {
          id: live.id,
          nativeHandle: live.getNativeWindowHandle().toString('hex'),
          bounds: live.getBounds(),
          contentBounds: live.getContentBounds(),
          minimumSize: live.getMinimumSize(),
          maximumSize: live.getMaximumSize(),
          fullscreen: live.isFullScreen(),
          resizable: live.isResizable(),
          visible: live.isVisible(),
          focused: live.isFocused()
        }
      }) + '\n',
      'utf8'
    )
  } catch (error) {
    console.error('[projection-diagnostic] Failed to record geometry:', error)
  }
}
