import { useLyricsLayout } from '@renderer/lib/lyrics/use-lyrics-layout'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ComboBox, Input, Label, ListBox, ListBoxItem, Slider } from '@heroui/react'
import { isElectron } from '@renderer/lib/env'
import LyricsPreview from './LyricsPreview'
import { useTranslation } from 'react-i18next'
import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'
import { isLyricsFont, LYRICS_FONTS } from '@shared/lyrics'
import {
  mergeFontFamilies,
  queryLocalFontFamiliesOnce,
  supportsLocalFontAccess
} from '@renderer/lib/local-fonts'
function reportOverflow(overflow: boolean): void {
  const state = useCameraLyricsStore.getState()
  if (overflow && state.error !== 'overflow') useCameraLyricsStore.setState({ error: 'overflow' })
  if (!overflow && state.error === 'overflow') useCameraLyricsStore.setState({ error: null })
}
export default function LyricsRecognitionControls({
  stream,
  onRetry
}: {
  stream: MediaStream | null
  onRetry?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const state = useCameraLyricsStore()
  useLyricsLayout(state, reportOverflow)
  const [draftCrop, setDraftCrop] = useState(state.crop)
  useEffect(() => setDraftCrop(state.crop), [state.crop, stream])
  const cropChanged = (Object.keys(draftCrop) as Array<keyof typeof draftCrop>).some(
    (key) => draftCrop[key] !== state.crop[key]
  )
  const holding =
    state.lines.length > 0 &&
    ['loading', 'recognizing', 'error'].includes(state.status) &&
    state.error !== 'overflow' &&
    state.error !== 'source'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!holding) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [holding])
  const [localFonts, setLocalFonts] = useState<string[]>([])
  const [localFontStatus, setLocalFontStatus] = useState<'idle' | 'loading' | 'failed'>('idle')
  const localFontsSupported = supportsLocalFontAccess()
  const fontFamilies = useMemo(
    () => mergeFontFamilies(LYRICS_FONTS, localFonts, [state.style.font]).filter(isLyricsFont),
    [localFonts, state.style.font]
  )
  const loadingFonts = useRef(false)
  const loadedFonts = useRef(false)
  const loadLocalFonts = useCallback(async (): Promise<void> => {
    if (!localFontsSupported || loadingFonts.current || loadedFonts.current) return
    loadingFonts.current = true
    setLocalFontStatus('loading')
    try {
      setLocalFonts(await queryLocalFontFamiliesOnce())
      loadedFonts.current = true
      setLocalFontStatus('idle')
    } catch {
      setLocalFontStatus('failed')
    } finally {
      loadingFonts.current = false
    }
  }, [localFontsSupported])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!localFontsSupported) return
      const allowed =
        isElectron() ||
        (
          await navigator.permissions
            ?.query({ name: 'local-fonts' as PermissionName })
            .catch(() => null)
        )?.state === 'granted'
      if (allowed && !cancelled) await loadLocalFonts()
    })()
    return () => {
      cancelled = true
    }
  }, [loadLocalFonts, localFontsSupported])
  const fontLabel = (font: string): string =>
    font === 'sans-serif'
      ? t('cameraLyrics.systemFont')
      : font === 'Noto Sans TC Variable'
        ? t('cameraLyrics.notoFont')
        : font === 'Noto Sans SC Variable'
          ? t('cameraLyrics.notoScFont')
          : font.replace(/ Variable$/, '')
  const fontItems = fontFamilies.map((font) => ({ id: font, name: fontLabel(font) }))
  const cropMaximum = (key: keyof typeof draftCrop): number =>
    Math.round(
      100 *
        (key === 'x'
          ? 1 - draftCrop.width
          : key === 'y'
            ? 1 - draftCrop.height
            : key === 'width'
              ? 1 - draftCrop.x
              : 1 - draftCrop.y)
    )
  const setCropPercent = (key: keyof typeof draftCrop, value: number): void => {
    const min = key === 'width' || key === 'height' ? 5 : 0
    setDraftCrop({ ...draftCrop, [key]: Math.min(cropMaximum(key), Math.max(min, value)) / 100 })
  }
  const cropInput = (key: keyof typeof draftCrop): React.JSX.Element => (
    <Input
      aria-label={t(`cameraLyrics.${key}`)}
      type="number"
      min={key === 'width' || key === 'height' ? 5 : 0}
      max={cropMaximum(key)}
      step={1}
      className="w-20"
      value={Math.round(draftCrop[key] * 100)}
      onChange={(event) => {
        if (event.target.value) setCropPercent(key, Number(event.target.value))
      }}
    />
  )
  const styleInput = (key: 'fontSize' | 'lineHeight' | 'bottom'): React.JSX.Element => (
    <label className="flex items-center gap-2 text-sm">
      {t(`cameraLyrics.${key}`)}
      <Input
        type="number"
        className="w-20"
        defaultValue={state.style[key]}
        min={key === 'fontSize' ? 24 : key === 'lineHeight' ? 1 : 5}
        max={key === 'fontSize' ? 160 : key === 'lineHeight' ? 2 : 50}
        step={key === 'lineHeight' ? 0.05 : 1}
        onBlur={(event) => {
          event.currentTarget.value = String(useCameraLyricsStore.getState().style[key])
        }}
        onChange={(event) => {
          if (event.target.value)
            state.setStyle({ ...state.style, [key]: Number(event.target.value) })
        }}
      />
    </label>
  )
  return (
    <section aria-label={t('cameraLyrics.title')} className="flex flex-col gap-4">
      {state.enabled && (
        <>
          <div role="status" className="text-sm font-medium">
            {t(
              state.hidden
                ? 'cameraLyrics.hidden'
                : holding
                  ? 'cameraLyrics.holding'
                  : `cameraLyrics.status.${state.status}`
            )}
          </div>
          {/* Keep status changes from scrolling the form and closing an open font picker. */}
          <p className="min-h-5 text-sm text-muted" aria-live="off">
            {holding &&
              !state.hidden &&
              t('cameraLyrics.heldDuration', {
                seconds: Math.max(0, Math.floor((now - state.acceptedAt) / 1000))
              })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onPress={() => state.setHidden(!state.hidden)}>
              {t(state.hidden ? 'cameraLyrics.show' : 'cameraLyrics.hide')}
            </Button>
            {onRetry && (state.error === 'load' || state.error === 'recognize') && (
              <Button variant="secondary" onPress={onRetry} isDisabled={state.status === 'loading'}>
                {t('cameraLyrics.retryRecognition')}
              </Button>
            )}
          </div>
          <p role={state.error ? 'alert' : undefined} className="min-h-10 text-sm text-danger">
            {state.error && t(`cameraLyrics.errors.${state.error}`)}
          </p>
          <LyricsPreview stream={stream} crop={draftCrop} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
            <label htmlFor="lyrics-height" className="text-sm font-medium">
              {t('cameraLyrics.recognitionHeight')}
            </label>
            <Slider
              id="lyrics-height"
              aria-label={t('cameraLyrics.height')}
              minValue={5}
              maxValue={cropMaximum('height')}
              step={1}
              value={Math.round(draftCrop.height * 100)}
              onChange={(value) => {
                if (typeof value === 'number') setCropPercent('height', value)
              }}
              className="min-w-32 max-w-sm flex-1 py-3"
            >
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
            <div className="flex items-center gap-2">
              {cropInput('height')}
              <span className="text-sm text-muted">%</span>
            </div>
            <span className="text-sm text-muted">
              {t('cameraLyrics.cropOrigin', { top: Math.round(draftCrop.y * 100) })}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {(['x', 'y', 'width'] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                {t(`cameraLyrics.${key}`)}
                {cropInput(key)}
                <span className="text-muted">%</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button isDisabled={!cropChanged} onPress={() => state.setCrop(draftCrop)}>
              {t('cameraLyrics.applyCrop')}
            </Button>
            <Button
              variant="tertiary"
              isDisabled={!cropChanged}
              onPress={() => setDraftCrop(state.crop)}
            >
              {t('cameraLyrics.cancelCrop')}
            </Button>
            {cropChanged && (
              <span className="text-sm text-muted">{t('cameraLyrics.cropPending')}</span>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <ComboBox
              className="w-80 max-w-full"
              defaultItems={fontItems}
              selectedKey={state.style.font}
              onSelectionChange={(key) => {
                if (typeof key === 'string' && fontFamilies.includes(key))
                  state.setStyle({ ...state.style, font: key })
              }}
              onOpenChange={(open) => {
                if (open) void loadLocalFonts()
              }}
            >
              <Label>{t('cameraLyrics.font')}</Label>
              <ComboBox.InputGroup className="w-full">
                <Input placeholder={t('cameraLyrics.searchFonts')} className="min-w-0 flex-1" />
                <ComboBox.Trigger />
              </ComboBox.InputGroup>
              <ComboBox.Popover>
                <ListBox
                  className="max-h-64 overflow-auto"
                  renderEmptyState={() => (
                    <p className="p-3 text-sm text-muted">{t('cameraLyrics.noFonts')}</p>
                  )}
                >
                  {(item: { id: string; name: string }) => (
                    <ListBoxItem id={item.id} textValue={item.name}>
                      {item.name}
                    </ListBoxItem>
                  )}
                </ListBox>
              </ComboBox.Popover>
            </ComboBox>
            <div className="flex h-10 items-center">{styleInput('fontSize')}</div>
            <Button
              type="button"
              variant={state.style.bold ? 'primary' : 'secondary'}
              className="h-10 font-bold"
              aria-pressed={state.style.bold}
              onPress={() => state.setStyle({ ...state.style, bold: !state.style.bold })}
            >
              {t('cameraLyrics.bold')}
            </Button>
            <div className="flex h-10 items-center">{styleInput('lineHeight')}</div>
            <div className="flex h-10 items-center">{styleInput('bottom')}</div>
          </div>
          {localFontStatus === 'loading' && (
            <p className="text-sm text-muted">{t('cameraLyrics.loadingFonts')}</p>
          )}
          {localFontStatus === 'failed' && (
            <div className="flex items-center gap-3 text-sm">
              <p role="alert">{t('cameraLyrics.localFontsFailed')}</p>
              <Button type="button" variant="secondary" onPress={() => void loadLocalFonts()}>
                {t('cameraLyrics.retryFonts')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
