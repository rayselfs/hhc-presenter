import webFixture from './fixtures/weekly-reader-hhc-web.json'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWeeklyClient, parseWeeklyDocument, type WeeklyIssue } from '../weekly-reader'

const issue: WeeklyIssue = {
  series: 'general',
  locale: 'zh-Hant',
  issueId: '00000000-0000-4000-8000-000000000001',
  documentId: '00000000-0000-4000-8000-000000000002',
  revision: 2,
  issueNumber: 1740,
  issueDate: '2026-09-27',
  title: '週報'
}
const receiptId = '00000000-0000-4000-8000-000000000003'
const requestId = '00000000-0000-4000-8000-000000000004'
const auth = { getAccessToken: async () => 'old', refreshAfterUnauthorized: async () => 'new' }
function fixture(): { document: Record<string, unknown>; access: Record<string, unknown> } {
  const validated = Date.now()
  const identity = {
    documentId: issue.documentId,
    series: issue.series,
    contentLocale: issue.locale,
    revision: issue.revision
  }
  const slots = (start: number, end: number): Record<string, unknown>[] => [
    {
      id: 'p' + start,
      box: { x: 0, y: 0.5 },
      blockId: 'b',
      fragments: [{ sentenceId: 'sentence', start, end }]
    }
  ]
  return {
    document: {
      ...identity,
      issueId: issue.issueId,
      canonicalMetadata: { title: '標題' },
      content: {
        schemaVersion: '1',
        pages: [{ id: 'cover' }, { id: 'p2' }],
        layoutManifest: {
          rendererVersion: 'v11',
          pages: [
            {
              pageId: 'cover',
              fixedSlots: [{ id: 'f', element: 'title', box: { x: 0, y: 0 } }],
              slots: slots(0, 2)
            },
            { pageId: 'p2', slots: slots(2, 3) }
          ]
        },
        components: [
          {
            type: 'hymnLyrics',
            hymnLyrics: {
              hymns: [
                {
                  sections: [
                    {
                      lines: [
                        {
                          id: 'b',
                          sentences: [{ id: 'sentence', spans: [{ text: '𩸽光' }, { text: '照' }] }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          }
        ]
      }
    },
    access: {
      ...identity,
      accountId: 'subject',
      currentRevision: 2,
      receiptId,
      traceCode: 'HHC-123',
      validatedAt: new Date(validated).toISOString(),
      offlineValidUntil: new Date(validated + 604800000).toISOString()
    }
  }
}
describe('weekly reader contract', () => {
  afterEach(() => vi.unstubAllGlobals())
  // hhc-web 07b9cb3c, src/features/weekly-reader/test-fixture.ts, readerFixture().
  it('reads the four published pages from the website golden fixture', () => {
    const document = webFixture.document
    const issued = new Date().toISOString()
    const data = {
      document,
      access: {
        ...webFixture.access,
        receiptId,
        validatedAt: issued,
        offlineValidUntil: new Date(Date.parse(issued) + 604800000).toISOString()
      }
    }
    const result = parseWeeklyDocument(
      data,
      {
        ...issue,
        documentId: document.documentId,
        issueId: document.issueId,
        revision: document.revision
      },
      webFixture.access.accountId
    )
    expect(result.pages.map((page) => [page.label, page.blocks[0].fragments[0].text])).toEqual([
      ['封面', '內容0。'],
      ['第 1 頁', '內容1。'],
      ['第 2 頁', '內容2。'],
      ['封底', '內容3。']
    ])
  })
  it('uses exact edition entitlements', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        entitlements: [
          { entitlementCode: 'bulletin.children.en.access' },
          { entitlementCode: 'bulletin.children.zh-Hans.access' },
          { entitlementCode: 'cms:bulletins:read' }
        ]
      })
    )
    await expect(
      createWeeklyClient('https://example.test', auth, fetcher).editions()
    ).resolves.toEqual([{ series: 'children', locale: 'en' }])
  })
  it('keeps canonical issue numbers and counts PDF-only results in server pagination', async () => {
    const row = {
      ...issue,
      contentLocale: issue.locale,
      issueNumber: null,
      onlineRevision: 2,
      canonicalMetadata: { title: issue.title, issueNumber: 1740 }
    }
    const fetcher = async (): Promise<Response> =>
      Response.json({
        data: { items: [row, { ...row, onlineRevision: null }], total: 27, offset: 0, limit: 20 }
      })
    const client = createWeeklyClient('https://example.test', auth, fetcher)
    await expect(client.list(issue, 0)).resolves.toEqual({
      total: 27,
      offset: 0,
      limit: 20,
      items: [issue]
    })
  })
  it('preserves a receipt request on refresh and slices fragments at Unicode code points', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const raw = JSON.stringify({ data: fixture(), error: null, meta: {} })
    const hash = createHash('sha256').update(raw).digest('hex')
    const fetcher = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(raw, {
          headers: { 'Content-Type': 'application/json', 'X-HHC-Content-SHA256': hash }
        })
      )
    const doc = await createWeeklyClient('https://example.test', auth, fetcher).open(
      issue,
      'subject',
      requestId
    )
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body)
    expect(doc.pages[0].blocks.map((block) => block.fragments[0].text)).toEqual(['標題', '𩸽光'])
    expect(doc.pages[1].blocks[0].fragments[0]).toEqual({
      sentenceId: 'sentence',
      start: 2,
      text: '照'
    })
    expect(doc.traceCode).toBe('HHC-123')
  })
  it('rejects unreadable or incorrect digest, receipt or selected edition', async () => {
    for (const hash of ['', '0'.repeat(64)]) {
      const fetcher = async (): Promise<Response> =>
        Response.json(
          { data: fixture(), error: null, meta: {} },
          { headers: { 'Content-Type': 'application/json', 'X-HHC-Content-SHA256': hash } }
        )
      await expect(
        createWeeklyClient('https://example.test', auth, fetcher).open(issue, 'subject', requestId)
      ).rejects.toThrow()
    }
    expect(() => parseWeeklyDocument(fixture(), issue, 'other')).toThrow()
    expect(() => parseWeeklyDocument(fixture(), { ...issue, revision: 3 }, 'subject')).toThrow()
    const invalid = fixture()
    invalid.access.receiptId = ''
    expect(() => parseWeeklyDocument(invalid, issue, 'subject')).toThrow()
  })
})
