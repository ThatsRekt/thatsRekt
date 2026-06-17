/**
 * IncidentCard — universal card for a grouped incident (1..N chains).
 *
 * Single-chain and multi-chain posts use the same structure:
 *   - Header: badge cluster (only when isCrossChain), title once, summary
 *     once, guardian once — all from the leadPost.
 *   - Consensus strip: one ConsensusRow per sibling post (chain badge, vote
 *     counts, inline vote controls, view → link, disputed tint).
 *   - Footer: share button.
 *
 * Never aggregates vote counts across chains. Votes stay per-chain.
 */
import { Link } from 'react-router-dom'
import type { IncidentGroup } from '../lib/incidents'
import { isDisputed, normalizeTitle } from '../lib/incidents'
import type { FeedPost, ChainInfo } from '../lib/queries'
import { splitCompositeId } from '../lib/queries'
import { registryAddress, type SupportedChainId } from '../lib/contracts'
import { relativeTime, formatDateOnly } from '../lib/format'
import { ChainBadge } from './ChainBadge'
import { AddressLabel } from './AddressLabel'
import { ConfirmVoteButtons } from './ConfirmVoteButtons'
import { LazyMarkdown } from './LazyMarkdown'
import { ShareButton } from './ShareButton'

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function IncidentCard({ group }: { group: IncidentGroup }) {
  const { leadPost, posts, chains, isCrossChain } = group
  const headline = normalizeTitle(leadPost.title) || '(untitled)'
  const body = leadPost.note?.trim()
  // Prefer the chain's canonical detail URL for the share button.
  const shareHref = livePostHref(leadPost)

  return (
    <article className="space-y-4">
      {/* ------------------------------------------------------------------ */}
      {/* Header row: badge cluster (cross-chain only) + timestamp            */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {isCrossChain && (
          <span
            className="inline-flex flex-wrap items-center gap-1"
            data-testid="chain-cluster"
          >
            {chains.map((c) => (
              <ChainBadge key={c.slug} slug={c.slug} />
            ))}
          </span>
        )}
        {!isCrossChain && leadPost.chain && (
          <ChainBadge slug={leadPost.chain.slug} />
        )}
        <span className="text-neutral-600 font-mono">
          attacked {relativeTime(leadPost.attackedAt)} ·{' '}
          {formatDateOnly(leadPost.attackedAt)}
        </span>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Title (once, normalized, linked to leadPost detail page)            */}
      {/* ------------------------------------------------------------------ */}
      <Link to={shareHref} className="block group">
        <h2 className="font-black tracking-tight text-2xl sm:text-3xl leading-tight text-neutral-900 group-hover:text-red-600 transition-colors line-clamp-3 capitalize">
          {headline}
        </h2>
      </Link>

      {/* ------------------------------------------------------------------ */}
      {/* Summary (once, from leadPost)                                       */}
      {/* ------------------------------------------------------------------ */}
      {body && <NotePreview body={body} />}

      {/* ------------------------------------------------------------------ */}
      {/* Guardian attribution (once, from leadPost)                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5 text-xs uppercase tracking-widest text-neutral-700">
        <span className="inline-flex items-center gap-1">
          [guardian:{' '}
          <AddressLabel addr={leadPost.poster.id} chainSlug={leadPost.chain?.slug} />]
        </span>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Consensus strip: one row per sibling post                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="border-t border-black/10 pt-3 space-y-2">
        {posts.map((post) => (
          <ConsensusRow key={post.id} post={post} />
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Footer                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-4 sm:gap-3">
        <ShareButton path={shareHref} />
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// ConsensusRow
// ---------------------------------------------------------------------------

/**
 * One row in the consensus strip — represents a single chain's post.
 *
 * Mobile layout: badge + counts on line 1; vote buttons + view → wrap to
 * line 2 on narrow screens (flex-wrap). Desktop: all on one line.
 */
export function ConsensusRow({ post }: { post: FeedPost }) {
  const disputed = isDisputed(post)
  const chainSlug = post.chain?.slug
  const detailHref = livePostHref(post)

  // Vote controls need the bare on-chain uint256 id.
  const { onchainId } = splitCompositeId(post.id)
  const numericPostId = (() => {
    try {
      return BigInt(onchainId)
    } catch {
      return null
    }
  })()

  const postChainId = post.chain?.chainId
  const voteChainId: SupportedChainId | null =
    postChainId !== undefined && registryAddress(postChainId) !== undefined
      ? (postChainId as SupportedChainId)
      : null

  return (
    <div
      className={
        'flex flex-wrap items-center gap-x-3 gap-y-2 py-2 px-2 rounded-sm text-xs ' +
        (disputed ? 'bg-red-50 border border-red-300' : 'bg-neutral-50 border border-black/5')
      }
      data-testid="consensus-row"
      data-disputed={String(disputed)}
    >
      {/* Line 1: chain badge + attacker/victim counts + disputed flag */}
      <div className="flex items-center gap-2 flex-wrap">
        {chainSlug && <ChainBadge slug={chainSlug} />}

        <span className="font-mono text-neutral-700">
          [{post.attackerLinks.length} atk]·[{post.victimLinks.length} vic]
        </span>

        {disputed && (
          <span className="text-[10px] font-black uppercase tracking-widest text-red-700">
            ⚠ DISPUTED
          </span>
        )}
      </div>

      {/* Line 2 (wraps on mobile): vote controls + view → */}
      <div className="flex items-center gap-2 flex-wrap ml-auto">
        {numericPostId !== null && voteChainId !== null && (
          <ConfirmVoteButtons
            chainId={voteChainId}
            postId={numericPostId}
            upCount={post.confirmations}
            downCount={post.disconfirmations}
            posterAddress={post.poster.id}
          />
        )}

        <Link
          to={detailHref}
          aria-label="view →"
          className="inline-block py-1 px-1 text-xs font-black uppercase tracking-widest rekt-link whitespace-nowrap"
        >
          view →
        </Link>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Internal helpers (mirrors PostCard's livePostHref)
// ---------------------------------------------------------------------------

function livePostHref(post: FeedPost): string {
  const chainSlug = post.chain?.slug
  if (chainSlug && post.id.startsWith(`${chainSlug}-`)) {
    const onchainId = post.id.slice(chainSlug.length + 1)
    return `/post/${chainSlug}/${onchainId}`
  }
  return `/post/${post.id}`
}

// ---------------------------------------------------------------------------
// NotePreview (same as in PostCard — extracted here to avoid coupling)
// ---------------------------------------------------------------------------

function NotePreview({ body }: { body: string }) {
  return (
    <div className="relative max-h-24 overflow-hidden">
      <LazyMarkdown source={body} compact />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-[#f5f4ee] to-transparent"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export type { IncidentGroup, ChainInfo }
