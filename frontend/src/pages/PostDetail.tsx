import { useParams } from 'react-router-dom'
import { BackLink } from '../components/BackLink'
import { useQuery } from '@tanstack/react-query'
import { chainSlugFromCompositeId, fetchPostDetail } from '../lib/queries'
import { fetchCommentCount } from '../lib/comments'
import { archiveSlugFromUrlId } from '../lib/archive'
import { AddressLabel } from '../components/AddressLabel'
import { ArchiveDetail } from '../components/ArchiveDetail'
import { ChainBadge } from '../components/ChainBadge'
import { CommentThread } from '../components/CommentThread'
import { Markdown } from '../components/Markdown'
import { ShareButton } from '../components/ShareButton'
import { ConfirmVoteButtons } from '../components/ConfirmVoteButtons'
import { Timeline } from '../components/Timeline'
import { EmptyState } from '../components/EmptyState'
import { chainIdFromSlug } from '../lib/chains'
import {
  registryAddress,
  type SupportedChainId,
} from '../lib/contracts'
import { formatTimestamp, relativeTime, formatDateOnly } from '../lib/format'

export function PostDetail() {
  // Two URL shapes hit this component:
  //   1. /post/:id                  — legacy composite (`base-42`).
  //   2. /post/:chainSlug/:postId   — clean route (Mesh SSR's canonical
  //                                  shape; preferred for new shares).
  //
  // Both render the same detail view. We normalize to the composite id
  // (`{slug}-{onchainId}`) here because every downstream lookup —
  // archive matcher, GraphQL fetcher, chainSlugFromCompositeId — expects
  // that shape.
  const params = useParams<{ id?: string; chainSlug?: string; postId?: string }>()
  const postId =
    params.chainSlug && params.postId
      ? `${params.chainSlug}-${params.postId}`
      : params.id ?? ''

  // Archive entries are read-only frontend data — branch BEFORE the
  // useQuery call so we never hit the network for `archive-*` ids.
  const archiveSlug = archiveSlugFromUrlId(postId)
  if (archiveSlug !== null) {
    return <ArchiveDetail slug={archiveSlug} />
  }

  return <LivePostDetail postId={postId} />
}

