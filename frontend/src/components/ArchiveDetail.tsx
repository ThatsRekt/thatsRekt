import { Link } from 'react-router-dom'
import {
  findArchiveBySlug,
  formatAmountUsd,
  type ArchivePost,
} from '../lib/archive'
import { AddressLabel } from './AddressLabel'
import { ChainBadge } from './ChainBadge'
import { EmptyState } from './EmptyState'
import { Markdown } from './Markdown'
import { formatTimestamp, relativeTime } from '../lib/format'

/**
 * Detail page for an archive incident. Reuses the same shell + section
 * affordances as the live PostDetail page, but:
 *
 *   - No timeline / confirmation log / edit history (none exist).
 *   - No active/retracted distinction — archive entries are static.
 *   - Adds [source ↗] and [amount] fields to the header grid.
 *   - Lookup is in-memory against the imported JSON, so there's no
 *     loading/error state — either the slug resolves or it doesn't.
 */
export function ArchiveDetail({ slug }: { slug: string }) {
  const post = findArchiveBySlug(slug)

  if (!post) {
    return (
      <EmptyState
        title={`archive entry "${slug}" not found.`}
        hint="the slug may be wrong, or this entry has been removed from the dataset."
      />
    )
  }

  return <ArchiveDetailView post={post} />
}

function ArchiveDetailView({ post }: { post: ArchivePost }) {
  const sourceLabel = sourceHostLabel(post.sourceUrl)

  return (
    <article className="space-y-10">
      <Link
        to="/"
        className="inline-block text-xs uppercase tracking-widest rekt-link"
      >
        ← back to feed
      </Link>

      <header className="space-y-4 border-b-2 border-black pb-6">
        <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-widest">
          <ChainBadge slug={post.chain} variant="full" />
          <span className="text-neutral-700">·</span>
          <span className="border border-neutral-700 px-2 py-0.5 font-black text-neutral-700">
            archived
          </span>
          <span className="text-neutral-700">·</span>
          <span title={formatTimestamp(post.attackedAt)}>
            attacked {relativeTime(post.attackedAt)}
          </span>
        </div>

        {/*
          Title row — page title h1 flex-grows, $ lost sits top-right at
          the same visual weight class. Mirrors the feed card treatment
          so the dread tone is consistent across surfaces. Amount drops
          below the title at narrow widths via flex-wrap.
        */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <h1 className="font-black tracking-tight text-3xl sm:text-4xl leading-tight text-neutral-900 whitespace-pre-wrap break-words flex-1 min-w-0">
            {post.title?.trim() || '(untitled)'}
          </h1>
          {post.amountUsd > 0 && (
            <span className="font-black tracking-tight text-3xl sm:text-4xl leading-tight text-red-700 font-mono whitespace-nowrap tabular-nums">
              {formatAmountUsd(post.amountUsd)}
            </span>
          )}
        </div>

        <dl className="grid grid-cols-1 gap-1 text-xs uppercase tracking-widest text-neutral-700 sm:grid-cols-2">
          <Field label="protocol">
            <span className="text-black normal-case tracking-normal">{post.protocol}</span>
          </Field>
          <Field label="primary chain">
            <span className="text-black normal-case tracking-normal">{post.chain}</span>
          </Field>
          {post.chainsAffected && post.chainsAffected.length > 0 && (
            <Field label="also affected">
              <span className="text-black normal-case tracking-normal">
                {post.chainsAffected.join(', ')}
              </span>
            </Field>
          )}
          <Field label="source">
            <a
              href={post.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rekt-link normal-case tracking-normal"
            >
              {sourceLabel} ↗
            </a>
          </Field>
        </dl>
      </header>

      <ArchiveBanner />

      {post.note?.trim() && (
        <section>
          <SectionLabel>note</SectionLabel>
          <div className="mt-3">
            <Markdown source={post.note} />
          </div>
        </section>
      )}

      <section>
        <SectionLabel>
          attackers <span className="text-neutral-700">[{post.attackers.length}]</span>
        </SectionLabel>
        {post.attackers.length === 0 ? (
          <p className="mt-2 text-xs uppercase tracking-widest text-neutral-700">
            none publicly attributed.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-black border-y-2 border-black">
            {post.attackers.map((addr) => (
              <li
                key={addr}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <AddressLabel addr={addr} chainSlug={post.chain} full />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionLabel>
          victims <span className="text-neutral-700">[{post.victims.length}]</span>
        </SectionLabel>
        {post.victims.length === 0 ? (
          <p className="mt-2 text-xs uppercase tracking-widest text-neutral-700">
            none listed.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-black border-y-2 border-black">
            {post.victims.map((addr) => (
              <li
                key={addr}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <AddressLabel addr={addr} chainSlug={post.chain} full />
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  )
}

function ArchiveBanner() {
  return (
    <aside className="border-2 border-neutral-700 bg-neutral-50 px-4 py-3 text-xs uppercase tracking-widest text-neutral-700">
      <span className="font-black">archive entry</span>
      <span className="text-neutral-400 mx-2">·</span>
      <span className="normal-case tracking-normal">
        Pre-platform incident, compiled by the community. Not on the
        on-chain registry — no confirmations, no edits, no timeline.
        See{' '}
        <a
          href="https://github.com/ThatsRekt/thatsRekt/blob/master/data/historic-incidents.json"
          target="_blank"
          rel="noopener noreferrer"
          className="rekt-link font-mono"
        >
          data/historic-incidents.json
        </a>{' '}
        for the canonical source.
      </span>
    </aside>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-black uppercase tracking-widest text-sm">{children}</h2>
  )
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
      <dd>{children}</dd>
    </div>
  )
}

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
