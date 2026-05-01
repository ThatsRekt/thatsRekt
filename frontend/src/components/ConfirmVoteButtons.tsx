import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useIsWhitelisted } from '../hooks/useIsWhitelisted'
import { useUserVote } from '../hooks/useUserVote'
import { useConfirmPost, type ConfirmAction } from '../hooks/useConfirmPost'
import { ConfirmDirection } from '../lib/contracts'
import { WhitelistGateModal } from './WhitelistGateModal'

/**
 * Up/Down vote controls rendered on each live PostCard. Click flow:
 *
 *   - **Disconnected.** Click → opens the connector picker. After a
 *     successful connect we DON'T auto-submit; we re-evaluate state
 *     (now: connected + maybe whitelisted) and the modal swaps to the
 *     gate or auto-closes. Auto-submitting silently right after a
 *     fresh connect would be hostile UX (the user just signed in,
 *     they didn't ask for a tx popup).
 *   - **Connected, NOT whitelisted.** Click → opens the gate modal
 *     showing the "become a poster" panel.
 *   - **Connected, whitelisted, no current vote.** Click → submits
 *     `confirm(postId, dir)` directly. Button shows a pending state
 *     while the wallet popup is up and the tx is mining.
 *   - **Connected, whitelisted, already voted in same direction.**
 *     Click → submits `unconfirm(postId)` (toggles the vote off).
 *   - **Connected, whitelisted, voted opposite direction.** Click →
 *     submits `confirm(postId, dir)`; the contract atomically swaps.
 *
 * On tx success we invalidate `['feed']` so the on-screen counts
 * refetch from the indexer. The user's own vote also re-reads via
 * `useUserVote.refetch()` so the highlighted button updates without
 * a manual reload.
 *
 * Visual: small icon-only buttons, brutalist (`border-2 border-black`,
 * sharp corners). Active vote is filled (green for Up, red for Down).
 */
