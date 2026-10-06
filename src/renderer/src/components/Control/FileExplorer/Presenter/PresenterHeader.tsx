import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@heroui/react'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import ReadinessIssueDrawer from './ReadinessIssueDrawer'

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatClock(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

interface PresenterHeaderProps {
  onExit: () => void
}

export default function PresenterHeader({ onExit }: PresenterHeaderProps): React.JSX.Element {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = useState(0)
  const [clockTime, setClockTime] = useState(() => new Date())
  const [isReadinessOpen, setIsReadinessOpen] = useState(false)
  const isEnded = useMediaProjectionStore((state) => state.isEnded)
  const renderStatus = useMediaProjectionStore((state) => state.projectionRenderStatus)
  const readinessReport = useMediaProjectionStore((state) => state.lastReadinessReport)
  const playlist = useMediaProjectionStore((state) => state.playlist)
  const skippedIds = useMediaProjectionStore((state) => state.skippedReadinessIds)
  const skippedCount =
    readinessReport?.items.filter(
      (item) =>
        !playlist.some((entry) => entry.id === item.itemId) && !skippedIds.includes(item.itemId)
    ).length ?? 0

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((s) => s + 1)
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      setClockTime(new Date())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="relative flex min-h-12 shrink-0 items-center justify-between gap-2 px-3 py-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          isIconOnly
          data-testid="media-back-to-files"
          onPress={onExit}
          aria-label={t('common.close')}
          className="text-foreground/70 hover:text-foreground"
        >
          <X size={20} />
        </Button>
        <span className="text-foreground/70 text-lg font-mono">{formatElapsed(elapsed)}</span>
        {renderStatus && !isEnded && (
          <span role="status" className="min-w-0 break-words text-xs text-default-500">
            {t(
              `fileExplorer.presenter.projectionStatus.${renderStatus.status}`,
              renderStatus.status === 'ready'
                ? 'Projected'
                : renderStatus.status === 'failed'
                  ? 'Projection failed'
                  : 'Preparing projection'
            )}
            {renderStatus.status === 'failed' && (
              <>
                <span>
                  {' '}
                  · {playlist.find((item) => item.id === renderStatus.itemId)?.name} ·{' '}
                  {t(
                    `fileExplorer.presenter.projectionFailure.${renderStatus.reason ?? 'render-failed'}`
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => useMediaProjectionStore.getState().retryCurrentProjection()}
                >
                  {t('fileExplorer.presenter.retryProjection', 'Retry projection')}
                </Button>
              </>
            )}
          </span>
        )}
        {readinessReport && (skippedCount > 0 || isReadinessOpen) && (
          <button
            type="button"
            className="flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-700 hover:bg-warning/20"
            title={t('fileExplorer.presenter.readinessSummary', {
              defaultValue:
                '{{ready}} ready, {{preparing}} preparing, {{unsupported}} unsupported, {{missing}} missing, {{failed}} failed',
              ready: readinessReport.summary.ready,
              preparing: readinessReport.summary.preparing,
              unsupported: readinessReport.summary.unsupported,
              missing: readinessReport.summary.missing,
              failed: readinessReport.summary.failed
            })}
            onClick={() => setIsReadinessOpen(true)}
            aria-expanded={isReadinessOpen}
          >
            <AlertTriangle size={12} />
            {t('fileExplorer.presenter.pendingItems', '{{count}} need attention', {
              count: skippedCount
            })}
          </button>
        )}
      </div>
      <span className="text-foreground/70 text-lg font-mono">{formatClock(clockTime)}</span>
      {isReadinessOpen && readinessReport && (
        <ReadinessIssueDrawer report={readinessReport} onClose={() => setIsReadinessOpen(false)} />
      )}
    </div>
  )
}
