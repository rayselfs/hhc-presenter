import { useProjection } from '@renderer/contexts/ProjectionContext'
import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, LockOpen, RotateCcw, Monitor } from 'lucide-react'
import { AlertDialog, Button, Input } from '@heroui/react'
import LyricsRecognitionControls from '@renderer/components/Control/Camera/LyricsRecognitionControls'
import CameraStage from '@renderer/components/Common/CameraStage'
import { useCameraSession } from '@renderer/contexts/CameraSessionContext'
import { useCameraStore } from '@renderer/stores/camera'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import {
  resizeCamera,
  createCameraCover,
  CAMERA_STAGE,
  type CameraHandle
} from '@renderer/lib/camera-transform'
import type { CameraTransform } from '@shared/camera'
import { snapElementPosition } from '@renderer/lib/presentation-editor-commands'

type Corner = CameraHandle
function videoError(): void {
  useCameraStore.setState({ error: 'playback' })
}

function cameraDimensions(width: number, height: number): void {
  if (width <= 0 || height <= 0) return
  const state = useCameraStore.getState()
  const cover = createCameraCover(width, height)
  if (cover.width === state.cover.width && cover.height === state.cover.height) return
  const zoom = state.transform.width / state.cover.width
  const w = cover.width * zoom
  const h = cover.height * zoom
  useCameraStore.setState({
    cover,
    transform: {
      x: state.transform.x + (state.transform.width - w) / 2,
      y: state.transform.y + (state.transform.height - h) / 2,
      width: w,
      height: h
    }
  })
}

