import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchProposerLeaderboard,
  type ProposerEntry,
  type ProposerOrderBy,
} from '../lib/queries'
import { AddressLabel } from '../components/AddressLabel'
import { EmptyState } from '../components/EmptyState'
import { lookupContributorGlobal } from '../lib/contributors'
import { twitterUrl } from '../lib/format'

/**
 * Default chain for the leaderboard's explorer links. Posters are the
 * same EOA on every chain (CREATE2 deterministic deploy), so any chain's
 * explorer resolves the address; we pick `base` because it's the
 * primary live deployment.
 */
const LEADERBOARD_EXPLORER_CHAIN = 'base'

/**
 * Global ranking of every whitelisted poster, aggregated by Mesh across
 * all chains they've posted on. Counters are lifetime — retracted posts
 * keep their score.
 *
 * Previously embedded inside the Contributors page; lifted into its own
 * route on `/leaderboard` so it's discoverable from the top-level nav.
 */
export function Leaderboard() {
  const [orderBy, setOrderBy] = useState<ProposerOrderBy>('totalConfirmations')

  const { data, isLoading, error } = useQuery({
    queryKey: ['proposer-leaderboard', orderBy],
    queryFn: () => fetchProposerLeaderboard({ orderBy, limit: 100 }),
  })

  return (
    <article className="space-y-10">
      <header className="space-y-3 border-b-2 border-black pb-6">
        <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
          leaderboard
        </h1>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [proposer activity · global · across all chains]
        </p>
        <p className="text-base leading-relaxed text-neutral-800 max-w-2xl">
          Lifetime confirmation activity per whitelisted poster, summed
          across every chain they've posted on. Counters are{' '}
          <strong className="font-black">lifetime</strong> — retracted
          posts keep their score, removed whitelisters keep their history.
        </p>
      </header>

      {isLoading ? (
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          loading leaderboard…
        </p>
      ) : error ? (
        <EmptyState
          title="couldn't load leaderboard."
          hint={(error as Error).message}
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title="no proposers yet."
          hint="no address has been whitelisted on any indexed chain."
        />
      ) : (
        <ProposerTable
          rows={data.items}
          orderBy={orderBy}
          onSelectOrderBy={setOrderBy}
        />
      )}
    </article>
  )
}

function ProposerTable({
  rows,
  orderBy,
  onSelectOrderBy,
}: {
  rows: ProposerEntry[]
  orderBy: ProposerOrderBy
  onSelectOrderBy: (next: ProposerOrderBy) => void
}) {
  return (
    <div className="border-2 border-black overflow-x-auto">
      {/*
        table-fixed + colgroup gives deterministic column widths so
        long addresses can't blow out the layout. The poster column
        is the only flex one — numeric columns are tight + right-
        aligned for visual scanning.
      */}
      <table className="w-full text-left text-sm">
        {/*
          No `table-fixed` here — letting the browser size the poster
          column to its content (the full address) means the column
          gets exactly the room it needs. The numeric columns get
          `w-` hints below; the table wrapper has `overflow-x-auto`
          so on narrow viewports the user can scroll horizontally
          rather than have the address truncated.
        */}
        <thead className="border-b-2 border-black bg-black/5 text-xs uppercase tracking-widest">
          <tr>
            <th className="px-2 sm:px-3 py-2 w-10 text-right text-neutral-700">#</th>
            <th className="px-2 sm:px-3 py-2">poster</th>
            <SortableHeader
              label="confirms"
              column="totalConfirmations"
              orderBy={orderBy}
              onSelect={onSelectOrderBy}
            />
            <SortableHeader
              label="disconfirms"
              column="totalDisconfirmations"
              orderBy={orderBy}
              onSelect={onSelectOrderBy}
            />
            <SortableHeader
              label="posts"
              column="postCount"
              orderBy={orderBy}
              onSelect={onSelectOrderBy}
            />
          </tr>
        </thead>
        <tbody className="divide-y divide-black">
          {rows.map((row, i) => (
            <tr key={row.poster} className="hover:bg-black/5 align-top">
              <td className="px-2 sm:px-3 py-2 text-right text-neutral-700 font-mono tabular-nums">
                {i + 1}
              </td>
              <td className="px-2 sm:px-3 py-2">
                <PosterCell address={row.poster} />
              </td>
              <td className="px-2 sm:px-3 py-2 text-right font-mono tabular-nums text-emerald-700">
                {row.totalConfirmations.toString()}
              </td>
              <td className="px-2 sm:px-3 py-2 text-right font-mono tabular-nums text-red-600">
                {row.totalDisconfirmations.toString()}
              </td>
              <td className="px-2 sm:px-3 py-2 text-right font-mono tabular-nums">
                {row.postCount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Poster cell content: name tag (when registered in `lib/contributors.ts`)
 * stacked above the full address with explorer + copy affordances.
 *
 * Most addresses won't have a label yet, in which case we show only
 * the full address — keeps unlabeled rows compact while still letting
 * known posters surface a recognizable name.
 */
function PosterCell({ address }: { address: string }) {
  const label = lookupContributorGlobal(address)
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      {label && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-black uppercase tracking-tight text-base">
            {label.name}
          </span>
          {label.tagline && (
            <span className="text-[10px] uppercase tracking-widest text-neutral-700">
              {label.tagline}
            </span>
          )}
          {label.twitter && (
            <a
              href={twitterUrl(label.twitter)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] uppercase tracking-widest rekt-link"
            >
              x ↗
            </a>
          )}
          {label.github && (
            <a
              href={`https://github.com/${label.github}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] uppercase tracking-widest rekt-link"
            >
              gh ↗
            </a>
          )}
          {label.url && (
            <a
              href={label.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] uppercase tracking-widest rekt-link"
            >
              site ↗
            </a>
          )}
        </div>
      )}
      <AddressLabel
        addr={address}
        chainSlug={LEADERBOARD_EXPLORER_CHAIN}
        full
      />
    </div>
  )
}

function SortableHeader({
  label,
  column,
  orderBy,
  onSelect,
}: {
  label: string
  column: ProposerOrderBy
  orderBy: ProposerOrderBy
  onSelect: (next: ProposerOrderBy) => void
}) {
  const isActive = orderBy === column
  return (
    <th className="px-2 sm:px-3 py-2 text-right">
      <button
        type="button"
        onClick={() => onSelect(column)}
        className={`uppercase tracking-widest text-xs whitespace-nowrap ${
          isActive ? 'font-black text-black' : 'text-neutral-700 hover:text-black'
        }`}
      >
        {label}
        {isActive ? ' ↓' : ''}
      </button>
    </th>
  )
}
