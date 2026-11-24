import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { FilePdfIcon } from '@phosphor-icons/react'
import { Search } from 'lucide-react'
import { useHhcAuth } from '@renderer/contexts/HhcAuthContext'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { invalidateWeeklyAccess, useWeeklyAccess } from '@renderer/stores/weekly-access'
import { listWeeklyIssues, openWeeklyIssue } from '@renderer/lib/weekly-reader'
import BulletinPresentation from '@renderer/components/Control/Bulletin/BulletinPresentation'
import type { WeeklyDocument, WeeklyEdition, WeeklyIssue } from '@shared/weekly-reader'

const issueKey = (issue: WeeklyIssue): string =>
  [issue.series, issue.locale, issue.issueId, issue.revision].join('/')
const filename = (issue: WeeklyIssue): string =>
  [issue.issueNumber, issue.title].filter(Boolean).join('-')

function errorStatus(error: unknown): number | undefined {
  return error instanceof Error && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined
}

export default function BulletinsPage(): React.JSX.Element {
  const { owner, editions, status } = useWeeklyAccess()
  const { t } = useTranslation()
  const { mode } = useParams()
  if (mode && mode !== 'present') return <Navigate replace to="/bulletins" />
  if (!owner || !editions.length)
    return (
      <div className="m-6" role="status">
        {status === 'error' ? t('bulletins.accessError') : t('bulletins.restricted')}
        {mode && <Navigate to="/bulletins" replace />}
      </div>
    )
  return <Archive key={JSON.stringify([owner, editions])} owner={owner} editions={editions} />
}

function Archive({
  owner,
  editions
}: {
  owner: string
  editions: WeeklyEdition[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const auth = useHhcAuth()
  const authRef = useRef(auth)
  authRef.current = auth
  const navigate = useNavigate()
  const { mode } = useParams()
  const { ensureProjectionOpen, getProjectionIntentRevision } = useProjection()
  const [issues, setIssues] = useState<WeeklyIssue[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<'list' | 'open' | 'updated' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [opening, setOpening] = useState<string | null>(null)
  const [current, setCurrent] = useState<{ issue: WeeklyIssue; document: WeeklyDocument } | null>(
    null
  )
  const pending = useRef<AbortController | null>(null)
  const request = useRef<{ key: string; id: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    async function load(): Promise<void> {
      setLoading(true)
      setError((previous) => (previous === 'updated' ? previous : null))
      try {
        const all: WeeklyIssue[] = []
        for (const edition of editions) {
          let offset = 0
          do {
            const page = await listWeeklyIssues(edition, offset, authRef.current, controller.signal)
            controller.signal.throwIfAborted()
            all.push(...page.items)
            if (page.limit <= 0 || page.offset !== offset) throw new Error('Invalid archive page')
            offset += page.limit
            if (offset >= page.total) break
          } while (!controller.signal.aborted)
        }
        setIssues(
          Array.from(new Map(all.map((issue) => [issueKey(issue), issue])).values()).sort(
            (a, b) =>
              b.issueDate.localeCompare(a.issueDate) || (b.issueNumber ?? 0) - (a.issueNumber ?? 0)
          )
        )
      } catch (cause) {
        if (!controller.signal.aborted) {
          const status = errorStatus(cause)
          if (status === 401 || status === 403) invalidateWeeklyAccess()
          else setError('list')
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [editions, attempt])

  useEffect(() => () => pending.current?.abort(), [])
  useEffect(() => {
    if (!mode) setCurrent(null)
  }, [mode])

  async function open(issue: WeeklyIssue): Promise<void> {
    const key = issueKey(issue)
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    const id = request.current.id
    setOpening(key)
    setSelected(key)
    setError(null)
    const intent = getProjectionIntentRevision()
    try {
      const [windowResult, document] = await Promise.all([
        ensureProjectionOpen(),
        openWeeklyIssue(issue, authRef.current, id, controller.signal)
      ])
      controller.signal.throwIfAborted()
      if (intent !== getProjectionIntentRevision()) return
      if (!windowResult.ok) throw new Error('Projection unavailable')
      request.current = null
      setCurrent({ issue, document })
      void navigate('/bulletins/present')
    } catch (cause) {
      if (!controller.signal.aborted) {
        const status = errorStatus(cause)
        if (status === 401 || status === 403) invalidateWeeklyAccess()
        else if (status === 404 || status === 409) {
          request.current = null
          setIssues([])
          setError('updated')
          setAttempt((value) => value + 1)
        } else setError('open')
      }
    } finally {
      if (!controller.signal.aborted) setOpening(null)
    }
  }

  if (mode === 'present') {
    if (!current) return <Navigate replace to="/bulletins" />
    return (
      <BulletinPresentation
        {...current}
        accountId={owner}
        onExit={() => void navigate('/bulletins', { replace: true })}
      />
    )
  }
  const search = query.trim().toLocaleLowerCase()
  const visible = issues.filter((issue) =>
    (filename(issue) + ' ' + issue.issueDate).toLocaleLowerCase().includes(search)
  )
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-3 py-3 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('nav.bulletins')}</h1>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-muted">
          <Search size={16} aria-hidden="true" />
          <input
            className="min-w-0 bg-transparent text-sm text-foreground outline-none focus-visible:underline"
            type="search"
            aria-label={t('bulletins.search')}
            placeholder={t('bulletins.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {loading && <p role="status">{t('bulletins.loading')}</p>}
      {error === 'updated' && <p role="status">{t('bulletins.updated')}</p>}
      {(error === 'list' || error === 'open') && (
        <div role="alert" className="flex items-center gap-3">
          {t(error === 'list' ? 'bulletins.listError' : 'bulletins.openError')}
          <button
            className="underline"
            onClick={() => {
              if (error === 'list') setAttempt((value) => value + 1)
              else {
                const issue = issues.find((item) => issueKey(item) === selected)
                if (issue) void open(issue)
              }
            }}
          >
            {t('bulletins.retry')}
          </button>
        </div>
      )}
      {!loading && !error && !visible.length && (
        <p role="status">{t(search ? 'bulletins.noMatches' : 'bulletins.empty')}</p>
      )}
      {opening && <p role="status">{t('bulletins.opening')}</p>}
      <ul className="divide-y divide-border">
        {visible.map((issue) => {
          const key = issueKey(issue)
          return (
            <li key={key}>
              <button
                type="button"
                aria-pressed={key === selected}
                className="flex w-full items-center gap-4 rounded-lg px-3 py-3 text-start hover:bg-surface aria-pressed:bg-accent/10 focus-visible:outline-accent"
                onClick={() => setSelected(key)}
                onDoubleClick={() => void open(issue)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.repeat) {
                    event.preventDefault()
                    void open(issue)
                  }
                }}
              >
                <FilePdfIcon size={36} aria-hidden="true" className="shrink-0 text-danger" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium">{filename(issue)}</span>
                  <span className="text-sm text-muted">
                    {t(issue.series === 'general' ? 'bulletins.general' : 'bulletins.children')} ·{' '}
                    {issue.locale}
                  </span>
                </span>
                <time className="text-sm tabular-nums text-muted">{issue.issueDate}</time>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
