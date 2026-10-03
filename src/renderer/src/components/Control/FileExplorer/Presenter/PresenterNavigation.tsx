import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, ProgressBar } from '@heroui/react'
import { toast } from '@heroui/react/toast'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import {
  resolveMediaProjectionAction,
  type MediaProjectionActionResult
} from '@renderer/stores/media-projection'
import { getMediaType } from '@renderer/lib/presentability'

export default function PresenterNavigation({ onNext }: { onNext: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const canPrev = useMediaProjectionStore((s) => s.canPrev())
  const canNext = useMediaProjectionStore((s) => s.canNext())
  const progress = useMediaProjectionStore((s) => s.progress())
  const currentItem = useMediaProjectionStore((s) => s.currentItem())
  const currentIndex = useMediaProjectionStore((s) => s.currentIndex)
  const total = useMediaProjectionStore((s) => s.playlist.length)
  const presentation = useMediaProjectionStore((s) => s.typeStates.presentation)
  const isEnded = useMediaProjectionStore((s) => s.isEnded)
  const prev = useMediaProjectionStore((s) => s.prev)

  const navigate = async (action: () => MediaProjectionActionResult): Promise<void> => {
    if ((await resolveMediaProjectionAction(action())).status === 'blocked') {
      toast.danger(t('presentationWorkspace.saveFailed', 'Unable to save presentation'))
    }
  }

  const isPresentation = getMediaType(currentItem?.mimeType ?? '') === 'presentation'
  const progressPercent =
    isPresentation && presentation?.slideCount
      ? ((presentation.slideIndex + 1) / presentation.slideCount) * 100
      : total > 0
        ? ((currentIndex + 1) / total) * 100
        : 0
  const [progressCurrent = '0', progressTotal = '0'] = progress
    .split('/')
    .map((part) => part.trim())

  return (
    <div className="px-4 pb-3 shrink-0 flex justify-center">
      <div className="flex items-center gap-3 w-full max-w-80">
        <Button
          variant="outline"
          isIconOnly
          isDisabled={!canPrev}
          onPress={() => void navigate(prev)}
          className="presenter-navigation-button w-12 h-12 rounded-full shrink-0"
          aria-label={t('presenter.prev')}
        >
          <ChevronLeft className="w-7 h-7" />
        </Button>

        <div className="min-w-0 flex-1 flex flex-col justify-center gap-1">
          <div className="text-foreground/60 text-base text-center">
            {t('presenter.slideInfo', { current: progressCurrent, total: progressTotal })}
          </div>
          <ProgressBar
            value={progressPercent}
            minValue={0}
            maxValue={100}
            aria-label={t('fileExplorer.presenter.progress')}
            className="w-full"
          >
            <ProgressBar.Track className="h-1">
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        </div>

        <Button
          variant="outline"
          isIconOnly
          isDisabled={!canNext && !isEnded}
          onPress={onNext}
          className="presenter-navigation-button w-12 h-12 rounded-full shrink-0"
          aria-label={t('presenter.next')}
        >
          <ChevronRight className="w-7 h-7" />
        </Button>
      </div>
    </div>
  )
}
