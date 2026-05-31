/**
 * DonationsTimeline — renders the list of donations below the goal bar.
 *
 * Walking skeleton (slice #205):
 *   - Newest-first order only (no sort controls — those land in #208).
 *   - Each row: donor address, nominal amount, token symbol, chain badge,
 *     timestamp (relative), and explorer tx link.
 *   - "Load more" button when hasMore.
 *   - Responsive: desktop table, mobile stacked cards.
 *   - Mock-data mode renders sample donations (VITE_USE_MOCK_DATA=true).
 *
 * Intentionally no em-dashes in copy. All chain label text is "onchain".
 */

import type { Donation } from '../lib/queries'
import { getChainBySlug, explorerTxUrl, explorerAddressUrl } from '../lib/chains'
import { ChainBadge } from './ChainBadge'

export type { Donation }

interface DonationsTimelineProps {
  donations: readonly Donation[]
  isLoading: boolean
  isError: boolean
  hasMore: boolean
  onLoadMore: () => void
  isFetchingMore: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate an address to 0x…1234 format. */
const shortAddr = (addr: string): string =>
  `${addr.slice(0, 6)}...${addr.slice(-4)}`

/** Format a block_timestamp ISO string to a relative human time. */
const relativeTime = (iso: string): string => {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function DonationRow({ donation }: { donation: Donation }) {
  const chain = getChainBySlug(donation.chainSlug)
  const txUrl = chain ? explorerTxUrl(chain, donation.txHash) : null
  const addrUrl = chain ? explorerAddressUrl(chain, donation.fromAddress) : null

  return (
    <>
      {/* Desktop row — hidden on mobile */}
      <tr className="hidden sm:table-row border-b border-neutral-200 hover:bg-neutral-50 transition-colors">
        <td className="py-2 px-3 font-mono text-xs text-neutral-700">
          {addrUrl ? (
            <a
              href={addrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-black underline underline-offset-2"
              title={donation.fromAddress}
            >
              {shortAddr(donation.fromAddress)}
            </a>
          ) : (
            <span title={donation.fromAddress}>{shortAddr(donation.fromAddress)}</span>
          )}
        </td>
        <td className="py-2 px-3 font-mono text-xs text-right">
          <span className="font-black">{donation.amountNorm}</span>
          {' '}
          <span className="text-neutral-500 uppercase">{donation.tokenSymbol}</span>
        </td>
        <td className="py-2 px-3">
          <ChainBadge slug={donation.chainSlug} />
        </td>
        <td className="py-2 px-3 text-xs text-neutral-500">
          {relativeTime(donation.blockTimestamp)}
        </td>
        <td className="py-2 px-3 text-xs">
          {txUrl ? (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-neutral-500 hover:text-black underline underline-offset-2"
            >
              tx
            </a>
          ) : null}
        </td>
      </tr>

      {/* Mobile card — shown only on mobile */}
      <tr className="sm:hidden border-b border-neutral-200">
        <td colSpan={5} className="py-3 px-2">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-neutral-700">
                {addrUrl ? (
                  <a
                    href={addrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-black underline underline-offset-2"
                  >
                    {shortAddr(donation.fromAddress)}
                  </a>
                ) : (
                  shortAddr(donation.fromAddress)
                )}
              </span>
              <ChainBadge slug={donation.chainSlug} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-black">
                {donation.amountNorm}{' '}
                <span className="font-normal text-neutral-500 text-xs uppercase">
                  {donation.tokenSymbol}
                </span>
              </span>
              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <span>{relativeTime(donation.blockTimestamp)}</span>
                {txUrl && (
                  <a
                    href={txUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono hover:text-black underline underline-offset-2"
                  >
                    tx
                  </a>
                )}
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DonationsTimeline({
  donations,
  isLoading,
  isError,
  hasMore,
  onLoadMore,
  isFetchingMore,
}: DonationsTimelineProps) {
  if (isLoading) {
    return (
      <div className="text-xs uppercase tracking-widest text-neutral-400 py-8 text-center">
        loading donations...
      </div>
    )
  }

  if (isError) {
    return (
      <div className="text-xs uppercase tracking-widest text-neutral-400 py-8 text-center">
        donations unavailable
      </div>
    )
  }

  if (donations.length === 0) {
    return (
      <div className="text-xs uppercase tracking-widest text-neutral-400 py-8 text-center">
        no donations yet
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-black hidden sm:table-row">
              <th className="py-2 px-3 text-left text-xs uppercase tracking-widest font-black">
                donor
              </th>
              <th className="py-2 px-3 text-right text-xs uppercase tracking-widest font-black">
                amount
              </th>
              <th className="py-2 px-3 text-left text-xs uppercase tracking-widest font-black">
                chain
              </th>
              <th className="py-2 px-3 text-left text-xs uppercase tracking-widest font-black">
                when
              </th>
              <th className="py-2 px-3 text-left text-xs uppercase tracking-widest font-black">
                tx
              </th>
            </tr>
          </thead>
          <tbody>
            {donations.map((d) => (
              <DonationRow key={d.id} donation={d} />
            ))}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={onLoadMore}
            disabled={isFetchingMore}
            className="border-2 border-black px-4 py-1.5 text-xs font-black uppercase tracking-widest hover:bg-black hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isFetchingMore ? 'loading...' : 'load more'}
          </button>
        </div>
      )}
    </div>
  )
}