function LivePostDetail({ postId }: { postId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['post', postId],
    queryFn: () => fetchPostDetail(postId),
    enabled: postId.length > 0,
  })

  // Comment count is a separate, cheap query so the existing post-detail
  // path stays untouched. Failures here are silent — a missing count
  // chip is better than tearing down the whole post page.
  const { data: commentCount } = useQuery({
    queryKey: ['commentCount', postId],
    queryFn: () => fetchCommentCount(postId),
    enabled: postId.length > 0,
  })

  if (isLoading) {
    return (
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        loading attack #{postId}…
      </p>
    )
  }

  if (error) {
    return (
      <EmptyState
        title="couldn't load this attack."
        hint={(error as Error).message}
      />
    )
  }

  if (!data) {
    return (
      <EmptyState
        title={`attack #${postId} not found.`}
        hint="the id may be wrong, or the attack hasn't been indexed yet."
      />
    )
  }

  // Governance-purged posts render a tombstone instead of the original
  // payload. The point of purging is to scrub the offending material
  // from the UI even though it remains readable on-chain — so we
  // deliberately drop title / note / attackers / victims here.
  if (data.purged) {
    return <PurgedTombstone postId={data.id} purgedAt={data.purgedAtTimestamp} />
  }

  const chainSlug = chainSlugFromCompositeId(data.id)
  // Build the canonical share path. The clean `/post/:chain/:postId`
  // shape is what the Mesh OG handler matches and what we want pasted
  // into chats — Telegram et al. render the OG card from that URL.
  const sharePath = chainSlug
    ? `/post/${chainSlug}/${data.id.slice(chainSlug.length + 1)}`
    : `/post/${data.id}`

  return (
    <article className="space-y-10">
      {/* Top action row: back-to-feed (left) + mobile-only share (right).
          On sm+ the share button is hidden here and lives next to the
          title instead (its existing desktop position, unchanged). */}
      <div className="flex items-center justify-between gap-x-4">
        <BackLink className="inline-block text-xs uppercase tracking-widest rekt-link">
          ← back to feed
        </BackLink>
        <span className="sm:hidden">
          <ShareButton path={sharePath} size="md" />
        </span>
      </div>

      {/* Retract banner — only renders when the poster has called
          removePost() on this entry. Direct shared URLs still resolve
          (the on-chain audit trail is intentionally preserved) and the
          original content stays visible below for transparency, but
          someone landing here from a stale link needs to know at a
          glance that the alert is no longer endorsed by its poster.
          Purged posts take an earlier `if (data.purged)` branch and
          render PurgedTombstone instead — content is fully scrubbed
          for those by Mesh anyway. */}
      {data.removed && (
        <RetractedBanner removedAt={data.removedAtTimestamp} />
      )}

      <header className="space-y-4 border-b-2 border-black pb-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px] uppercase tracking-widest">
          {chainSlug && <ChainBadge slug={chainSlug} variant="full" />}
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
            attacked {relativeTime(data.attackedAt)} · {formatDateOnly(data.attackedAt)}
          </span>
          {typeof commentCount === 'number' && commentCount > 0 && (
            <>
              <span className="text-neutral-700">·</span>
              <span className="text-neutral-700" title={`${commentCount} comment${commentCount === 1 ? '' : 's'}`}>
                [{commentCount} comment{commentCount === 1 ? '' : 's'}]
              </span>
            </>
          )}
          {/* Desktop score: pushed right inside the flex-wrap chip row.
              Hidden on mobile — the bigger mobile score lives below. */}
          <span className="ml-auto hidden sm:inline">
            <ScoreLine net={data.netScore} up={data.confirmations} down={data.disconfirmations} />
          </span>
        </div>

        {/* Mobile-only score: bigger, right-aligned, under the chip row.
            Inherits no font-size from the 10px parent above.
            Hidden on sm+ where the inline score above takes over. */}
        <div className="sm:hidden text-right">
          <ScoreLine
            net={data.netScore}
            up={data.confirmations}
            down={data.disconfirmations}
            variant="mobile"
          />
        </div>

        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h1 className="flex-1 min-w-0 font-black tracking-tight text-3xl sm:text-4xl leading-tight text-neutral-900 whitespace-pre-wrap break-words">
            {data.title?.trim() || '(untitled)'}
          </h1>
          {/* Share lives next to the title on desktop (sm+) so it's the
              first thing a reader reaches for after they've decided this
              post is worth sending around. Hidden on mobile — the share
              button moved to the top action row instead. */}
          <span className="hidden sm:block">
            <ShareButton path={sharePath} size="md" />
          </span>
        </div>

        <dl className="grid grid-cols-1 gap-1 text-xs uppercase tracking-widest text-neutral-700 sm:grid-cols-2">
          <Field label="guardian">
            <AddressLabel addr={data.poster.id} chainSlug={chainSlug} />
          </Field>
          <Field label="reported on-chain" tooltip={formatTimestamp(data.createdAtTimestamp)}>
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

      {/* Vote action bar — same component the feed uses, so the cache
          invalidation + tx flow is shared. The hooks for this component
          handle whitelist gating internally. Numeric postId is the
          on-chain part of the composite id (`base-2` → `2n`). The
          chainId is derived from the post's slug — buttons only render
          when the post lives on a chain with a deployed registry. */}
      {(() => {
        const onchainPart = chainSlug
          ? data.id.slice(chainSlug.length + 1)
          : data.id
        let numericPostId: bigint | null = null
        try {
          numericPostId = BigInt(onchainPart)
        } catch {
          numericPostId = null
        }
        if (numericPostId === null) return null
        if (!chainSlug) return null
        const resolvedChainId = chainIdFromSlug(chainSlug)
        if (resolvedChainId === undefined) return null
        if (registryAddress(resolvedChainId) === undefined) return null
        const voteChainId = resolvedChainId as SupportedChainId
        return (
          <div className="flex flex-wrap items-center gap-3">
            <ConfirmVoteButtons
              chainId={voteChainId}
              postId={numericPostId}
              upCount={data.confirmations}
              downCount={data.disconfirmations}
              posterAddress={data.poster.id}
            />
          </div>
        )
      })()}

      {data.note?.trim() && (
        <section>
          <SectionLabel>note</SectionLabel>
          <div className="mt-3">
            <Markdown source={data.note} />
          </div>
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
                      [{link.address.attackerAppearances} attack(s)]
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

      {/* Guardian comments thread. Lives at the bottom — it's a
          discussion layer over the headline data above. The thread
          handles its own connect/whitelist gate inside ComposeBox, so
          it's safe to mount unconditionally. */}
      <CommentThread postId={data.id} chainSlug={chainSlug} />
    </article>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-black uppercase tracking-widest text-sm">{children}</h2>
  )
}

function ScoreLine({
  net,
  up,
  down,
  variant = 'desktop',
}: {
  net: number
  up: number
  down: number
  /** `desktop` — inherits parent font-size (tiny inside the chip row).
   *  `mobile`  — explicit text-lg net score + text-xs breakdown for
   *              the mobile-only block rendered outside the chip row. */
  variant?: 'desktop' | 'mobile'
}) {
  if (variant === 'mobile') {
    return (
      <span className="font-mono">
        <span className={`text-lg font-black ${scoreTextColor(net)}`}>
          {net >= 0 ? `+${net}` : net}
        </span>{' '}
        <span className="text-xs text-neutral-700">({up}↑/{down}↓)</span>
      </span>
    )
  }
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

/**
 * Banner shown above the original content when a post has been
 * retracted by its poster (`removePost(id)`). Distinct from
 * `PurgedTombstone`:
 *
 *   - Retract is a poster-initiated walk-back — the on-chain content
 *     stays available, and the UI preserves it below the banner so
 *     anyone landing on a stale shared link can still read what the
 *     poster originally said. The unified feed hides retracted posts
 *     (Mesh `removed_eq: false` filter), so reaching this banner means
 *     the user navigated here directly.
 *
 *   - Purge is a governance scrub — content is intentionally hidden
 *     UI-side (Mesh resolver also masks the payload). Renders a full
 *     `PurgedTombstone` instead of the post body.
 *
 * Brutalist red callout matches the existing "retracted" inline badge
 * but escalates the prominence so it can't be missed.
 */
function RetractedBanner({ removedAt }: { removedAt: string | null }) {
  return (
    <div className="border-2 border-red-600 bg-red-50 px-5 py-4 space-y-1">
      <p className="font-black uppercase tracking-tighter text-xl sm:text-2xl leading-none text-red-700">
        this post was retracted
      </p>
      <p className="font-black uppercase tracking-widest text-[11px] text-red-700/90">
        by its poster
        {removedAt && (
          <>
            {' · '}
            <span title={formatTimestamp(removedAt)}>
              {relativeTime(removedAt)}
            </span>
          </>
        )}
      </p>
      <p className="text-[10px] uppercase tracking-widest text-red-700/80 pt-1">
        the content below is preserved for transparency. it is no longer
        endorsed by the original poster.
      </p>
    </div>
  )
}

/**
 * Tombstone shown when a post has been purged by governance. Brutalist
 * callout — no title / note / attackers / victims surfaced; the entire
 * point of the purge is to keep the offending content out of view.
 *
 * The on-chain record still exists; integrators can still read every
 * field via `getPost(postId)` or the GraphQL gateway. This tombstone is
 * purely a frontend signal that the registry's curators chose to hide
 * this entry.
 */
function PurgedTombstone({
  postId,
  purgedAt,
}: {
  postId: string
  purgedAt: string | null
}) {
  return (
    <article className="space-y-8">
      <BackLink className="inline-block text-xs uppercase tracking-widest rekt-link">
        ← back to feed
      </BackLink>
      <div className="border-2 border-black bg-black text-[#f5f4ee] px-6 py-10 text-center space-y-3">
        <p className="text-[10px] uppercase tracking-widest opacity-70">
          [post #{postId}]
        </p>
        <p className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
          this attack was purged
        </p>
        <p className="font-black uppercase tracking-widest text-xs">
          from the registry by governance
        </p>
        {purgedAt && (
          <p className="text-[10px] uppercase tracking-widest opacity-70 pt-2">
            purged {relativeTime(purgedAt)} · {formatTimestamp(purgedAt)}
          </p>
        )}
      </div>
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        the on-chain record is still readable directly from the contract.
        this UI deliberately hides the original content.
      </p>
    </article>
  )
}