export default function CameraWorkspacePage(): React.JSX.Element {
  const { t } = useTranslation()
  const camera = useCameraSession()
  const { activeOwner, isProjectionOpen, startProjection } = useProjection()
  const projecting = isProjectionOpen && activeOwner === 'camera'
  const [resetOpen, setResetOpen] = useState(false)
  const [snapGuides, setSnapGuides] = useState<{
    verticalGuide?: number
    horizontalGuide?: number
  }>({})
  const state = useCameraStore()
  const lyricsEnabled = useCameraLyricsStore((state) => state.enabled)
  const LockIcon = state.locked ? Lock : LockOpen
  const canvas = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; frame: CameraTransform; corner?: Corner } | null>(
    null
  )
  const begin = (event: React.PointerEvent<HTMLElement>, corner?: Corner): void => {
    if (!camera.stream || state.locked || lyricsEnabled || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    setSnapGuides({})
    canvas.current?.focus({ preventScroll: true })
    canvas.current?.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, frame: state.transform, corner }
  }
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    const bounds = canvas.current?.getBoundingClientRect()
    if (!start || !bounds?.width) return
    const dx = ((event.clientX - start.x) * 1920) / bounds.width
    const dy = ((event.clientY - start.y) * 1920) / bounds.width
    if (start.corner) {
      const ratio = start.frame.height / start.frame.width
      const delta =
        start.corner.length === 1
          ? start.corner === 'e'
            ? dx
            : start.corner === 'w'
              ? -dx
              : (start.corner === 's' ? dy : -dy) / ratio
          : (dx * (start.corner.endsWith('w') ? -1 : 1) +
              dy * (start.corner.startsWith('n') ? -1 : 1) * ratio) /
            (1 + ratio * ratio)
      state.updateTransform(
        resizeCamera(start.frame, start.corner, start.frame.width + delta, state.cover.width)
      )
    } else {
      const { x, y, ...guides } = snapElementPosition(
        { ...start.frame, x: start.frame.x + dx, y: start.frame.y + dy },
        CAMERA_STAGE,
        (8 * CAMERA_STAGE.width) / bounds.width
      )
      state.updateTransform({ ...start.frame, x, y })
      setSnapGuides({
        verticalGuide:
          x === (CAMERA_STAGE.width - start.frame.width) / 2
            ? CAMERA_STAGE.width / 2
            : guides.verticalGuide,
        horizontalGuide:
          y === (CAMERA_STAGE.height - start.frame.height) / 2
            ? CAMERA_STAGE.height / 2
            : guides.horizontalGuide
      })
    }
  }
  useKeyboardShortcuts(
    Object.entries(SHORTCUTS.CAMERA).map(([key, config]) => ({
      config,
      id: `camera.${key.toLowerCase()}`,
      handler: (event) => {
        const delta = event.shiftKey ? 10 : 1
        const dx = event.code === 'ArrowLeft' ? -delta : event.code === 'ArrowRight' ? delta : 0
        const dy = event.code === 'ArrowUp' ? -delta : event.code === 'ArrowDown' ? delta : 0
        const current = useCameraStore.getState()
        current.updateTransform({
          ...current.transform,
          x: current.transform.x + dx,
          y: current.transform.y + dy
        })
      }
    })),
    {
      sectionKey: 'camera',
      enabled: !!camera.stream && !state.selectorOpen && !state.locked && !lyricsEnabled
    }
  )
  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4" aria-label={t('camera.title')}>
      <div className="flex shrink-0 justify-center">
        <Button
          type="button"
          variant="danger"
          className="min-h-11 rounded-full px-6 font-semibold"
          isDisabled={!state.capturing || projecting}
          onPress={() => void startProjection('camera')}
        >
          <Monitor size={16} aria-hidden="true" />
          {t(projecting ? 'camera.presenting' : 'camera.present')}
        </Button>
      </div>
      {state.error && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-danger p-3 text-sm"
        >
          <span>
            {t(`camera.errors.${state.error}`, { defaultValue: t('camera.errors.unavailable') })}
          </span>
          <Button
            variant="secondary"
            onPress={() => {
              if (camera.stream) camera.retry()
              else if (state.deviceId || state.lastDeviceId)
                void camera.selectSource(state.deviceId || state.lastDeviceId)
              else void camera.prepareSources()
            }}
          >
            {t('camera.retry')}
          </Button>
        </div>
      )}
      {!lyricsEnabled && (
        <div
          ref={canvas}
          role="group"
          aria-label={t('camera.canvas')}
          tabIndex={0}
          data-testid="camera-editor"
          className="relative w-full shrink-0 touch-none overflow-hidden bg-black outline outline-1 outline-border focus:outline-2 focus:outline-accent"
          style={{
            aspectRatio: '16 / 9',
            height: 'auto',
            width: 'min(100%, max(320px, calc((100dvh - 250px) * 16 / 9)))',
            alignSelf: 'center'
          }}
          onPointerDown={(event) => begin(event)}
          onPointerMove={move}
          onPointerUp={(event) => {
            move(event)
            drag.current = null
            setSnapGuides({})
            if (canvas.current?.hasPointerCapture(event.pointerId))
              canvas.current.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            drag.current = null
            setSnapGuides({})
          }}
          onLostPointerCapture={() => {
            drag.current = null
            setSnapGuides({})
          }}
        >
          <CameraStage
            stream={camera.stream}
            transform={state.transform}
            onError={videoError}
            onDimensions={cameraDimensions}
          />
          {!camera.stream && (
            <p className="pointer-events-none absolute inset-0 grid place-items-center text-white/60">
              {t('camera.empty')}
            </p>
          )}
          {camera.stream && !lyricsEnabled && (
            <div
              data-testid="camera-frame"
              className={`pointer-events-none absolute border-2 ${state.locked ? 'border-danger' : 'border-accent'}`}
              style={{
                left: `${(state.transform.x / 1920) * 100}%`,
                top: `${(state.transform.y / 1080) * 100}%`,
                width: `${(state.transform.width / 1920) * 100}%`,
                height: `${(state.transform.height / 1080) * 100}%`
              }}
            ></div>
          )}
          {camera.stream &&
            !lyricsEnabled &&
            !state.locked &&
            snapGuides.verticalGuide !== undefined && (
              <span
                aria-hidden="true"
                data-testid="camera-guide-vertical"
                className="pointer-events-none absolute inset-y-0 w-px border-l border-dashed border-fuchsia-400"
                style={{
                  left: `${(snapGuides.verticalGuide / CAMERA_STAGE.width) * 100}%`,
                  transform:
                    snapGuides.verticalGuide === CAMERA_STAGE.width
                      ? 'translateX(-100%)'
                      : undefined
                }}
              />
            )}
          {camera.stream &&
            !lyricsEnabled &&
            !state.locked &&
            snapGuides.horizontalGuide !== undefined && (
              <span
                aria-hidden="true"
                data-testid="camera-guide-horizontal"
                className="pointer-events-none absolute inset-x-0 h-px border-t border-dashed border-fuchsia-400"
                style={{
                  top: `${(snapGuides.horizontalGuide / CAMERA_STAGE.height) * 100}%`,
                  transform:
                    snapGuides.horizontalGuide === CAMERA_STAGE.height
                      ? 'translateY(-100%)'
                      : undefined
                }}
              />
            )}
          {camera.stream && !lyricsEnabled && state.locked && (
            <div
              role="status"
              aria-label={t('camera.locked')}
              title={t('camera.locked')}
              data-testid="camera-lock-indicator"
              className="pointer-events-none absolute top-2 right-2 inline-flex items-center gap-2 rounded-md bg-black/80 px-3 py-2 text-sm text-white"
            >
              <Lock size={16} aria-hidden="true" />
            </div>
          )}
          {camera.stream &&
            !lyricsEnabled &&
            !state.locked &&
            (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((corner) => (
              <button
                type="button"
                aria-label={t('presentationWorkspace.resizeImage', {
                  direction: t(`presentationWorkspace.handleDirection.${corner}`)
                })}
                key={corner}
                data-testid={`camera-resize-${corner}`}
                onPointerDown={(event) => begin(event, corner)}
                className="absolute flex size-[25px] items-center justify-center touch-none"
                style={{
                  left: `${((state.transform.x + (corner.includes('e') ? state.transform.width : corner.includes('w') ? 0 : state.transform.width / 2)) / 1920) * 100}%`,
                  top: `${((state.transform.y + (corner.includes('s') ? state.transform.height : corner.includes('n') ? 0 : state.transform.height / 2)) / 1080) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  cursor:
                    corner === 'n' || corner === 's'
                      ? 'ns-resize'
                      : corner === 'e' || corner === 'w'
                        ? 'ew-resize'
                        : corner === 'ne' || corner === 'sw'
                          ? 'nesw-resize'
                          : 'nwse-resize'
                }}
              >
                <span className="pointer-events-none size-4 rounded-full border border-white bg-accent" />
              </button>
            ))}
        </div>
      )}
      {!lyricsEnabled && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant={state.locked ? 'danger' : 'secondary'}
              isIconOnly
              aria-label={t(state.locked ? 'camera.unlock' : 'camera.lock')}
              aria-pressed={state.locked}
              isDisabled={lyricsEnabled || (!camera.stream && !state.locked)}
              onPress={() => {
                drag.current = null
                setSnapGuides({})
                state.setLocked(!state.locked)
              }}
            >
              <LockIcon size={20} aria-hidden="true" />
            </Button>
            <Button
              variant="secondary"
              isDisabled={!camera.stream || state.locked || lyricsEnabled}
              aria-label={t('camera.reset')}
              onPress={() => setResetOpen(true)}
            >
              <RotateCcw size={20} aria-hidden="true" />
            </Button>
          </div>
          <div className="ml-auto flex flex-wrap justify-end gap-3">
            {(['x', 'y', 'width'] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                {t(`camera.${key}`)}
                <Input
                  className="w-28"
                  type="number"
                  step="1"
                  disabled={!camera.stream || state.locked || lyricsEnabled}
                  value={Math.round(state.transform[key])}
                  onChange={(event) => {
                    if (!event.target.value) return
                    const value = Number(event.target.value)
                    state.updateTransform(
                      key === 'width'
                        ? resizeCamera(state.transform, 'se', value, state.cover.width)
                        : { ...state.transform, [key]: value }
                    )
                  }}
                />
              </label>
            ))}
          </div>
        </div>
      )}
      {lyricsEnabled && <LyricsRecognitionControls stream={camera.stream} onRetry={camera.retry} />}
      <AlertDialog.Backdrop isOpen={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog role="alertdialog">
            <AlertDialog.Header>
              <AlertDialog.Heading>{t('camera.resetTitle')}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>{t('camera.resetBody')}</AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => setResetOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  if (camera.stream && !useCameraStore.getState().locked) camera.reset()
                  setResetOpen(false)
                }}
              >
                {t('common.confirm')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </section>
  )
}
