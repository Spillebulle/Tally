import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * The page number, and the stepper that moves it.
 *
 * Its own module because History uses it without any of the filter machinery —
 * and because `?page=` has to mean one thing everywhere: 1-based as written,
 * because that is what the label beside it says and what anyone reading the URL
 * will assume, 0-based as used, because that is what an offset wants.
 */

/**
 * `?page=3` is the third page.
 *
 * Anything else reads as the first page. A URL is typed, truncated and pasted
 * by hand, so `page=banana` and `page=-4` have to mean something harmless
 * rather than becoming a nonsense offset in a request.
 */
const pageParam = (raw: string | null): number => {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value) - 1)
}

export interface PageState {
  /** Zero-based, because that is what an offset wants. */
  page: number
  setPage: (page: number, options?: { replace?: boolean }) => void
}

/**
 * The page number, held in the URL.
 *
 * Paging *pushes* a history entry: stepping back from page three to page two
 * is exactly what the back button is for. Everything else on the filter bar
 * replaces instead — a filter is a refinement of the view you are already on,
 * and one entry per keystroke or per chip would bury whatever you want to go
 * back to.
 */
export function usePageParam(): PageState {
  const [params, setParams] = useSearchParams()
  return {
    page: pageParam(params.get('page')),
    setPage: (page, options) => {
      const next = new URLSearchParams(params)
      if (page <= 0) next.delete('page')
      else next.set('page', String(page + 1))
      setParams(next, { replace: options?.replace ?? false })
    },
  }
}

/**
 * The page stepper, shared by every paged list.
 *
 * It also owns the out-of-range case, which is why it is mounted even when
 * there is nothing to step through. A page number in the URL can outlive the
 * results it described — a link kept from last month, a row deleted, a library
 * that shrank — and an offset past the end answers with an empty grid under a
 * "Page 9 of 3" label. Stepping back to the last real page *replaces* the
 * entry, so pressing Back does not walk straight into it again.
 *
 * `ready` gates that, and is not optional: while the first request is in
 * flight the total is zero and every page looks out of range, so clamping then
 * would throw the page away a moment before its own results arrived.
 */
export function Pagination({
  page,
  pageCount,
  onPage,
  ready,
}: {
  page: number
  pageCount: number
  onPage: PageState['setPage']
  ready: boolean
}) {
  const last = Math.max(0, pageCount - 1)

  // `onPage` closes over the current query and is rebuilt every render, so it
  // stays out of the dependency list — in it, this would re-run constantly.
  // The condition is the guard, and it stops being true the moment it acts.
  useEffect(() => {
    if (ready && page > last) onPage(last, { replace: true })
  }, [ready, page, last])

  if (pageCount <= 1) return null

  return (
    <nav className="mt-6 flex items-center justify-center gap-2" aria-label="Pagination">
      <button
        type="button"
        onClick={() => onPage(Math.max(0, page - 1))}
        disabled={page === 0}
        title={page === 0 ? 'Already on the first page' : undefined}
        className="btn-secondary"
      >
        Previous
      </button>
      <span className="px-2 text-control text-muted">
        Page <span className="figure">{page + 1}</span> of{' '}
        <span className="figure">{pageCount}</span>
      </span>
      <button
        type="button"
        onClick={() => onPage(Math.min(last, page + 1))}
        disabled={page >= last}
        title={page >= last ? 'Already on the last page' : undefined}
        className="btn-secondary"
      >
        Next
      </button>
    </nav>
  )
}
