import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'
import { LYRICS_FONTS } from '@shared/lyrics'
const field = 'rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-40'
export default function LyricsRecognitionControls({
  stream
}: {
  stream: MediaStream | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const state = useCameraLyricsStore()
  const sourceVideo = useRef<HTMLVideoElement>(null)
  const [sourceRatio, setSourceRatio] = useState('16 / 9')
  useEffect(() => {
    const video = sourceVideo.current
    if (!video || !stream || !state.enabled) return
    video.srcObject = stream
    void video.play().catch(() => undefined)
    return () => {
      video.srcObject = null
    }
  }, [stream, state.enabled])
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [invalidDraft, setInvalidDraft] = useState(false)
  return (
    <section
      aria-label={t('cameraLyrics.title')}
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
    >
      <p className="text-sm text-muted">{t('cameraLyrics.description')}</p>
      {state.enabled && (
        <>
          <div role="status" className="text-sm">
            {t(`cameraLyrics.status.${state.status}`)}
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {t(`cameraLyrics.errors.${state.error}`)}
            </p>
          )}
          <div
            className="relative w-full max-w-xl self-center overflow-hidden bg-black"
            style={{ aspectRatio: sourceRatio }}
          >
            <video
              ref={sourceVideo}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-contain"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget
                if (video.videoWidth && video.videoHeight)
                  setSourceRatio(video.videoWidth + ' / ' + video.videoHeight)
              }}
            />
            <div
              className="pointer-events-none absolute border-2 border-accent"
              style={{
                left: state.crop.x * 100 + '%',
                top: state.crop.y * 100 + '%',
                width: state.crop.width * 100 + '%',
                height: state.crop.height * 100 + '%'
              }}
            />
          </div>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="mb-2 text-sm font-medium">{t('cameraLyrics.crop')}</legend>
            {(['x', 'y', 'width', 'height'] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                {t(`cameraLyrics.${key}`)}
                <input
                  type="number"
                  min={key === 'width' || key === 'height' ? 5 : 0}
                  max="100"
                  step="1"
                  className={`${field} w-20`}
                  defaultValue={Math.round(state.crop[key] * 100)}
                  onBlur={(event) => {
                    event.currentTarget.value = String(
                      Math.round(useCameraLyricsStore.getState().crop[key] * 100)
                    )
                  }}
                  onChange={(event) => {
                    if (!event.target.value) return
                    state.setCrop({ ...state.crop, [key]: Number(event.target.value) / 100 })
                  }}
                />
              </label>
            ))}
          </fieldset>
          <p className="text-sm text-muted">{t('cameraLyrics.cropHint')}</p>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-2 text-sm">
              {t('cameraLyrics.font')}
              <select
                className={field}
                value={state.style.font}
                onChange={(event) => {
                  const font = LYRICS_FONTS.find((value) => value === event.target.value)
                  if (font) state.setStyle({ ...state.style, font })
                }}
              >
                {LYRICS_FONTS.map((font) => (
                  <option key={font} value={font}>
                    {t(font === 'sans-serif' ? 'cameraLyrics.systemFont' : 'cameraLyrics.notoFont')}
                  </option>
                ))}
              </select>
            </label>
            {(['fontSize', 'lineHeight', 'bottom'] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                {t(`cameraLyrics.${key}`)}
                <input
                  type="number"
                  className={`${field} w-24`}
                  defaultValue={state.style[key]}
                  onBlur={(event) => {
                    event.currentTarget.value = String(useCameraLyricsStore.getState().style[key])
                  }}
                  min={key === 'fontSize' ? 24 : key === 'lineHeight' ? 1 : 5}
                  max={key === 'fontSize' ? 160 : key === 'lineHeight' ? 2 : 50}
                  step={key === 'lineHeight' ? 0.05 : 1}
                  onChange={(event) => {
                    if (event.target.value)
                      state.setStyle({ ...state.style, [key]: Number(event.target.value) })
                  }}
                />
              </label>
            ))}
          </div>
          <p className="text-sm text-muted">{t('cameraLyrics.keyHint')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={field}
              aria-pressed={!state.visible}
              onClick={() => useCameraLyricsStore.setState({ visible: !state.visible })}
            >
              {t(state.visible ? 'cameraLyrics.hide' : 'cameraLyrics.show')}
            </button>
            <button
              type="button"
              className={field}
              onClick={() => {
                setDraft(state.lines.join('\n'))
                setInvalidDraft(false)
                setEditing(true)
              }}
            >
              {t('cameraLyrics.edit')}
            </button>
            {state.manual && (
              <button
                type="button"
                className={field}
                onClick={() => {
                  state.resume()
                  setEditing(false)
                }}
              >
                {t('cameraLyrics.resume')}
              </button>
            )}
          </div>
          {editing && (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-2 text-sm">
                {t('cameraLyrics.text')}
                <textarea
                  rows={4}
                  maxLength={3072}
                  className={field}
                  value={draft}
                  aria-invalid={invalidDraft}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setInvalidDraft(false)
                  }}
                />
              </label>
              <button
                type="button"
                className={`${field} self-start`}
                onClick={() => {
                  if (state.setManual(draft)) setEditing(false)
                  else setInvalidDraft(true)
                }}
              >
                {t('cameraLyrics.apply')}
              </button>
              {invalidDraft && <p role="alert">{t('cameraLyrics.inputError')}</p>}
              <p className="text-sm text-muted">{t('cameraLyrics.manualHint')}</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
