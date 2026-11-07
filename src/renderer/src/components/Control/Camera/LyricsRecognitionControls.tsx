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
  stream
}: {
  stream: MediaStream | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const state = useCameraLyricsStore()
  useLyricsLayout(state, reportOverflow)
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
  const cropMaximum = (key: keyof typeof state.crop): number =>
    Math.round(
      100 *
        (key === 'x'
          ? 1 - state.crop.width
          : key === 'y'
            ? 1 - state.crop.height
            : key === 'width'
              ? 1 - state.crop.x
              : 1 - state.crop.y)
    )
  const setCropPercent = (key: keyof typeof state.crop, value: number): void => {
    const min = key === 'width' || key === 'height' ? 5 : 0
    state.setCrop({ ...state.crop, [key]: Math.min(cropMaximum(key), Math.max(min, value)) / 100 })
  }
  const cropInput = (key: keyof typeof state.crop): React.JSX.Element => (
    <Input
      aria-label={t(`cameraLyrics.${key}`)}
      type="number"
      min={key === 'width' || key === 'height' ? 5 : 0}
      max={cropMaximum(key)}
      step={1}
      className="w-20"
      value={Math.round(state.crop[key] * 100)}
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
            {t(`cameraLyrics.status.${state.status}`)}
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {t(`cameraLyrics.errors.${state.error}`)}
            </p>
          )}
          <LyricsPreview stream={stream} />
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
              value={Math.round(state.crop.height * 100)}
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
              {t('cameraLyrics.cropOrigin', { top: Math.round(state.crop.y * 100) })}
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
