import { useSearchParams } from 'react-router-dom'

/**
 * Query state, held in the URL.
 *
 * The project's standing rule is that the *whole* query lives in the URL — it
 * is the only place a navigation cannot lose it, and the only place a view can
 * be shared, bookmarked or returned to. The stats page was the one screen that
 * broke it: its range and scope were `useState`, so a filtered stats view could
 * not be linked and a reload threw it away.
 *
 * Three rules keep the URL honest, and each was a bug somewhere first:
 *
 *  1. **A refinement replaces; navigation pushes.** Every control built on this
 *     narrows the view you are already looking at, so it must not cost a back
 *     step — one history entry per chip or per keystroke buries whatever the
 *     user actually wants to go back to. Paging is the exception and pushes;
 *     it lives in `usePageParam`.
 *  2. **A default never survives into the URL.** Naming the value a page
 *     already opens on says nothing, and a link spelling out every default
 *     reads as noise rather than as a view somebody chose. So a value equal to
 *     its fallback is *deleted*, never written.
 *  3. **A URL is untrusted input.** It is typed, truncated, edited by hand and
 *     kept in bookmarks long after the page that wrote it changed. Every value
 *     read back is checked against exactly what the API accepts — the stats
 *     `days` parameter is declared `ge=7, le=3650`, so `?range=99999` or
 *     `?range=banana` is a 422 and an error card where the charts should be.
 *     Anything unrecognised falls back to the page default.
 *
 * NOTE for a later change: `useBrowseFilters` in `components/BrowseFilters.tsx`
 * implements these same three rules by hand and should eventually sit on this
 * primitive, so there is one place they live rather than two that can drift.
 * That migration is deliberately not done here — it needs `usePageParam` and
 * the whole `/api/media` query shape moved with it.
 */

/**
 * One query parameter: where it lives in the URL, the values the API will
 * accept, and the value that means "unset" and is therefore never written.
 */
export interface UrlParam<T extends string> {
  key: string
  /** The exact set the API accepts. Anything else reads back as `fallback`. */
  allowed: readonly T[]
  /** The page default. Never appears in the URL. */
  fallback: T
}

export type UrlParamSpec = Record<string, UrlParam<string>>

type ValueOf<P> = P extends UrlParam<infer T> ? T : never

export type UrlParamValues<S extends UrlParamSpec> = { [K in keyof S]: ValueOf<S[K]> }

export interface UrlParamsState<S extends UrlParamSpec> {
  /** The current, validated value of every declared parameter. */
  values: UrlParamValues<S>
  /** Write one parameter. Replaces rather than pushes; drops it if it is the default. */
  set: <K extends keyof S>(name: K, value: ValueOf<S[K]>) => void
  /** Drop every declared parameter, leaving anything else in the query alone. */
  reset: () => void
  /** True when at least one parameter is off its default. */
  active: boolean
}

/**
 * Read one validated parameter out of a query string.
 *
 * Exported on its own because validation is useful outside the hook — a loader
 * or a test has the same question and should not have to render to ask it.
 */
export function readUrlParam<T extends string>(
  params: URLSearchParams,
  param: UrlParam<T>,
): T {
  const raw = params.get(param.key)
  return param.allowed.includes(raw as T) ? (raw as T) : param.fallback
}

/**
 * Bind a set of validated query parameters to the URL.
 *
 * `clearOnChange` names parameters that stop meaning anything once one of these
 * changes — the browse pages' `page`, because narrowing results renumbers them
 * and "page 4" of the old filter is not a place that still exists.
 */
export function useUrlParams<S extends UrlParamSpec>(
  spec: S,
  options: { clearOnChange?: readonly string[] } = {},
): UrlParamsState<S> {
  const [params, setParams] = useSearchParams()

  const names = Object.keys(spec) as Array<keyof S & string>
  const values = Object.fromEntries(
    names.map((name) => [name, readUrlParam(params, spec[name])] as const),
  ) as UrlParamValues<S>

  const write = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params)
    mutate(next)
    for (const key of options.clearOnChange ?? []) next.delete(key)
    // A refinement, not a navigation: replace so Back still leads out of the
    // page rather than back through every control the user touched.
    setParams(next, { replace: true })
  }

  return {
    values,
    set: (name, value) =>
      write((next) => {
        const param: UrlParam<string> = spec[name]
        // Rule 2: the default is the absence of the parameter, not a value of it.
        if ((value as string) === param.fallback) next.delete(param.key)
        else next.set(param.key, value as string)
      }),
    reset: () =>
      write((next) => {
        for (const name of names) next.delete(spec[name].key)
      }),
    active: names.some(
      (name) => (values[name] as string) !== spec[name].fallback,
    ),
  }
}
