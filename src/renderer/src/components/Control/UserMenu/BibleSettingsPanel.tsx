import { SpeechKeySettings } from './SpeechKeySettings'
import { Select } from '@heroui/react/select'
import { ListBox } from '@heroui/react/list-box'
import { Label } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useSettingsStore } from '@renderer/stores/settings'

export default function BibleSettingsPanel({
  onOpenBible
}: {
  onOpenBible?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const speech = useSettingsStore((state) => state.speech)
  const setSpeech = useSettingsStore((state) => state.setSpeech)
  const limit = useBibleSettingsStore((s) => s.speechMaxSessionSec)
  const setLimit = useBibleSettingsStore((s) => s.setSpeechMaxSessionSec)
  const limits = [...new Set([0, 1800, 3600, 7200, limit])].sort((a, b) => a - b)
  return (
    <div className="space-y-6 p-5">
      <h2 className="text-xl font-semibold tracking-tight">{t('localSpeech.title')}</h2>
      <SpeechKeySettings onOpenBible={onOpenBible} />
      <div className="grid gap-4">
        <Select
          variant="secondary"
          value={speech.recognitionLanguage}
          onChange={(key) => {
            if (key === 'zh' || key === 'en') setSpeech({ ...speech, recognitionLanguage: key })
          }}
        >
          <Label className="text-sm font-medium">{t('localSpeech.language')}</Label>
          <Select.Trigger className="w-full rounded-xl">
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
        <Select variant="secondary" value={String(limit)} onChange={(key) => setLimit(Number(key))}>
          <Label className="text-sm font-medium">{t('localSpeech.stopAfter')}</Label>
          <Select.Trigger className="w-full rounded-xl">
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
      </div>
    </div>
  )
}
