import type { BulletinBlock, BulletinPage } from './bulletin-reader'

export interface WeeklyEdition {
  series: 'general' | 'children'
  locale: 'zh-Hant' | 'zh-Hans' | 'en'
}
export interface WeeklyIssue extends WeeklyEdition {
  issueId: string
  documentId: string
  revision: number
  issueNumber: number | null
  issueDate: string
  title: string
}
export interface WeeklyDocument {
  pages: BulletinPage[]
  traceCode: string
}
export interface WeeklyList {
  items: WeeklyIssue[]
  total: number
  offset: number
  limit: number
}
export const weeklyEditions: WeeklyEdition[] = [
  { series: 'general', locale: 'zh-Hant' },
  { series: 'general', locale: 'zh-Hans' },
  { series: 'general', locale: 'en' },
  { series: 'children', locale: 'zh-Hant' },
  { series: 'children', locale: 'en' }
]
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid weekly bulletin')
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] {
  requireValue(Array.isArray(value))
  return value
}
function string(value: unknown): string {
  requireValue(typeof value === 'string')
  return value
}
function integer(value: unknown, min = 0): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= min)
  return value
}
function id(value: unknown): string {
  requireValue(typeof value === 'string' && uuid.test(value))
  return value
}
function edition(value: WeeklyEdition): URLSearchParams {
  requireValue(weeklyEditions.some((e) => e.series === value?.series && e.locale === value?.locale))
  return new URLSearchParams({ series: value.series, locale: value.locale })
}

export interface WeeklyTransport {
  getAccessToken(): Promise<string | null>
  refreshAfterUnauthorized(token: string): Promise<string | null>
}

export class WeeklyHttpError extends Error {
  constructor(readonly status: number) {
    super('Weekly bulletin HTTP ' + status)
  }
}

export interface WeeklyClient {
  editions(signal?: AbortSignal): Promise<WeeklyEdition[]>
  list(selected: WeeklyEdition, offset: number, signal?: AbortSignal): Promise<WeeklyList>
  open(
    issue: WeeklyIssue,
    accountId: string,
    clientRequestId: string,
    signal?: AbortSignal
  ): Promise<WeeklyDocument>
}

async function readWeeklyBytes(response: Response): Promise<ArrayBuffer> {
  const limit = 9 * 1024 * 1024
  requireValue(Number(response.headers.get('content-length')) <= limit)
  const reader = response.body?.getReader()
  requireValue(reader)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new Error('Weekly bulletin exceeds size limit')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}
export function createWeeklyClient(
  origin: string,
  transport: WeeklyTransport,
  fetcher: (url: string, init: RequestInit) => Promise<Response>
): WeeklyClient {
  async function request(
    path: string,
    init: RequestInit,
    digest = false
  ): Promise<Record<string, unknown>> {
    const send = (token: string): Promise<Response> =>
      fetcher(origin + path, {
        ...init,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: 'Bearer ' + token
        }
      })
    const token = await transport.getAccessToken()
    if (!token) throw new WeeklyHttpError(401)
    let response = await send(token)
    if (response.status === 401) {
      const refreshed = await transport.refreshAfterUnauthorized(token)
      if (!refreshed) throw new WeeklyHttpError(401)
      response = await send(refreshed)
    }
    if (!response.ok) throw new WeeklyHttpError(response.status)
    requireValue(
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ===
        'application/json'
    )
    const bytes = await readWeeklyBytes(response)
    init.signal?.throwIfAborted()
    if (digest) {
      const expected = response.headers.get('X-HHC-Content-SHA256')
      requireValue(expected && /^[a-f0-9]{64}$/.test(expected))
      const calculated = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      requireValue(
        Array.from(calculated, (byte) => byte.toString(16).padStart(2, '0')).join('') === expected
      )
    }
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  }
  return {
    async editions(signal?: AbortSignal): Promise<WeeklyEdition[]> {
      const snapshot = await request('/api/operations/me/access', { signal })
      const codes = new Set(array(snapshot.entitlements).map((row) => object(row).entitlementCode))
      return weeklyEditions.filter((e) =>
        codes.has('bulletin.' + e.series + '.' + e.locale + '.access')
      )
    },
    async list(selected: WeeklyEdition, offset: number, signal?: AbortSignal): Promise<WeeklyList> {
      const query = edition(selected)
      requireValue(integer(offset) <= 1000000)
      query.set('offset', String(offset))
      query.set('limit', '20')
      const envelope = await request('/api/member/bulletins/online?' + query, { signal })
      const data = object(envelope.data)
      requireValue(data.offset === offset && data.limit === 20)
      const items = array(data.items)
        .map(object)
        .filter((row) => row.onlineRevision !== null)
        .map((row) => {
          requireValue(row.series === selected.series && row.contentLocale === selected.locale)
          return {
            series: selected.series,
            locale: selected.locale,
            issueId: id(row.issueId),
            documentId: id(row.documentId),
            revision: integer(row.onlineRevision, 1),
            issueNumber: integer(row.issueNumber ?? object(row.canonicalMetadata).issueNumber, 1),
            issueDate: string(row.issueDate),
            title: string(object(row.canonicalMetadata).title)
          }
        })
      return { items, offset, limit: 20, total: integer(data.total) }
    },
    async open(
      issue: WeeklyIssue,
      accountId: string,
      clientRequestId: string,
      signal?: AbortSignal
    ): Promise<WeeklyDocument> {
      edition(issue)
      id(issue.documentId)
      const path =
        '/api/member/bulletins/' +
        id(issue.issueId) +
        '/versions/' +
        issue.locale +
        '/online/access?series=' +
        issue.series
      const envelope = await request(
        path,
        {
          method: 'POST',
          body: JSON.stringify({
            clientRequestId: id(clientRequestId),
            revision: integer(issue.revision, 1)
          }),
          signal
        },
        true
      )
      requireValue(envelope.error === null)
      return parseWeeklyDocument(envelope.data, issue, accountId)
    }
  }
}

