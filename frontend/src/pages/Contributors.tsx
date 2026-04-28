import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchContributors,
  fetchProposerLeaderboard,
  type ChainContributors,
  type Contributor,
  type ProposerEntry,
  type ProposerOrderBy,
} from '../lib/queries'
import { visibleChains, getChainBySlug } from '../lib/chains'
import { lookupContributor } from '../lib/contributors'
import { AddressLabel } from '../components/AddressLabel'
import { ChainBadge } from '../components/ChainBadge'
import { EmptyState } from '../components/EmptyState'
import { relativeTime } from '../lib/format'

export function Contributors() {
  const chains = visibleChains()
  const slugs = chains.map((c) => c.slug)

  const { data, isLoading, error } = useQuery({
    // v2 — response shape changed (active/past split). Bumping the
    // version is the cheapest way to invalidate any cached payloads
    // from the prior single-bucket shape.
    queryKey: ['contributors', 'v2', slugs.join(',')],
    queryFn: () => fetchContributors(slugs),
  })

  // Selected tab — defaults to the first chain that has any
  // contributors (active or past); falls back to the first chain
  // in the registry if all are empty.
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  if (isLoading) {
    return (
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        loading contributors…
      </p>
    )
  }

  if (error) {
    return (
      <EmptyState
        title="couldn't load contributors."
        hint={`is the indexer running? ${(error as Error).message}`}
      />
    )
  }

  const groups = data ?? []
  const allEmpty = groups.every((g) => g.active.length === 0 && g.past.length === 0)

  // Pick the active tab. User selection wins. Otherwise, first chain
  // with content. Otherwise, first chain in the registry.
  const activeSlug =
    selectedSlug ??
    groups.find((g) => g.active.length + g.past.length > 0)?.chainSlug ??
    chains[0]?.slug ??
    null

  const activeGroup = groups.find((g) => g.chainSlug === activeSlug)

  return (
    <article className="space-y-10">
      <header className="space-y-3 border-b-2 border-black pb-6">
        <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
          contributors
        </h1>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [whitelisted addresses · per chain]
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          These are the addresses authorized to <strong className="font-black">post hack alerts</strong>{' '}
          and confirm posts on the registry, per chain. They are added and removed
          by the governance multisig through the 7-day timelock — the
          on-chain whitelist is the source of truth, the names below are
          a courtesy lookup.
        </p>
      </header>

      <Maintainers />

      <ProposerLeaderboard />

      {allEmpty ? (
        <EmptyState
          title="no contributors yet."
          hint="no whitelister has been added on any indexed chain."
        />
      ) : (
        <>
          <ChainTabs
            chains={chains}
            groups={groups}
            activeSlug={activeSlug}
            onSelect={setSelectedSlug}
          />
          {activeGroup ? (
            <ChainSection group={activeGroup} />
          ) : (
            <p className="text-xs uppercase tracking-widest text-neutral-700">
              no chain selected.
            </p>
          )}
        </>
      )}
    </article>
  )
}

