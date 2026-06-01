/**
 * ConfirmVoteButtons — lazy wrapper for the interactive vote controls.
 *
 * On first paint the wallet runtime (wagmi + viem + connectors) is not yet
 * loaded. This wrapper shows a read-only count display (no click handlers)
 * until WalletRuntime resolves, then renders the full interactive version.
 *
 * Splitting the module boundary here means `ConfirmVoteButtonsLive` (and
 * all its wagmi hook imports) end up in the wagmi async chunk, NOT in the
 * homepage-critical bundle.
 */

import { lazy, Suspense } from 'react'
import type { SupportedChainId } from '../lib/contracts'
import { useWalletReady } from '../wallet/WalletContext'

// Lazily import the full interactive version. Rollup places this module
// (and its wagmi/viem deps) in the separate wagmi async chunk.
const ConfirmVoteButtonsLive = lazy(
  () => import('./ConfirmVoteButtonsLive').then((m) => ({ default: m.ConfirmVoteButtonsLive })),
)

export interface ConfirmVoteButtonsProps {
  chainId: SupportedChainId
  postId: bigint
  upCount: number
  downCount: number
  posterAddress: string
}

/**
 * Read-only count display shown before the wallet runtime loads.
 * Mirrors the visual shape of VoteButton (border-2 border-black, font-mono)
 * so the layout doesn't shift when the interactive version mounts.
 */
function ReadOnlyCounts({
  upCount,
  downCount,
}: {
  readonly upCount: number
  readonly downCount: number
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex items-center gap-1 border-2 border-black px-2 py-0.5 text-[11px] font-mono font-black uppercase tracking-widest bg-white text-emerald-700">
        <span aria-hidden="true">↑</span>
        <span>{upCount}</span>
      </span>
      <span className="inline-flex items-center gap-1 border-2 border-black px-2 py-0.5 text-[11px] font-mono font-black uppercase tracking-widest bg-white text-red-700">
        <span aria-hidden="true">↓</span>
        <span>{downCount}</span>
      </span>
    </span>
  )
}

/**
 * Public-facing component. Shows read-only counts until the wallet
 * runtime is ready, then swaps in the full interactive version with
 * no layout shift (both have the same visual footprint).
 */
export function ConfirmVoteButtons({
  chainId,
  postId,
  upCount,
  downCount,
  posterAddress,
}: ConfirmVoteButtonsProps) {
  const walletReady = useWalletReady()

  if (!walletReady) {
    return <ReadOnlyCounts upCount={upCount} downCount={downCount} />
  }

  return (
    <Suspense fallback={<ReadOnlyCounts upCount={upCount} downCount={downCount} />}>
      <ConfirmVoteButtonsLive
        chainId={chainId}
        postId={postId}
        upCount={upCount}
        downCount={downCount}
        posterAddress={posterAddress}
      />
    </Suspense>
  )
}
