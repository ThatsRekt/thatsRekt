/**
 * CommentThread — lazy wrapper for the full interactive thread.
 *
 * On first paint the wallet runtime (wagmi + viem + connectors) is not yet
 * loaded. This wrapper shows a loading skeleton until WalletRuntime resolves,
 * then renders the full interactive version (CommentThreadLive) which
 * contains the compose box, edit/delete controls, and all wagmi hooks.
 *
 * The comment list itself (read-only display) could render before wagmi
 * loads, but since the compose box and edit controls are interleaved in
 * CommentRow, the cleanest split is the whole thread.  PostDetail pages
 * are not the homepage so this trade-off is acceptable.
 */

import { lazy, Suspense } from 'react'
import { useWalletReady } from '../wallet/WalletContext'

const CommentThreadLive = lazy(
  () =>
    import('./CommentThreadLive').then((m) => ({
      default: m.CommentThreadLive,
    })),
)

function CommentThreadSkeleton() {
  return (
    <section className="space-y-4">
      <h2 className="font-black uppercase tracking-widest text-sm">
        comments
      </h2>
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        loading…
      </p>
    </section>
  )
}

export function CommentThread({
  postId,
  chainSlug,
}: {
  readonly postId: string
  readonly chainSlug?: string
}) {
  const walletReady = useWalletReady()

  if (!walletReady) {
    return <CommentThreadSkeleton />
  }

  return (
    <Suspense fallback={<CommentThreadSkeleton />}>
      <CommentThreadLive postId={postId} chainSlug={chainSlug} />
    </Suspense>
  )
}
