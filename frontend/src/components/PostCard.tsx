import { Link } from 'react-router-dom'
import { type FeedPost, splitCompositeId } from '../lib/queries'
import {
  archivePostUrlId,
  formatAmountUsd,
  type ArchivePost,
} from '../lib/archive'
import { relativeTime } from '../lib/format'
import { AddressLabel } from './AddressLabel'
import { ChainBadge } from './ChainBadge'
import { ConfirmVoteButtons } from './ConfirmVoteButtons'

/**
 * Discriminated union — `kind: 'live'` for on-chain posts, `kind:
 * 'archive'` for pre-platform incidents from `data/historic-incidents.json`.
 *
 * Keeps the call site honest: TypeScript forces every branch to handle
 * both variants, and the underlying types stay distinct (no fake
 * adapters that pretend an archive entry has a `confirmations` count).
 */
export type PostCardItem =
  | { kind: 'live'; post: FeedPost }
  | { kind: 'archive'; post: ArchivePost }

export function PostCard({ item }: { item: PostCardItem }) {
  if (item.kind === 'archive') return <ArchivePostCard post={item.post} />
  return <LivePostCard post={item.post} />
}

// =============================================================================
// Live post — same layout as before the archive refactor.
// =============================================================================

function LivePostCard({ post }: { post: FeedPost }) {
  const chainSlug = post.chain?.slug
  // v1.1: title is a required on-chain field — it IS the headline.
  // Note is the longer free-form body; previewed below the title.
  const headline = post.title?.trim() || '(untitled)'
  const body = post.note?.trim()
  // The on-chain `confirm` / `unconfirm` calls take the bare uint256 id,
  // not our composite `{slug}-{onchainId}`. Extract the on-chain part.
  // Currently the registry is only deployed on Base, so non-base posts
  // have no working confirm path; we still split (it's pure) and let
  // the buttons render — they'll succeed once those chains go live and
  // this component is upgraded to chainId-aware routing.
  const { onchainId } = splitCompositeId(post.id)
  const numericPostId = (() => {
    try {
      return BigInt(onchainId)
    } catch {
      return null
    }
  })()

  return (
    <article className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {chainSlug && <ChainBadge slug={chainSlug} />}
        <span className="font-mono text-neutral-600">#{post.id}</span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-600 font-mono">attacked {relativeTime(post.attackedAt)}</span>
      </div>

      <Link to={`/post/${post.id}`} className="block group">
        <h2 className="font-black tracking-tight text-2xl sm:text-3xl leading-tight text-neutral-900 group-hover:text-red-600 transition-colors line-clamp-3">
          {headline}
        </h2>
      </Link>

      {body && (
        <p className="text-sm leading-relaxed text-neutral-700 line-clamp-3">
          {body}
        </p>
      )}

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs uppercase tracking-widest text-neutral-700">
        <span className="inline-flex items-center gap-1">
          [poster: <AddressLabel addr={post.poster.id} chainSlug={chainSlug} />]
        </span>
        <span>
          <span className="text-neutral-400">·</span>{' '}
          [{post.attackerLinks.length} attacker{post.attackerLinks.length === 1 ? '' : 's'}]
        </span>
        <span>
          <span className="text-neutral-400">·</span>{' '}
          [{post.victimLinks.length} victim{post.victimLinks.length === 1 ? '' : 's'}]
        </span>
        <span>
          <span className="text-neutral-400">·</span>{' '}
          <ScoreBadge net={post.netScore} up={post.confirmations} down={post.disconfirmations} />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {numericPostId !== null && (
          <ConfirmVoteButtons
            postId={numericPostId}
            upCount={post.confirmations}
            downCount={post.disconfirmations}
          />
        )}
        <Link
          to={`/post/${post.id}`}
          className="inline-block text-xs font-black uppercase tracking-widest rekt-link"
        >
          more →
        </Link>
      </div>
    </article>
  )
}

function ScoreBadge({ net, up, down }: { net: number; up: number; down: number }) {
  const color = net > 0 ? 'text-emerald-700' : net < 0 ? 'text-red-600' : 'text-neutral-700'
  return (
    <span className={`font-mono ${color}`}>
      {net >= 0 ? `+${net}` : net} ({up}↑/{down}↓)
    </span>
  )
}

// =============================================================================
// Archive post — read-only, off-chain. Same skeleton; differs in:
//   - top-row badges: ARCHIVE chip instead of #id
//   - metadata row: amount + source link instead of poster + score
//   - links: /post/archive-{slug}
// =============================================================================

function ArchivePostCard({ post }: { post: ArchivePost }) {
  const headline = post.title?.trim() || '(untitled)'
  const body = post.note?.trim()
  const detailHref = `/post/${archivePostUrlId(post)}`

  return (
    <article className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <ChainBadge slug={post.chain} />
        <ArchiveChip />
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-600 font-mono">attacked {relativeTime(post.attackedAt)}</span>
      </div>

      <Link to={detailHref} className="block group">
        <h2 className="font-black tracking-tight text-2xl sm:text-3xl leading-tight text-neutral-900 group-hover:text-red-600 transition-colors line-clamp-3">
          {headline}
        </h2>
      </Link>

      {body && (
        <p className="text-sm leading-relaxed text-neutral-700 line-clamp-3">
          {body}
        </p>
      )}

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs uppercase tracking-widest text-neutral-700">
        <span className="font-mono text-red-700">
          [{formatAmountUsd(post.amountUsd)}]
        </span>
        <span>
          <span className="text-neutral-400">·</span>{' '}
          [{post.attackers.length} attacker{post.attackers.length === 1 ? '' : 's'}]
        </span>
        <span>
          <span className="text-neutral-400">·</span>{' '}
          [{post.victims.length} victim{post.victims.length === 1 ? '' : 's'}]
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="text-neutral-400">·</span>{' '}
          [src:{' '}
          <a
            href={post.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rekt-link normal-case tracking-normal"
            onClick={(e) => e.stopPropagation()}
          >
            {sourceHostLabel(post.sourceUrl)} ↗
          </a>
          ]
        </span>
      </div>

      <Link
        to={detailHref}
        className="inline-block text-xs font-black uppercase tracking-widest rekt-link"
      >
        more →
      </Link>
    </article>
  )
}

function ArchiveChip() {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 border border-red-600 text-[10px] font-mono font-bold uppercase tracking-widest text-red-700 bg-red-50"
      title="Archive — pre-platform attack, not on-chain"
    >
      archive
    </span>
  )
}

/** Short host label for source URLs — keeps the metadata row tight. */
function sourceHostLabel(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '')
    if (h.endsWith('rekt.news')) return 'rekt.news'
    if (h.endsWith('wikipedia.org')) return 'wikipedia'
    return h
  } catch {
    return 'source'
  }
}
