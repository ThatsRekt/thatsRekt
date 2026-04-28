import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchPostDetail } from '../lib/queries'
import { AddressLabel } from '../components/AddressLabel'
import { ChainBadge } from '../components/ChainBadge'
import { Timeline } from '../components/Timeline'
import { EmptyState } from '../components/EmptyState'
import { formatTimestamp, relativeTime } from '../lib/format'

// Extract chain slug from a composite post id (`{slug}-{onchainId}`).
// Returns undefined for legacy bare ids.
function chainSlugFromId(id: string): string | undefined {
  const knownSlugs = ['anvil-eth', 'anvil-base', 'sepolia', 'base'].sort(
    (a, b) => b.length - a.length,
  )
  for (const s of knownSlugs) {
    if (id.startsWith(`${s}-`)) return s
  }
  return undefined
}

export function PostDetail() {
  const { id } = useParams<{ id: string }>()
  const postId = id ?? ''

  const { data, isLoading, error } = useQuery({
    queryKey: ['post', postId],
    queryFn: () => fetchPostDetail(postId),
    enabled: postId.length > 0,
  })

  if (isLoading) {
    return (
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        loading post #{postId}…
      </p>
    )
  }

  if (error) {
    return (
      <EmptyState
        title="couldn't load this post."
        hint={(error as Error).message}
      />
    )
  }

  if (!data) {
    return (
      <EmptyState
        title={`post #${postId} not found.`}
        hint="the id may be wrong, or the post hasn't been indexed yet."
      />
    )
  }

  const chainSlug = chainSlugFromId(data.id)

  return (
    <article className="space-y-10">
      <Link
        to="/"
        className="inline-block text-xs uppercase tracking-widest rekt-link"
      >
        ← back to feed
      </Link>

      <header className="space-y-4 border-b-2 border-black pb-6">
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest">
          <span className="font-black">#{data.id}</span>
          {chainSlug && <ChainBadge slug={chainSlug} variant="full" />}
          <span className="text-neutral-700">·</span>
          {data.removed ? (
            <span className="border border-red-600 px-2 py-0.5 font-black text-red-600">
              retracted
            </span>
          ) : (
            <span className="border border-emerald-700 px-2 py-0.5 font-black text-emerald-700">
              active
            </span>
          )}
          <span className="text-neutral-700">·</span>
          <span title={formatTimestamp(data.attackedAt)}>
            attacked {relativeTime(data.attackedAt)}
          </span>
          <span className="ml-auto">
            <ScoreLine net={data.netScore} up={data.confirmations} down={data.disconfirmations} />
          </span>
        </div>

        <h1 className="font-black tracking-tight text-3xl sm:text-4xl leading-tight text-neutral-900 whitespace-pre-wrap break-words">
          {data.title?.trim() || '(untitled)'}
        </h1>

        <dl className="grid grid-cols-1 gap-1 text-xs uppercase tracking-widest text-neutral-700 sm:grid-cols-2">
          <Field label="poster">
            <AddressLabel addr={data.poster.id} chainSlug={chainSlug} />
          </Field>
          <Field label="posted on-chain" tooltip={formatTimestamp(data.createdAtTimestamp)}>
            {relativeTime(data.createdAtTimestamp)}
          </Field>
          <Field label="last updated" tooltip={formatTimestamp(data.lastUpdatedAt)}>
            {relativeTime(data.lastUpdatedAt)}
          </Field>
          {data.removed && data.removedAtTimestamp && (
            <Field label="retracted" tooltip={formatTimestamp(data.removedAtTimestamp)}>
              {relativeTime(data.removedAtTimestamp)}
            </Field>
          )}
        </dl>
      </header>

      {data.note?.trim() && (
        <section>
          <SectionLabel>note</SectionLabel>
          <p className="mt-3 text-base leading-relaxed text-neutral-800 whitespace-pre-wrap break-words">
            {data.note}
          </p>
        </section>
      )}

      <section>
        <SectionLabel>
          attackers <span className="text-neutral-700">[{data.attackerLinks.length}]</span>
        </SectionLabel>
        {data.attackerLinks.length === 0 ? (
          <p className="mt-2 text-xs uppercase tracking-widest text-neutral-700">
            none listed.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-black border-y-2 border-black">
            {data.attackerLinks.map((link) => (
              <li
                key={link.address.id}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <AddressLabel addr={link.address.id} chainSlug={chainSlug} full />
                <div className="flex gap-3 text-xs uppercase tracking-widest">
                  <span className={scoreTextColor(Number(link.address.attackerScore))}>
                    score {link.address.attackerScore}
                  </span>
                  {link.address.attackerAppearances != null && (
                    <span className="text-neutral-700">
                      [{link.address.attackerAppearances} post(s)]
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionLabel>
          victims <span className="text-neutral-700">[{data.victimLinks.length}]</span>
        </SectionLabel>
        {data.victimLinks.length === 0 ? (
          <p className="mt-2 text-xs uppercase tracking-widest text-neutral-700">
            none listed.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-black border-y-2 border-black">
            {data.victimLinks.map((link) => (
              <li
                key={link.address.id}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <AddressLabel addr={link.address.id} chainSlug={chainSlug} full />
                <span className="text-xs uppercase tracking-widest text-neutral-700">
                  [{link.address.isVictim ? 'flagged' : 'cleared'}]
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionLabel>timeline</SectionLabel>
        <div className="mt-3">
          <Timeline post={data} log={data.confirmationLog} edits={data.edits} chainSlug={chainSlug} />
        </div>
      </section>
    </article>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-black uppercase tracking-widest text-sm">{children}</h2>
  )
}

function ScoreLine({ net, up, down }: { net: number; up: number; down: number }) {
  return (
    <span className="font-mono">
      <span className={`font-black ${scoreTextColor(net)}`}>
        {net >= 0 ? `+${net}` : net}
      </span>{' '}
      <span className="text-neutral-700">({up}↑/{down}↓)</span>
    </span>
  )
}

function scoreTextColor(score: number): string {
  if (score > 0) return 'text-emerald-700'
  if (score < 0) return 'text-red-600'
  return 'text-neutral-700'
}

function Field({
  label,
  children,
  tooltip,
}: {
  label: string
  children: React.ReactNode
  tooltip?: string
}) {
  return (
    <div className="flex gap-2" title={tooltip}>
      <dt className="w-32 shrink-0">[{label}]</dt>
      <dd className="text-black normal-case tracking-normal">{children}</dd>
    </div>
  )
}

