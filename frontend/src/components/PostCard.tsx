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
import { Markdown } from './Markdown'
import { ShareButton } from './ShareButton'

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
  // Prefer the clean `/post/:chain/:postId` URL for share-friendliness
  // (Mesh's SSR OG handler matches that shape). Fall back to the legacy
  // composite-id path if we somehow don't know the chain — the route
  // table still handles both.
  const detailHref = livePostHref(post)

  return (
    <article className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {chainSlug && <ChainBadge slug={chainSlug} />}
        <span className="font-mono text-neutral-600">#{post.id}</span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-600 font-mono">attacked {relativeTime(post.attackedAt)}</span>
      </div>

      <Link to={detailHref} className="block group">
        <h2 className="font-black tracking-tight text-2xl sm:text-3xl leading-tight text-neutral-900 group-hover:text-red-600 transition-colors line-clamp-3">
          {headline}
        </h2>
      </Link>

      {body && (
        <NotePreview body={body} />
      )}

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs uppercase tracking-widest text-neutral-700">
        <span className="inline-flex items-center gap-1">
          [guardian: <AddressLabel addr={post.poster.id} chainSlug={chainSlug} />]
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
            posterAddress={post.poster.id}
          />
        )}
        <ShareButton path={detailHref} />
        <Link
          to={detailHref}
          className="inline-block text-xs font-black uppercase tracking-widest rekt-link"
        >
          more →
        </Link>
      </div>
    </article>
  )
}

/**
 * Build a `/post/:chain/:postId` href from a FeedPost. The composite id
 * is `{chainSlug}-{onchainId}`; we split on the first dash from the right.
 * If the chain isn't known (legacy data), fall back to the legacy
 * composite-id path so the link still resolves.
 */
function livePostHref(post: FeedPost): string {
  const chainSlug = post.chain?.slug
  if (chainSlug && post.id.startsWith(`${chainSlug}-`)) {
    const onchainId = post.id.slice(chainSlug.length + 1)
    return `/post/${chainSlug}/${onchainId}`
  }
  return `/post/${post.id}`
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
//   - $ lost is pulled OUT of the metadata row into a dedicated red
//     horror-ticker strip directly under the title — the eye should
//     land on this number first
//   - metadata row: attackers + victims + source link (no amount chip)
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

      <LostAmountBanner amountUsd={post.amountUsd} />

      {body && (
        <NotePreview body={body} />
      )}

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs uppercase tracking-widest text-neutral-700">
        <span>
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

      <div className="flex flex-wrap items-center gap-3">
        <ShareButton path={detailHref} />
        <Link
          to={detailHref}
          className="inline-block text-xs font-black uppercase tracking-widest rekt-link"
        >
          more →
        </Link>
      </div>
    </article>
  )
}

/**
 * Horror-ticker $ lost banner for archive cards. Used to be a small
 * inline mono chip in the metadata row alongside attackers/victims/src;
 * operator wanted the eye to land on this number FIRST.
 *
 * Visual: dedicated bracketed strip with hard red top + bottom borders,
 * `text-red-700` heavy numerals at `text-2xl sm:text-3xl`. Bracketed
 * `[$ lost]` label on the left to keep the brutalist vocabulary; amount
 * floats to the right as the dominant element. Stretches edge-to-edge of
 * the card so it reads as a discrete strip, not a chip.
 */
function LostAmountBanner({ amountUsd }: { amountUsd: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-y-2 border-red-700 bg-red-50/40 px-3 py-2">
      <span className="text-[10px] uppercase tracking-widest font-black text-red-700">
        [$ lost]
      </span>
      <span className="font-mono font-black text-red-700 text-2xl sm:text-3xl tracking-tight tabular-nums">
        {formatAmountUsd(amountUsd)}
      </span>
    </div>
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

/**
 * Markdown-rendered note preview for feed cards.
 *
 * Wraps the rendered output in a fixed-height container (`max-h-24`,
 * ~96px / ~4-5 lines of body text) with `overflow-hidden`, then overlays
 * a parchment-colored gradient on the bottom 12px so the cut-off feels
 * intentional rather than abrupt. The underlying card already links to
 * the detail page; the fade is the visual hint that there's more.
 */
function NotePreview({ body }: { body: string }) {
  return (
    <div className="relative max-h-24 overflow-hidden">
      <Markdown source={body} compact />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-[#f5f4ee] to-transparent"
      />
    </div>
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
