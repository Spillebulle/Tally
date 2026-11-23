/*
 * A page of posters that ends on a full row.
 *
 * `.poster-grid` reflows to as many columns as fit, so a fixed page size of 60
 * fills the last row only when the column count happens to divide 60. On a
 * window holding seven columns, that is four posters and three empty slots at
 * the bottom of every page.
 *
 * So the page size is not fixed: it is the target rounded to whole rows of the
 * grid as it is actually drawn. The count is *measured*, not derived from the
 * floor and the window width, because the track sizing lives in index.css and
 * a second copy of that arithmetic here would drift from it - the same reason
 * `cardSizeStyle` sets a custom property rather than a template.
 *
 * Until the grid has been measured there is no page size at all (`null`), and
 * callers hold the request back until there is. Fetching 60 and then refetching
 * 63 a frame later would be two requests and a visible jump on every load. The
 * skeleton grid carries the same ref, so the measurement happens while it shows.
 *
 * A change in column count - resizing the window, or picking another poster
 * size - changes the page size, and so the offset of the current page. That is
 * the honest consequence of "pages are whole rows"; the reader stays on the
 * same page number and sees a slightly different slice.
 */
import { useCallback, useRef, useState } from 'react'

/** How many column tracks a grid container is drawing right now. */
function columnsOf(element: HTMLElement): number {
  // The computed value lists every resolved track ("180px 180px …"), whatever
  // `repeat(auto-fill, …)` the stylesheet wrote. Not a grid yet reads "none".
  const template = getComputedStyle(element).gridTemplateColumns
  if (!template || template === 'none') return 1
  return Math.max(1, template.split(' ').filter(Boolean).length)
}

/** The target, rounded to the nearest whole number of rows - never zero rows. */
export function wholeRows(target: number, columns: number): number {
  return Math.max(1, Math.round(target / columns)) * columns
}

export function useGridFill(target: number) {
  const [columns, setColumns] = useState<number | null>(null)
  const observer = useRef<ResizeObserver | null>(null)

  // A callback ref, because the element changes under it: the skeleton grid is
  // replaced by the real one, and the empty state removes it altogether. The
  // last count is kept while no grid is mounted.
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!element) return
    const measure = () => {
      const next = columnsOf(element)
      // Only a change in *count* matters; every pixel of a resize must not
      // become a new request.
      setColumns((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure)
      observer.current.observe(element)
    }
  }, [])

  return { ref, pageSize: columns === null ? null : wholeRows(target, columns) }
}
