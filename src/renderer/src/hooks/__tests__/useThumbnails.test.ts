import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { useThumbnails } from '../useThumbnails'
import * as thumbnailDb from '@renderer/lib/thumbnail-db'

vi.mock('@renderer/lib/thumbnail-db', () => ({
  getThumbnail: vi.fn()
}))

const mockGetThumbnail = vi.mocked(thumbnailDb.getThumbnail)

function makeItem(
  id: string,
  mimeType = 'image/jpeg',
  createdAt = 0
): { id: string; url: string; mimeType: string; createdAt: number } {
  return { id, url: `blob:${id}`, mimeType, createdAt }
}

describe('useThumbnails', () => {
  beforeEach(() => {
    mockGetThumbnail.mockReset()
  })

  describe('cache pruning', () => {
    it('removes keys no longer in items when items array changes', async () => {
      mockGetThumbnail.mockResolvedValue('data:image/jpeg;base64,abc')

      const itemsABC = [makeItem('A'), makeItem('B'), makeItem('C')]
      const { result, rerender, unmount } = renderHook(({ items }) => useThumbnails(items), {
        initialProps: { items: itemsABC }
      })

      await waitFor(() => {
        expect(Object.keys(result.current)).toContain('A')
        expect(Object.keys(result.current)).toContain('B')
        expect(Object.keys(result.current)).toContain('C')
      })

      // Remove B
      const itemsAC = [makeItem('A'), makeItem('C')]
      rerender({ items: itemsAC })

      await waitFor(() => {
        expect(Object.keys(result.current)).not.toContain('B')
        expect(Object.keys(result.current)).toContain('A')
        expect(Object.keys(result.current)).toContain('C')
      })
      unmount()
    })
  })

  it('loads copied items from their canonical blob identity', async () => {
    mockGetThumbnail.mockResolvedValue('blob:shared-cover')

    const items = [
      {
        id: 'copy-item',
        url: 'blob:original-blob',
        mimeType: 'image/jpeg',
        createdAt: 0
      }
    ]
    const { unmount } = renderHook(() => useThumbnails(items))

    await waitFor(() => {
      expect(mockGetThumbnail).toHaveBeenCalledWith('copy-item', 'original-blob')
    })
    unmount()
  })

  it('shows a thumbnail generated after the item was rendered', async () => {
    mockGetThumbnail.mockResolvedValue(null)
    const items = [makeItem('personal-item')]
    const { result, unmount } = renderHook(() => useThumbnails(items))

    act(() => {
      window.dispatchEvent(
        new CustomEvent('hhc:thumbnail-ready', {
          detail: { itemId: 'personal-item', dataUrl: 'data:image/jpeg;base64,dGh1bWI=' }
        })
      )
    })

    expect(result.current['personal-item']).toBe('data:image/jpeg;base64,dGh1bWI=')
    unmount()
  })

  describe('revokeIfBlobUrl', () => {
    it('calls URL.revokeObjectURL for removed blob: URLs', async () => {
      const revokeObjectURL = vi.fn()
      vi.stubGlobal('URL', { ...URL, revokeObjectURL })

      // First render: A has blob URL, B has data URL
      mockGetThumbnail.mockImplementation(async (id: string) => {
        if (id === 'A') return 'blob:http://localhost/fake-blob-id'
        if (id === 'B') return 'data:image/jpeg;base64,abc'
        return null
      })

      const itemsAB = [makeItem('A'), makeItem('B')]
      const { result, rerender, unmount } = renderHook(({ items }) => useThumbnails(items), {
        initialProps: { items: itemsAB }
      })

      await waitFor(() => {
        expect(result.current['A']).toBe('blob:http://localhost/fake-blob-id')
        expect(result.current['B']).toBe('data:image/jpeg;base64,abc')
      })

      // Remove A (which has blob URL)
      rerender({ items: [makeItem('B')] })

      await waitFor(() => {
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/fake-blob-id')
      })

      // B's data URL should NOT trigger revoke
      expect(revokeObjectURL).not.toHaveBeenCalledWith('data:image/jpeg;base64,abc')
      unmount()
    })

    it('revokes a blob URL that resolves after unmount', async () => {
      const revokeObjectURL = vi.fn()
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: revokeObjectURL
      })
      let resolveThumbnail: ((url: string) => void) | undefined
      mockGetThumbnail.mockReturnValue(
        new Promise((resolve) => {
          resolveThumbnail = resolve
        })
      )
      const container = document.createElement('div')
      const root = createRoot(container)
      const Probe = (): null => {
        useThumbnails([makeItem('A')])
        return null
      }
      const reactEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      const originalActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT
      reactEnvironment.IS_REACT_ACT_ENVIRONMENT = false
      try {
        flushSync(() => root.render(createElement(Probe)))
        await Promise.resolve()
        expect(mockGetThumbnail).toHaveBeenCalledOnce()

        flushSync(() => root.unmount())
        resolveThumbnail?.('blob:http://localhost/late-thumbnail')
        await Promise.resolve()
        await Promise.resolve()

        expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/late-thumbnail')
      } finally {
        reactEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
      }
    })
  })
})
