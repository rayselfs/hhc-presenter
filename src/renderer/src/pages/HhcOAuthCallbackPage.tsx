import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import icon from '@renderer/assets/icon.png'
import { createHhcAuthAdapter } from '@renderer/lib/hhc-auth'

export default function HhcOAuthCallbackPage(): React.JSX.Element {
  const [status, setStatus] = useState<'pending' | 'complete' | 'failed'>('pending')
  const { t } = useTranslation()
  const title =
    status === 'complete'
      ? t('authCallback.completeTitle')
      : status === 'failed'
        ? t('authCallback.failedTitle')
        : t('authCallback.pendingTitle')
  const description =
    status === 'complete'
      ? t('authCallback.completeDescription')
      : status === 'failed'
        ? t('authCallback.failedDescription')
        : t('authCallback.pendingDescription')

  useEffect(() => {
    let active = true
    let adapter: Awaited<ReturnType<typeof createHhcAuthAdapter>> | undefined
    void createHhcAuthAdapter()
      .then(async (created) => {
        adapter = created
        return created.getSession()
      })
      .then((session) => {
        if (active) setStatus(session ? 'complete' : 'failed')
      })
      .catch(() => {
        if (active) setStatus('failed')
      })
    return () => {
      active = false
      adapter?.dispose()
    }
  }, [])

  return (
    <main className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-3xl border border-divider bg-content1 p-8 text-center shadow-xl">
        <img className="mx-auto mb-6 h-20 w-20 rounded-2xl" src={icon} alt={t('app.name')} />
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-foreground-500">{description}</p>
      </section>
    </main>
  )
}
