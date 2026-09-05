import { useFalsePositiveRate } from '../hooks/useFalsePositiveRate'

/**
 * Header-mounted false-positive-rate badge. Sits right after the [report]
 * button. Styled as a static (non-link) sibling of `GetAlertsButton`'s
 * desktop variant — same outline-red-on-white brutalist box, but a `span`
 * since there's nowhere for it to navigate to.
 *
 * Hidden while loading and when there's no data yet (zero posts, or the
 * stats query hasn't resolved) — a "0%" badge before any posts exist would
 * read as a claim rather than an absence of data.
 */
export function FalsePositiveRateBadge() {
  const { ratePercent, revokedCount, totalCount, isLoading } = useFalsePositiveRate()

  if (isLoading || ratePercent === null || totalCount === 0) return null

  const display = ratePercent < 10 ? ratePercent.toFixed(1) : Math.round(ratePercent).toString()

  return (
    <span
      title={`${revokedCount} of ${totalCount} posts revoked (>2 downvotes)`}
      aria-label={`false positive rate: ${display} percent, ${revokedCount} of ${totalCount} posts revoked`}
      className="inline-flex items-center gap-1 whitespace-nowrap border-2 border-red-600 bg-white text-red-600 px-3 py-1 text-[11px] uppercase tracking-widest font-black"
    >
      {display}% fp rate
    </span>
  )
}
