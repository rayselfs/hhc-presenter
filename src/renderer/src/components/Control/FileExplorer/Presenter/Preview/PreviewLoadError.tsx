import { useTranslation } from 'react-i18next'
interface PreviewLoadErrorProps {
  message: string
  retryLabel: string
  onRetry: () => void
}

export default function PreviewLoadError({
  message,
  retryLabel,
  onRetry
}: PreviewLoadErrorProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-black">
      <div role="alert" className="text-white/50 text-center">
        <p>{t('presenter.previewUnavailable', 'Operator preview unavailable')}</p>
        {message}
      </div>
      <button
        type="button"
        className="rounded-lg border border-white/30 px-4 py-2 text-sm text-white hover:bg-white/10"
        onClick={onRetry}
      >
        {retryLabel}
      </button>
    </div>
  )
}
