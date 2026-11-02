import { Select } from '@heroui/react/select'
import { ListBox } from '@heroui/react/list-box'
import { Label } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useSettingsStore } from '@renderer/stores/settings'

export default function BibleSettingsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const speech = useSettingsStore((state) => state.speech)
  const setSpeech = useSettingsStore((state) => state.setSpeech)
  const limit = useBibleSettingsStore((s) => s.speechMaxSessionSec)
  const setLimit = useBibleSettingsStore((s) => s.setSpeechMaxSessionSec)
  const limits = [...new Set([0, 1800, 3600, 7200, limit])].sort((a, b) => a - b)
  return (
    <div className="space-y-3">
      <Select
        value={speech.recognitionLanguage}
        onChange={(key) => {
          if (key === 'zh' || key === 'en') setSpeech({ ...speech, recognitionLanguage: key })
        }}
      >
        <Label>{t('localSpeech.language')}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id="zh" textValue="中文">
              中文
            </ListBox.Item>
            <ListBox.Item id="en" textValue="English">
              English
            </ListBox.Item>
          </ListBox>
        </Select.Popover>
      </Select>
      <Select value={String(limit)} onChange={(key) => setLimit(Number(key))}>
        <Label>{t('localSpeech.stopAfter')}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {limits.map((seconds) => (
              <ListBox.Item
                id={String(seconds)}
                key={seconds}
                textValue={
                  seconds
                    ? t('localSpeech.minutes', { count: seconds / 60 })
                    : t('localSpeech.noDeadline')
                }
              >
                {seconds
                  ? t('localSpeech.minutes', { count: seconds / 60 })
                  : t('localSpeech.noDeadline')}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <p className="text-sm text-muted">{t('localSpeech.settingsHelp')}</p>
    </div>
  )
}
