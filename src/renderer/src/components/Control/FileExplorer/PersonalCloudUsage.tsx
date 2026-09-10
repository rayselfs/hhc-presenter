import { Button, Popover } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { formatPersonalGiB } from '@shared/personal-cloud'

export function PersonalCloudUsage(): React.JSX.Element | null {
  const { t } = useTranslation()
  const usage = usePersonalSyncStore((state) => state.usage)
  if (!usage) return null
  const label = `${formatPersonalGiB(usage.usedBytes)} / ${formatPersonalGiB(usage.quotaBytes)} GiB`
  const ratio = usage.usedBytes / usage.quotaBytes
  const tone = ratio >= 1 ? 'text-danger' : ratio >= 0.8 ? 'text-warning' : 'text-foreground/50'

  return (
    <Popover>
      <Popover.Trigger>
        <Button
          aria-label={label}
          className={`h-auto min-w-0 px-1 py-0 text-xs ${tone}`}
          variant="tertiary"
        >
          {label}
        </Button>
      </Popover.Trigger>
      <Popover.Content placement="top end">
        <Popover.Dialog className="grid min-w-48 gap-1 p-3 text-xs">
          <UsageRow label={t('personalCloud.activeBytes')} value={usage.activeBytes} />
          <UsageRow label={t('personalCloud.trashBytes')} value={usage.trashBytes} />
          <UsageRow
            label={t('personalCloud.availableBytes')}
            value={Math.max(0, usage.quotaBytes - usage.usedBytes)}
          />
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

function UsageRow({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <span>{label}</span>
      <span>{formatPersonalGiB(value)} GiB</span>
    </div>
  )
}
