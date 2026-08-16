import { cn } from '@/lib/utils'

/**
 * A content rating, drawn the way a certificate is drawn: boxed.
 *
 * Purely presentational. It takes the text it is given — the filter table has
 * already run `certificateLabel` over the raw value — because the raw string is
 * what the URL and the API carry and nothing here is allowed anywhere near
 * that. See `lib/certificates.ts`.
 *
 * The box is not decoration: `18`, `15` and `12` are indistinguishable from
 * years, runtimes and ratings when set as plain text in a list of filters, and
 * a boxed certificate is the form every board in the world already prints.
 */
export function CertificateBadge({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border border-line bg-raised px-1.5 py-0.5',
        'text-[0.7rem] font-semibold leading-none tracking-wide text-subtle',
        className,
      )}
    >
      {children}
    </span>
  )
}
