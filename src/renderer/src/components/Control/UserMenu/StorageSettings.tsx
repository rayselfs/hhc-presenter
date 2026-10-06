import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@heroui/react/button'
import { RefreshCw } from 'lucide-react'
import {
  getMediaStorageAccounting,
  type MediaStorageAccountingReport,
  type MediaStorageUsage
} from '@renderer/lib/media-storage-accounting'
import {
  clearRegenerableDerivedAssets,
  clearUnpinnedSyncCache,
  removeUnusedDerivedAssets
} from '@renderer/lib/media-storage-cleanup'

export type StorageSettingsSection = 'usage' | 'cleanup'

interface StorageSettingsProps {
  section?: StorageSettingsSection
}

type StorageUsageLabelKey =
  | 'preferences.storage.usage.sourceMedia'
  | 'preferences.storage.usage.coversAndPreviews'
  | 'preferences.storage.usage.pdfPreviews'
  | 'preferences.storage.usage.offlineSyncFiles'
  | 'preferences.storage.usage.temporaryFiles'
  | 'preferences.storage.usage.videoPlaybackCache'

interface StorageUsageGroup {
  key: string
  labelKey: StorageUsageLabelKey
  buckets: (keyof MediaStorageUsage)[]
}

const STORAGE_USAGE_GROUPS: StorageUsageGroup[] = [
  {
    key: 'videoPlaybackCache',
    labelKey: 'preferences.storage.usage.videoPlaybackCache',
    buckets: ['videoRemuxCache']
  },
  {
    key: 'sourceMedia',
    labelKey: 'preferences.storage.usage.sourceMedia',
    buckets: [
      'electronNativeSourceMedia',
      'webIndexedDbSourceBlobs',
      'legacyElectronIndexedDbBlobs'
    ]
  },
  {
    key: 'coversAndPreviews',
    labelKey: 'preferences.storage.usage.coversAndPreviews',
    buckets: [
      'generatedCoverThumbnails',
      'customCoverOverrides',
      'videoPosters',
      'presentationDocuments'
    ]
  },
  {
    key: 'pdfPreviews',
    labelKey: 'preferences.storage.usage.pdfPreviews',
    buckets: ['pdfPageThumbnails']
  },
  {
    key: 'offlineSyncFiles',
    labelKey: 'preferences.storage.usage.offlineSyncFiles',
    buckets: ['syncCache']
  },
  {
    key: 'temporaryFiles',
    labelKey: 'preferences.storage.usage.temporaryFiles',
    buckets: ['temporaryAndFailedJobFiles']
  }
]

const CLEANUP_ACTIONS = [
  {
    key: 'removeOrphans',
    action: removeUnusedDerivedAssets
  },
  {
    key: 'clearRegenerable',
    action: clearRegenerableDerivedAssets
  },
  {
    key: 'clearSyncCache',
    action: clearUnpinnedSyncCache
  }
] as const

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export default function StorageSettings({
  section = 'usage'
}: StorageSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const [storageReport, setStorageReport] = useState<MediaStorageAccountingReport | null>(null)
  const [storageError, setStorageError] = useState(false)
  const [isLoadingStorage, setIsLoadingStorage] = useState(false)
  const [isCleaningStorage, setIsCleaningStorage] = useState(false)

  const refreshStorageReport = useCallback(async (): Promise<void> => {
    setIsLoadingStorage(true)
    setStorageError(false)
    try {
      setStorageReport(await getMediaStorageAccounting())
    } catch {
      setStorageError(true)
    } finally {
      setIsLoadingStorage(false)
    }
  }, [])

  useEffect(() => {
    if (section !== 'usage') return
    void refreshStorageReport()
  }, [refreshStorageReport, section])

  async function runStorageCleanup(action: () => Promise<unknown>): Promise<void> {
    setIsCleaningStorage(true)
    setStorageError(false)
    try {
      await action()
      await refreshStorageReport()
    } catch {
      setStorageError(true)
    } finally {
      setIsCleaningStorage(false)
    }
  }

  if (section === 'cleanup') {
    return (
      <section className="p-5">
        {storageError && (
          <p role="alert" className="text-sm text-danger">
            {t('error.somethingWentWrong')}
          </p>
        )}
        <div>
          {CLEANUP_ACTIONS.map((item) => (
            <div key={item.key} className="border-t border-default-200 py-4 first:border-t-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold">
                    {t(`preferences.storage.cleanup.actions.${item.key}.title`)}
                  </h4>
                  <p className="mt-1 text-xs text-gray-500">
                    {t(`preferences.storage.cleanup.actions.${item.key}.description`)}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="shrink-0 rounded-full"
                  isDisabled={isCleaningStorage}
                  onPress={() => void runStorageCleanup(item.action)}
                >
                  {t(`preferences.storage.cleanup.actions.${item.key}.button`)}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="p-2 relative space-y-3">
      {storageError && (
        <p role="alert" className="text-sm text-danger">
          {t('error.somethingWentWrong')}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          className="rounded-full h-10 w-10"
          isDisabled={isLoadingStorage}
          aria-label={t('preferences.storage.refresh')}
          onPress={() => void refreshStorageReport()}
        >
          <RefreshCw className={`size-4 ${isLoadingStorage ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <dl className="px-3 pb-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
        {STORAGE_USAGE_GROUPS.map((group) => (
          <div key={group.key} className="contents">
            <dt className="text-gray-500">{t(group.labelKey)}</dt>
            <dd>
              {formatBytes(
                group.buckets.reduce(
                  (total, bucket) => total + (storageReport?.usage[bucket] ?? 0),
                  0
                )
              )}
            </dd>
          </div>
        ))}
        <div className="contents font-semibold">
          <dt>{t('preferences.storage.total')}</dt>
          <dd>{formatBytes(storageReport?.total ?? 0)}</dd>
        </div>
      </dl>

      {storageReport?.browser && (
        <div className="rounded-xl bg-default-100 px-3 py-2 text-xs text-gray-600">
          {t('preferences.storage.browserEstimate', {
            usage: formatBytes(storageReport.browser.usage ?? 0),
            quota: formatBytes(storageReport.browser.quota ?? 0),
            persisted: storageReport.browser.persisted
              ? t('preferences.storage.persistedYes')
              : t('preferences.storage.persistedNo')
          })}
        </div>
      )}
    </section>
  )
}
