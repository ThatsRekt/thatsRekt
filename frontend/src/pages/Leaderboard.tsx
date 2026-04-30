import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchProposerLeaderboard,
  type ProposerEntry,
  type ProposerOrderBy,
} from '../lib/queries'
import { AddressLabel } from '../components/AddressLabel'
import { EmptyState } from '../components/EmptyState'

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
      <table className="w-full text-left text-sm table-fixed">
        <colgroup>
          <col className="w-10 sm:w-12" />
          <col />
          <col className="w-20 sm:w-24" />
          <col className="w-24 sm:w-28" />
          <col className="w-16 sm:w-20" />
        </colgroup>
        <thead className="border-b-2 border-black bg-black/5 text-xs uppercase tracking-widest">
          <tr>
            <th className="px-2 sm:px-3 py-2 text-right text-neutral-700">#</th>
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
            <tr key={row.poster} className="hover:bg-black/5">
              <td className="px-2 sm:px-3 py-2 text-right text-neutral-700 font-mono tabular-nums">
                {i + 1}
              </td>
              <td className="px-2 sm:px-3 py-2">
                {/* Truncated address — leaderboard is global, so no
                    chainSlug, and full 42-char strings are too wide
                    to coexist with the numeric columns. The
                    AddressLabel still renders a copy button for
                    clipboard access. */}
                <AddressLabel addr={row.poster} />
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
