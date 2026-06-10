import { Suspense, lazy } from 'react'

/**
 * LazyMarkdown — async chunk wrapper for react-markdown + remark-gfm.
 *
 * react-markdown and remark-gfm are heavy libs (~130 KB gzip combined).
 * They are only needed when a post note body is present and they live
 * entirely inside non-home routes (PostDetail) and inside the feed card
 * preview (PostCard → NotePreview). By deferring the import here, they
 * become an async chunk that does NOT block the homepage critical path.
 *
 * The Suspense fallback is a plain skeleton that preserves vertical
 * rhythm so the layout doesn't shift when the chunk lands.
 *
 * Props mirror the synchronous Markdown component so call sites can
 * swap in a drop-in fashion.
 */

// ---------------------------------------------------------------------------
// The inner async component — dynamically imports Markdown.
// This is the only place that references react-markdown and remark-gfm
// at module load time, keeping them out of the main chunk.
// ---------------------------------------------------------------------------

interface MarkdownProps {
  source: string
  compact?: boolean
}

const MarkdownInner = lazy(
  () => import('./Markdown').then((m) => ({ default: m.Markdown })),
)

/**
 * Skeleton fallback shown while the markdown chunk loads.
 *
 * Uses an animated shimmer consistent with the parchment background
 * (#f5f4ee). Two lines approximate a short body preview.
 */
function MarkdownSkeleton({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="space-y-1.5" aria-hidden="true">
        <div className="h-3 w-full animate-pulse bg-neutral-200 rounded-sm" />
        <div className="h-3 w-4/5 animate-pulse bg-neutral-200 rounded-sm" />
      </div>
    )
  }
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="h-4 w-full animate-pulse bg-neutral-200 rounded-sm" />
      <div className="h-4 w-5/6 animate-pulse bg-neutral-200 rounded-sm" />
      <div className="h-4 w-3/4 animate-pulse bg-neutral-200 rounded-sm" />
    </div>
  )
}

/**
 * Drop-in replacement for <Markdown>. Renders via a lazy chunk so
 * react-markdown and remark-gfm don't ride the main bundle.
 *
 * Usage:
 *   <LazyMarkdown source={body} />
 *   <LazyMarkdown source={body} compact />
 */
export function LazyMarkdown({ source, compact = false }: MarkdownProps) {
  return (
    <Suspense fallback={<MarkdownSkeleton compact={compact} />}>
      <MarkdownInner source={source} compact={compact} />
    </Suspense>
  )
}