function ChainTabs({
  chains,
  groups,
  activeSlug,
  onSelect,
}: {
  chains: readonly ReturnType<typeof visibleChains>[number][]
  groups: ChainContributors[]
  activeSlug: string | null
  onSelect: (slug: string) => void
}) {
  const counts = new Map(
    groups.map((g) => [g.chainSlug, { active: g.active.length, past: g.past.length }]),
  )
  return (
    <nav className="flex flex-wrap gap-2 border-b-2 border-black pb-2 -mb-2">
      {chains.map((c) => {
        const count = counts.get(c.slug) ?? { active: 0, past: 0 }
        const total = count.active + count.past
        const isActive = c.slug === activeSlug
        return (
          <button
            key={c.slug}
            type="button"
            onClick={() => onSelect(c.slug)}
            className={
              'inline-flex items-center gap-2 px-3 py-1.5 border-2 text-xs uppercase tracking-widest font-mono touch-manipulation transition-colors ' +
              (isActive
                ? 'border-black bg-black text-[#f5f4ee]'
                : 'border-neutral-300 text-neutral-700 hover:border-black hover:text-black')
            }
          >
            <span className="font-black">{c.badge}</span>
            {c.isLocalFork && (
              <span className={isActive ? 'opacity-70' : 'opacity-60'}>· local</span>
            )}
            <span
              className={
                'inline-flex items-center justify-center min-w-[1.25rem] px-1 text-[10px] font-black ' +
                (isActive
                  ? 'bg-[#f5f4ee] text-black'
                  : total === 0
                    ? 'text-neutral-400'
                    : 'bg-neutral-200 text-black')
              }
            >
              {total}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

function Maintainers() {
  return (
    <section className="space-y-3 border-2 border-black bg-yellow-50 p-5">
      <h2 className="font-black uppercase tracking-widest text-xs">
        maintainers
      </h2>
      <p className="text-sm leading-relaxed text-neutral-800">
        thatsRekt is maintained by{' '}
        <Maintainer
          name="jerrythekid"
          twitter="jerrythekid"
          github="JeronimoHoulin"
          ens="jerrythekid.eth"
        />{' '}
        and{' '}
        <Maintainer
          name="bauti.eth"
          twitter="BautiDeFi"
          github="bauti-defi"
          ens="bauti.eth"
        />.
      </p>
    </section>
  )
}

function Maintainer({
  name,
  twitter,
  github,
  ens,
}: {
  name: string
  twitter?: string
  github?: string
  ens?: string
}) {
  const links: { label: string; href: string }[] = []
  if (twitter) links.push({ label: 'x', href: twitterUrl(twitter) })
  if (github) links.push({ label: 'gh', href: `https://github.com/${github}` })
  if (ens) links.push({ label: 'ens', href: `https://app.ens.domains/${ens}` })

  return (
    <span className="inline-flex items-baseline gap-1 font-black">
      {name}
      <span className="font-normal text-neutral-500">[</span>
      {links.map((l, i) => (
        <span key={l.label} className="inline-flex items-baseline gap-1">
          {i > 0 && <span className="font-normal text-neutral-500">·</span>}
          <a
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs uppercase tracking-widest rekt-link"
          >
            {l.label}
          </a>
        </span>
      ))}
      <span className="font-normal text-neutral-500">]</span>
    </span>
  )
}

function twitterUrl(handleOrUrl: string): string {
  if (handleOrUrl.startsWith('http://') || handleOrUrl.startsWith('https://')) {
    return handleOrUrl
  }
  const cleaned = handleOrUrl.replace(/^@/, '')
  return `https://x.com/${cleaned}`
}

function ChainSection({ group }: { group: ChainContributors }) {
  const chain = getChainBySlug(group.chainSlug)
  const heading = chain?.name ?? group.chainSlug
  const empty = group.active.length === 0 && group.past.length === 0

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ChainBadge slug={group.chainSlug} />
        <h2 className="font-black uppercase tracking-tight text-lg">{heading}</h2>
        {!empty && (
          <span className="text-xs uppercase tracking-widest text-neutral-700">
            [{group.active.length} active{group.past.length > 0 && ` · ${group.past.length} past`}]
          </span>
        )}
      </div>

      {empty ? (
        <p className="text-xs uppercase tracking-widest text-neutral-700 pl-1">
          no whitelisters on this chain yet.
        </p>
      ) : (
        <>
          <ContributorList
            chainSlug={group.chainSlug}
            label="active"
            kind="active"
            entries={group.active}
            emptyHint="no active contributors yet."
          />
          {group.past.length > 0 && (
            <ContributorList
              chainSlug={group.chainSlug}
              label="past"
              kind="past"
              entries={group.past}
              emptyHint="no past contributors."
            />
          )}
        </>
      )}
    </section>
  )
}

function ContributorList({
  chainSlug,
  label,
  kind,
  entries,
  emptyHint,
}: {
  chainSlug: string
  label: string
  kind: 'active' | 'past'
  entries: Contributor[]
  emptyHint: string
}) {
  const labelStyle =
    kind === 'active'
      ? 'border-emerald-700 text-emerald-700'
      : 'border-neutral-500 text-neutral-600'
  return (
    <div className="space-y-2">
      <p
        className={`inline-block border px-2 py-0.5 text-[10px] font-mono font-black uppercase tracking-widest ${labelStyle}`}
      >
        {label}
      </p>
      {entries.length === 0 ? (
        <p className="text-xs uppercase tracking-widest text-neutral-700 pl-1">
          {emptyHint}
        </p>
      ) : (
        <ul className="divide-y divide-black border-y-2 border-black">
          {entries.map((entry) => (
            <ContributorRow
              key={entry.address}
              chainSlug={chainSlug}
              entry={entry}
              kind={kind}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ContributorRow({
  chainSlug,
  entry,
  kind,
}: {
  chainSlug: string
  entry: Contributor
  kind: 'active' | 'past'
}) {
  const label = lookupContributor(chainSlug, entry.address)
  const isPast = kind === 'past'
  return (
    <li
      className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-3 ${isPast ? 'opacity-70' : ''}`}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        {label ? (
          <>
            <span
              className={`font-black uppercase tracking-tight text-base ${isPast ? 'line-through decoration-1' : ''}`}
            >
              {label.name}
            </span>
            {label.tagline && (
              <span className="text-xs text-neutral-700">{label.tagline}</span>
            )}
          </>
        ) : (
          <span className="text-xs uppercase tracking-widest text-neutral-700">
            [unlabelled]
          </span>
        )}
        <span className="text-[10px] uppercase tracking-widest text-neutral-500">
          {isPast
            ? `removed ${entry.lastChangedAt ? relativeTime(entry.lastChangedAt) : '—'}`
            : entry.firstWhitelistedAt
              ? `whitelisted ${relativeTime(entry.firstWhitelistedAt)}`
              : ''}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AddressLabel addr={entry.address} chainSlug={chainSlug} full />
        {label?.twitter && (
          <a
            href={twitterUrl(label.twitter)}
            target="_blank"
            rel="noopener noreferrer"
            title="X (twitter)"
            aria-label="X (twitter)"
            className="text-xs uppercase tracking-widest rekt-link"
          >
            x ↗
          </a>
        )}
        {label?.github && (
          <a
            href={`https://github.com/${label.github}`}
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
            aria-label="GitHub"
            className="text-xs uppercase tracking-widest rekt-link"
          >
            gh ↗
          </a>
        )}
        {label?.url && (
          <a
            href={label.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs uppercase tracking-widest rekt-link"
          >
            site ↗
          </a>
        )}
      </div>
    </li>
  )
}

// =============================================================================
// Proposer leaderboard
// =============================================================================
// Global ranking of every whitelisted address by lifetime confirmation
// activity. Aggregated across all chains by Mesh; rendered here as a
// sortable table.
function ProposerLeaderboard() {
  const [orderBy, setOrderBy] = useState<ProposerOrderBy>('totalConfirmations')

  const { data, isLoading, error } = useQuery({
    queryKey: ['proposer-leaderboard', orderBy],
    queryFn: () => fetchProposerLeaderboard({ orderBy, limit: 100 }),
  })

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
          leaderboard
        </h2>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [global · across all chains]
        </p>
      </header>
      <p className="text-sm text-neutral-700 max-w-2xl">
        Global ranking of every whitelisted poster, aggregated across every
        chain they've posted on. Counters are lifetime — retracted posts
        keep their score.
      </p>

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
    </section>
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
    <div className="overflow-x-auto border-2 border-black">
      <table className="w-full text-left text-sm">
        <thead className="border-b-2 border-black bg-black/5 text-xs uppercase tracking-widest">
          <tr>
            <th className="px-3 py-2 w-12 text-right text-neutral-700">#</th>
            <th className="px-3 py-2">poster</th>
            <SortableHeader
              label="confirmations"
              column="totalConfirmations"
              orderBy={orderBy}
              onSelect={onSelectOrderBy}
            />
            <SortableHeader
              label="disconfirmations"
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
              <td className="px-3 py-2 text-right text-neutral-700 font-mono tabular-nums">
                {i + 1}
              </td>
              <td className="px-3 py-2">
                <AddressLabel addr={row.poster} full />
              </td>
              <td className="px-3 py-2 font-mono tabular-nums text-emerald-700">
                {row.totalConfirmations.toString()}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums text-red-600">
                {row.totalDisconfirmations.toString()}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums">
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
    <th className="px-3 py-2">
      <button
        type="button"
        onClick={() => onSelect(column)}
        className={`uppercase tracking-widest text-xs ${
          isActive ? 'font-black text-black' : 'text-neutral-700 hover:text-black'
        }`}
      >
        {label}
        {isActive ? ' ↓' : ''}
      </button>
    </th>
  )
}
