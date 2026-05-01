import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchProposerLeaderboard,
  fetchContributors,
  type ProposerEntry,
  type ProposerOrderBy,
  type ChainContributors,
} from '../lib/queries'
import { liveIndexedChains } from '../lib/chains'
import { AddressLabel } from '../components/AddressLabel'
import { EmptyState } from '../components/EmptyState'
import { lookupContributorGlobal } from '../lib/contributors'
import { relativeTime } from '../lib/format'

/**
 * Default chain for the leaderboard's explorer links. Posters are the
 * same EOA on every chain (CREATE2 deterministic deploy), so any chain's
 * explorer resolves the address; we pick `base` because it's the
 * primary live deployment.
 */
const LEADERBOARD_EXPLORER_CHAIN = 'base'

/**
 * Whitelist status for an address, aggregated across every live-indexed
 * chain. The leaderboard treats addresses as global identities (CREATE2
 * deterministic deploy → same EOA everywhere), so we collapse multi-chain
 * whitelist history into one record per address.
 */
interface WhitelistStatus {
  /** Earliest `firstWhitelistedAt` across any chain — when this address
   *  first joined thatsRekt, anywhere. */
  readonly joinedAt: string | null
  /** True if the address is currently whitelisted on at least one chain. */
  readonly isActive: boolean
}

type StatusFilter = 'all' | 'active' | 'inactive'

/**
 * Global ranking of every whitelisted poster, aggregated by Mesh across
 * all chains they've posted on. Counters are lifetime — retracted posts
 * keep their score.
 */
export function Leaderboard() {
  const [orderBy, setOrderBy] = useState<ProposerOrderBy>('totalConfirmations')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const { data: leaderboardData, isLoading, error } = useQuery({
    queryKey: ['proposer-leaderboard', orderBy],
    queryFn: () => fetchProposerLeaderboard({ orderBy, limit: 100 }),
  })

  // Whitelist status per address — fans out to every live-indexed chain
  // and aggregates. Cached separately so the table can re-sort without
  // refetching the whitelist data.
  const liveChains = liveIndexedChains()
  const liveSlugs = liveChains.map((c) => c.slug)
  const { data: whitelistData } = useQuery({
    queryKey: ['contributors', 'v2', liveSlugs.join(',')],
    queryFn: () => fetchContributors(liveSlugs),
  })

  const statusByAddress = useMemo(
    () => buildStatusMap(whitelistData ?? []),
    [whitelistData],
  )

  const filteredRows = useMemo(() => {
    if (!leaderboardData) return []
    if (statusFilter === 'all') return leaderboardData.items
    return leaderboardData.items.filter((row) => {
      const status = statusByAddress.get(row.poster.toLowerCase())
      const isActive = status?.isActive ?? false
      return statusFilter === 'active' ? isActive : !isActive
    })
  }, [leaderboardData, statusByAddress, statusFilter])

  return (
    <article className="space-y-10">
      <header className="space-y-3 border-b-2 border-black pb-6">
        <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
          leaderboard
        </h1>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [guardian activity · global · across all chains]
        </p>
        <p className="text-base leading-relaxed text-neutral-800 max-w-2xl">
          Lifetime confirmation activity per whitelisted guardian, summed
          across every chain they've reported on. Counters are{' '}
          <strong className="font-black">lifetime</strong> — retracted
          attacks keep their score, removed guardians keep their history.
        </p>
      </header>

      <StatusFilterBar value={statusFilter} onChange={setStatusFilter} />

      {isLoading ? (
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          loading leaderboard…
        </p>
      ) : error ? (
        <EmptyState
          title="couldn't load leaderboard."
          hint={(error as Error).message}
        />
      ) : !leaderboardData || leaderboardData.items.length === 0 ? (
        <EmptyState
          title="no guardians yet."
          hint="no address has been whitelisted on any indexed chain."
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title={`no ${statusFilter} guardians.`}
          hint={
            statusFilter === 'active'
              ? "every guardian on the leaderboard has been removed from the whitelist."
              : "every guardian on the leaderboard is currently active."
          }
        />
      ) : (
        <ProposerTable
          rows={filteredRows}
          orderBy={orderBy}
          onSelectOrderBy={setOrderBy}
          statusByAddress={statusByAddress}
        />
      )}
    </article>
  )
}

/**
 * Walk every chain's whitelister list and collapse into a per-address
 * status. `firstWhitelistedAt` takes the earliest across chains; `isActive`
 * is OR-ed (active on any chain ⇒ active globally).
 */