// Non-interactive paper decorations are omitted from the operator's reading order.
const fixedLabels: Record<string, [string, string]> = {
  masthead: ['哈利路亞家教會 週報', '哈利路亚家教会 周报'],
  welcomeLabel: ['Welcome', 'Welcome'],
  worshipLabel: ['Worship', 'Worship'],
  workLabel: ['Work', 'Work'],
  wordLabel: ['Word', 'Word'],
  verseLabel: ['本週金句', '本周金句'],
  hymnLabel: ['小組詩歌', '小组诗歌'],
  summaryLabel: ['信息摘要', '信息摘要'],
  announcementsLabel: ['家教會公佈欄', '家教会公布栏'],
  prayersLabel: ['得勝與代求', '得胜与代求'],
  titleLabel: ['本週靈糧主題', '本周灵粮主题'],
  speakerLabel: ['講員', '讲员'],
  bodySpeakerLabel: ['講員', '讲员'],
  transcriberLabel: ['謄修', '誊修'],
  editorLabel: ['完稿', '完稿'],
  authorLabel: ['作者', '作者'],
  visionMission: ['異象使命：華人遍地興起、福音傳到地極', '异象使命：华人遍地兴起、福音传到地极'],
  visionFellowship: [
    '團契行動：共同生活、愛與成全、恩膏傳承',
    '团契行动：共同生活、爱与成全、恩膏传承'
  ],
  visionCommitment: [
    '堅持理想：宣教主導、靈恩神學、團隊事奉、門徒訓練',
    '坚持理想：宣教主导、灵恩神学、团队事奉、门徒训练'
  ]
}
function fixedText(
  element: string,
  metadata: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  locale: WeeklyEdition['locale']
): string {
  if (element === 'title' || element === 'subtitle' || element === 'date')
    return string(metadata[element])
  if (element === 'issueNumber') return '第' + integer(metadata.issueNumber, 1) + '期'
  const label = fixedLabels[element]?.[locale === 'zh-Hans' ? 1 : 0] ?? ''
  if (element.startsWith('vision') && typeof snapshot[element] === 'string' && label)
    return label.split('：')[0] + '：' + snapshot[element]
  return label
}
export function parseWeeklyDocument(
  value: unknown,
  issue: WeeklyIssue,
  accountId: string
): WeeklyDocument {
  const data = object(value)
  const doc = object(data.document)
  const access = object(data.access)
  requireValue(
    access.accountId === accountId &&
      doc.issueId === issue.issueId &&
      doc.documentId === issue.documentId &&
      access.documentId === doc.documentId &&
      doc.series === issue.series &&
      access.series === doc.series &&
      doc.contentLocale === issue.locale &&
      access.contentLocale === doc.contentLocale &&
      doc.revision === issue.revision &&
      access.revision === doc.revision &&
      integer(access.currentRevision, 1) >= issue.revision
  )
  id(access.receiptId)
  const until = Date.parse(string(access.offlineValidUntil))
  requireValue(until > Date.now() && until - Date.parse(string(access.validatedAt)) === 604800000)
  const traceCode = string(access.traceCode)
  requireValue(traceCode.trim().length > 0)
  const content = object(doc.content)
  const manifest = object(content.layoutManifest)
  requireValue(
    content.schemaVersion === '1' && /^v(?:[1-9]|10|11)$/.test(string(manifest.rendererVersion))
  )
  const metadata = object(doc.canonicalMetadata)
  const snapshot = content.templateSnapshot ? object(content.templateSnapshot) : {}
  const sentences = new Map<string, { text: string[]; kind: BulletinBlock['kind'] }>()
  const pictures: Record<string, unknown>[] = []
  function index(node: unknown, kind: BulletinBlock['kind']): void {
    if (Array.isArray(node)) {
      node.forEach((child) => index(child, kind))
      return
    }
    if (node === null || typeof node !== 'object') return
    const item = object(node)
    if (Array.isArray(item.sentences)) {
      for (const raw of item.sentences) {
        const sentence = object(raw)
        const key = string(sentence.id)
        requireValue(!sentences.has(key))
        sentences.set(key, {
          text: Array.from(
            array(sentence.spans)
              .map((span) => string(object(span).text))
              .join('')
          ),
          kind
        })
      }
      return
    }
    for (const [key, child] of Object.entries(item)) {
      if (key === 'illustrations') pictures.push(...array(child).map(object))
      else index(child, key === 'title' ? 'heading' : kind)
    }
  }
  for (const comp of array(content.components).map(object))
    index(comp, comp.type === 'hymnLyrics' ? 'lyrics' : 'paragraph')
  const layouts = array(manifest.pages).map(object)
  const pages = array(content.pages).map((page, index): BulletinPage => {
    const pageId = string(object(page).id)
    const layout = layouts.find((item) => item.pageId === pageId)
    requireValue(layout)
    const blocks: BulletinBlock[] = []
    const positions = new Map<string, { x: number; y: number }>()
    for (const item of [...array(layout.fixedSlots ?? []), ...array(layout.slots)].map(object)) {
      const box = object(item.box)
      requireValue(typeof box.x === 'number' && typeof box.y === 'number')
      positions.set(string(item.id), { x: box.x, y: box.y })
    }
    for (const raw of array(layout.fixedSlots ?? [])) {
      const element = string(object(raw).element)
      const text = fixedText(element, metadata, snapshot, issue.locale)
      if (text) {
        blocks.push({
          id: string(object(raw).id),
          kind: 'heading',
          fragments: [{ sentenceId: 'canonical-' + element, start: 0, text: String(text) }]
        })
      }
    }
    const slots = array(layout.slots).map(object)
    for (const slot of slots) {
      let kind: BulletinBlock['kind']
      const fragments = array(slot.fragments).map((raw) => {
        const fragment = object(raw)
        const sentenceId = string(fragment.sentenceId)
        const sentence = sentences.get(sentenceId)
        requireValue(sentence)
        const start = integer(fragment.start)
        const end = integer(fragment.end, 1)
        requireValue(end > start && end <= sentence.text.length)
        kind = sentence.kind
        return { sentenceId, start, text: sentence.text.slice(start, end).join('') }
      })
      blocks.push({ id: string(slot.id), kind, fragments })
    }
    blocks.sort((a, b) => {
      const left = positions.get(a.id)!
      const right = positions.get(b.id)!
      return left.y - right.y || left.x - right.x
    })
    for (const picture of pictures.filter((pic) => pic.pageId === pageId)) {
      const png = string(picture.png)
      requireValue(png.length <= 2796204 && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(png))
      const afterSlot = slots.filter((slot) => slot.blockId === picture.afterBlockId).at(-1)
      const blockIndex = blocks.findIndex((block) => block.id === afterSlot?.id)
      blocks.splice(blockIndex < 0 ? blocks.length : blockIndex + 1, 0, {
        id: string(picture.id),
        fragments: [],
        image: { src: 'data:image/png;base64,' + png, alt: string(picture.alt) }
      })
    }
    let label = '第 ' + index + (issue.locale === 'zh-Hans' ? ' 页' : ' 頁')
    if (index === 0) label = '封面'
    else if (index === layouts.length - 1) label = '封底'
    return { id: pageId, label, blocks }
  })
  requireValue(
    pages.length > 0 &&
      pages.length === layouts.length &&
      new Set(pages.map((page) => page.id)).size === pages.length
  )
  return { traceCode, pages }
}
