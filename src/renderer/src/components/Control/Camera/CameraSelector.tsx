import { useState } from 'react'
import { Select } from '@heroui/react/select'
import { ListBox } from '@heroui/react/list-box'
import { useTranslation } from 'react-i18next'
import { ShortcutScope } from '@renderer/contexts/ShortcutScopeContext'
import { useCameraSession } from '@renderer/contexts/CameraSessionContext'
import { useCameraStore } from '@renderer/stores/camera'
import { isElectron } from '@renderer/lib/env'
import { cameraSourceKind, type CameraSourceKind } from '@shared/camera'

export default function CameraSelector(): React.JSX.Element {
  const { t } = useTranslation()
  const camera = useCameraSession()
  const [typeOpen, setTypeOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const { devices, desktopSources, sourceKind, deviceId, busy, selectorOpen } = useCameraStore()
  const sources =
    sourceKind === 'video'
      ? devices
      : isElectron()
        ? desktopSources.filter((source) => source.kind === sourceKind)
        : [
            ...(deviceId.startsWith('browser:') && cameraSourceKind(deviceId) === sourceKind
              ? [
                  {
                    id: deviceId,
                    label: deviceId.split(':').slice(2).join(':') || t('camera.shareSource')
                  }
                ]
              : []),
            { id: `browser:${sourceKind}`, label: t('camera.shareSource') }
          ]
  return (
    <div
      className="flex w-full min-w-0 items-center gap-2"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      {focused && <ShortcutScope name="camera-source">{null}</ShortcutScope>}
      <Select
        aria-label={t('camera.sourceType')}
        value={sourceKind}
        onOpenChange={(open) => {
          setTypeOpen(open)
          useCameraStore.setState({ selectorOpen: open })
        }}
        isDisabled={busy}
        onChange={(key) => {
          if (!key || busy) return
          useCameraStore.setState({
            sourceKind: String(key) as CameraSourceKind,
            selectorOpen: false
          })
        }}
        className="w-32 shrink-0"
      >
        <Select.Trigger
          data-testid="camera-source-type-selector"
          className="h-10 rounded-full border border-border bg-transparent text-foreground hover:bg-default/60"
        >
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {(['screen', 'window', 'video'] as const).map((kind) => (
              <ListBox.Item key={kind} id={kind} textValue={t(`camera.sourceTypes.${kind}`)}>
                {t(`camera.sourceTypes.${kind}`)}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <Select
        key={sourceKind}
        allowsEmptyCollection
        aria-label={t('camera.choose')}
        placeholder={t('camera.choose')}
        value={sources.some((source) => source.id === deviceId) ? deviceId : null}
        isOpen={selectorOpen && !typeOpen}
        onOpenChange={(open) => {
          useCameraStore.setState({ selectorOpen: open })
          if (open) void camera.prepareSources()
        }}
        onChange={(key) => {
          if (key && !busy) void camera.selectSource(String(key))
        }}
        className="w-64 min-w-0 flex-1"
      >
        <Select.Trigger
          data-testid="camera-source-selector"
          className="rounded-full h-10 items-center text-foreground bg-transparent border border-border hover:bg-default/60 transition-colors"
        >
          <Select.Value className="flex min-w-0 justify-center truncate" />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox aria-busy={busy}>
            {sources
              .filter((source) => source.id)
              .map((source) => (
                <ListBox.Item
                  key={source.id}
                  id={source.id}
                  textValue={source.label}
                  isDisabled={busy}
                  className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
                >
                  {source.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  )
}