export function ConfirmVoteButtons({
  postId,
  upCount,
  downCount,
}: {
  /**
   * The on-chain `uint256` post id. The PostCard composite id is
   * `{slug}-{onchainId}`; the caller must split it before passing this
   * in (use `splitCompositeId` from `lib/queries`).
   */
  postId: bigint
  upCount: number
  downCount: number
}) {
  const queryClient = useQueryClient()
  const { address, isConnected } = useAccount()
  const { isWhitelisted, isLoading: isCheckingWhitelist } = useIsWhitelisted(address)
  const {
    direction: currentVote,
    isUp,
    isDown,
    refetch: refetchUserVote,
  } = useUserVote(postId, address)
  const { submit, isBroadcasting, isMining, isSuccess, error, hash, reset } =
    useConfirmPost()

  // The modal only opens for the "needs to connect or get whitelisted"
  // branches. Whitelisted users go straight to a tx popup — no modal.
  const [modalOpen, setModalOpen] = useState(false)

  // Track which direction the user clicked so the button shows a
  // pending spinner on the right side. `null` between actions.
  const [pendingDirection, setPendingDirection] = useState<1 | 2 | null>(null)

  // Auto-close the modal once the wallet becomes connected + whitelisted.
  // Same pattern as PostAlertButton — we don't auto-submit because the
  // user just connected; they need to click again to opt into the tx.
  useEffect(() => {
    if (modalOpen && isConnected && !isCheckingWhitelist && isWhitelisted) {
      setModalOpen(false)
    }
  }, [modalOpen, isConnected, isCheckingWhitelist, isWhitelisted])

  // After a successful tx: refresh both the feed (`['feed', ...]`) and
  // any open post-detail page (`['post', ...]`), plus the local vote
  // read for the highlight. Reset the write hook so a future click
  // starts from a clean slate.
  //
  // Indexer lag: the receipt arrives the moment the chain confirms,
  // but the Subsquid processor is on its own poll cadence — typically
  // 2-5s behind chain head. An immediate refetch can come back with
  // pre-vote data and stick. We therefore fan out a few staggered
  // refetches: one immediate (in case the indexer was already current),
  // one at 3s (catches the common case), one at 8s (worst-case lag).
  // Cheap — same query, cache-deduped if the data is unchanged between
  // refetches.
  const lastSuccessHash = useRef<`0x${string}` | undefined>(undefined)
  useEffect(() => {
    if (!isSuccess || !hash || lastSuccessHash.current === hash) return
    lastSuccessHash.current = hash
    setPendingDirection(null)

    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['post'] })
      void refetchUserVote()
    }
    refresh()
    const t1 = window.setTimeout(refresh, 3_000)
    const t2 = window.setTimeout(refresh, 8_000)

    // Don't `reset()` synchronously — wagmi will surface `isSuccess: true`
    // again next render if we did, fighting our guard. Defer.
    const tReset = window.setTimeout(() => reset(), 0)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(tReset)
    }
  }, [isSuccess, hash, queryClient, refetchUserVote, reset])

  // If the broadcast errors out (user rejected, sim revert, etc.),
  // surface it briefly via the button state and clear the pending
  // direction so the button isn't stuck spinning.
  useEffect(() => {
    if (error) setPendingDirection(null)
  }, [error])

  const handleClick = (clicked: 1 | 2) => {
    // Disconnected → open the connect picker. No tx submitted.
    if (!isConnected) {
      setModalOpen(true)
      return
    }
    // Connected but whitelist still unknown → wait. Don't fire a tx
    // we'd then have to revert from the UI side; don't open the gate
    // either (might wrongly imply the user isn't whitelisted).
    if (isCheckingWhitelist) return

    // Connected and not whitelisted → gate.
    if (!isWhitelisted) {
      setModalOpen(true)
      return
    }

    // Connected + whitelisted → submit. Build the action based on the
    // user's current on-chain vote so the button always does the right
    // thing (toggle off, switch, or fresh vote).
    const action: ConfirmAction =
      currentVote === clicked
        ? { kind: 'clear' }
        : { kind: 'vote', direction: clicked }

    setPendingDirection(clicked)
    submit({ postId, action })
  }

  const isAnyPending = isBroadcasting || isMining

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <VoteButton
          direction="up"
          count={upCount}
          isActive={isUp}
          isPending={isAnyPending && pendingDirection === ConfirmDirection.Up}
          isDisabled={isAnyPending}
          onClick={() => handleClick(ConfirmDirection.Up)}
          ariaLabel={
            isUp
              ? 'remove up vote'
              : isDown
                ? 'switch to up vote'
                : 'vote up'
          }
        />
        <VoteButton
          direction="down"
          count={downCount}
          isActive={isDown}
          isPending={isAnyPending && pendingDirection === ConfirmDirection.Down}
          isDisabled={isAnyPending}
          onClick={() => handleClick(ConfirmDirection.Down)}
          ariaLabel={
            isDown
              ? 'remove down vote'
              : isUp
                ? 'switch to down vote'
                : 'vote down'
          }
        />
      </span>
      <WhitelistGateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        isConnected={isConnected}
        address={address}
        isCheckingWhitelist={isCheckingWhitelist}
        isWhitelisted={isWhitelisted}
        title="[vote on post]"
      />
    </>
  )
}

function VoteButton({
  direction,
  count,
  isActive,
  isPending,
  isDisabled,
  onClick,
  ariaLabel,
}: {
  direction: 'up' | 'down'
  count: number
  isActive: boolean
  isPending: boolean
  isDisabled: boolean
  onClick: () => void
  ariaLabel: string
}) {
  // Brutalist hard-edged button. Active state mirrors the registry
  // semantics: green = Up (signal-good), red = Down (signal-bad).
  const baseClasses =
    'inline-flex items-center gap-1 border-2 border-black px-2 py-0.5 text-[11px] font-mono font-black uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:cursor-not-allowed'
  const colorClasses = isActive
    ? direction === 'up'
      ? 'bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-600'
      : 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-600'
    : direction === 'up'
      ? 'bg-white text-emerald-700 hover:bg-emerald-50 focus:ring-emerald-600'
      : 'bg-white text-red-700 hover:bg-red-50 focus:ring-red-600'
  const pendingClasses = isPending ? 'opacity-70 animate-pulse' : ''

  const arrow = direction === 'up' ? '↑' : '↓'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-pressed={isActive}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`${baseClasses} ${colorClasses} ${pendingClasses} disabled:opacity-50`}
    >
      <span aria-hidden="true">{arrow}</span>
      <span>{count}</span>
    </button>
  )
}