function buildStatusMap(
  groups: readonly ChainContributors[],
): Map<string, WhitelistStatus> {
  const m = new Map<string, WhitelistStatus>()
  for (const group of groups) {
    const apply = (addr: string, joinedAt: string | null, isActiveHere: boolean) => {
      const lc = addr.toLowerCase()
      const existing = m.get(lc)
      const earliestJoined =
        !existing || existing.joinedAt === null
          ? joinedAt
          : joinedAt === null
            ? existing.joinedAt
            : existing.joinedAt < joinedAt
              ? existing.joinedAt
              : joinedAt
      const anyActive = (existing?.isActive ?? false) || isActiveHere
      m.set(lc, { joinedAt: earliestJoined, isActive: anyActive })
    }
    for (const c of group.active) apply(c.address, c.firstWhitelistedAt, true)
    for (const c of group.past) apply(c.address, c.firstWhitelistedAt, false)
  }
  return m
}

function StatusFilterBar({
  value,
  onChange,
}: {
  value: StatusFilter
  onChange: (next: StatusFilter) => void
}) {
  const options: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: 'all' },
    { value: 'active', label: 'active' },
    { value: 'inactive', label: 'inactive' },
  ]
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[10px] uppercase tracking-widest text-neutral-700">
        status:
      </span>
      <div className="flex gap-1">
        {options.map((opt) => {
          const active = value === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={
                'px-2 py-0.5 text-xs uppercase tracking-widest border ' +
                (active
                  ? 'border-black bg-black text-[#f5f4ee]'
                  : 'border-transparent text-neutral-700 hover:border-black hover:text-black')
              }
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ProposerTable({
  rows,
  orderBy,
  onSelectOrderBy,
  statusByAddress,
}: {
  rows: ProposerEntry[]
  orderBy: ProposerOrderBy
  onSelectOrderBy: (next: ProposerOrderBy) => void
  statusByAddress: Map<string, WhitelistStatus>
}) {
  return (
    <div className="border-2 border-black overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b-2 border-black bg-black/5 text-xs uppercase tracking-widest">
          <tr>
            <th className="px-2 sm:px-3 py-2 w-10 text-right text-neutral-700">#</th>
            <th className="px-2 sm:px-3 py-2">guardian</th>
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
              label="attacks"
              column="postCount"
              orderBy={orderBy}
              onSelect={onSelectOrderBy}
            />
          </tr>
        </thead>
        <tbody className="divide-y divide-black">
          {rows.map((row, i) => {
            const status = statusByAddress.get(row.poster.toLowerCase())
            const isInactive = status && !status.isActive
            return (
              <tr
                key={row.poster}
                className={`hover:bg-black/5 align-top ${isInactive ? 'opacity-70' : ''}`}
              >
                <td className="px-2 sm:px-3 py-2 text-right text-neutral-700 font-mono tabular-nums">
                  {i + 1}
                </td>
                <td className="px-2 sm:px-3 py-2">
                  <PosterCell address={row.poster} status={status} />
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
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Poster cell — address is the primary visual element. Below it, a
 * single tight metadata line with just the essentials: status chip,
 * optional name tag, and "joined X ago".
 *
 * Tagline and social links (x / gh / site) deliberately omitted from
 * this view — the leaderboard is a ranking table, not a poster bio,
 * and the metadata line was widening the column past the address.
 * For full poster bios see /posters.
 */
function PosterCell({
  address,
  status,
}: {
  address: string
  status: WhitelistStatus | undefined
}) {
  const label = lookupContributorGlobal(address)
  const isActive = status?.isActive ?? false
  const hasMetadata = Boolean(status || label?.name)

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <AddressLabel
        addr={address}
        chainSlug={LEADERBOARD_EXPLORER_CHAIN}
        full
      />
      {hasMetadata && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-neutral-600">
          {status && <StatusChip isActive={isActive} />}
          {label?.name && (
            // Casual inline annotation — mixed-case, lighter weight.
            // Reserves uppercase / tracking-widest for section headings.
            <span className="text-neutral-700">{label.name}</span>
          )}
          {status?.joinedAt && (
            <Sep>joined {relativeTime(status.joinedAt)}</Sep>
          )}
        </div>
      )}
    </div>
  )
}

/** Tiny dot separator before a metadata fragment. */
function Sep({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="text-neutral-400" aria-hidden>·</span>
      <span>{children}</span>
    </span>
  )
}

function StatusChip({ isActive }: { isActive: boolean }) {
  return (
    <span
      className={
        'inline-block px-1.5 py-0 text-[10px] font-mono font-black uppercase tracking-widest border ' +
        (isActive
          ? 'border-emerald-700 text-emerald-700'
          : 'border-neutral-500 text-neutral-600')
      }
    >
      {isActive ? 'active' : 'inactive'}
    </span>
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
        className={`uppercase tracking-widest text-xs whitespace-nowrap inline-flex items-center gap-1 ${
          isActive ? 'font-black text-black' : 'text-neutral-700 hover:text-black'
        }`}
      >
        <span>{label}</span>
        <span
          aria-hidden
          className={isActive ? 'text-black' : 'text-neutral-400'}
        >
          {isActive ? '↓' : '↕'}
        </span>
      </button>
    </th>
  )
}
