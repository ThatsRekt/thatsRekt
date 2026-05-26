import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useIsWhitelisted } from '../hooks/useIsWhitelisted'
import { useUserVote } from '../hooks/useUserVote'
import { useConfirmPost, type ConfirmAction } from '../hooks/useConfirmPost'
import {
  ConfirmDirection,
  type ConfirmDirectionValue,
  type SupportedChainId,
} from '../lib/contracts'
import { WhitelistGateModal } from './WhitelistGateModal'

/**
 * Up/Down vote controls for a single post.
 *
 * Click flow:
 *   - **Disconnected.** Click → opens the connector picker. No auto-submit
 *     after connect (hostile UX to fire a tx popup the user didn't ask for).
 *   - **Connected, NOT whitelisted.** Click → opens the gate modal showing
 *     the "become a guardian" panel.
 *   - **Connected, whitelisted, no current vote.** Click → submits
 *     `confirm(postId, dir)`. Optimistic UI shows the new count immediately.
 *   - **Connected, whitelisted, voted same direction.** Click → submits
 *     `unconfirm(postId)` (toggles the vote off).
 *   - **Connected, whitelisted, voted opposite direction.** Click →
 *     `confirm(postId, dir)`; the contract atomically swaps.
 *   - **Connected, IS the post's author.** No buttons rendered — counts
 *     are shown read-only with a `[your post]` tag. The contract reverts
 *     self-votes (`onlyWhitelisted` + a NoSelfConfirm check), so popping
 *     a wallet that would 100% revert is just bad UX.
 *
 * **Optimistic UI.** The moment the user clicks, we predict the new counts
 * and the new "your vote" highlight by reading the current state and the
 * action. The button shows the predicted values immediately. After the tx
 * confirms we kick off a 30s polling loop (3s cadence) that invalidates
 * the feed/post queries until the indexer catches up to the prediction —
 * then we clear the optimistic overlay and the displayed numbers fall back
 * to props (which now equal what we predicted). If the tx fails, we revert
 * the overlay and surface the error implicitly via the next render.
 *
 * Visual: small icon-only buttons, brutalist (`border-2 border-black`,
 * sharp corners). Active vote is filled (green for Up, red for Down).
 */
export function ConfirmVoteButtons({
  chainId,
  postId,
  upCount,
  downCount,
  posterAddress,
}: {
  /**
   * Chain on which the post lives. All on-chain reads/writes (the
   * confirm tx, the user-vote read, etc.) must target this chain's
   * registry — voting on a Base Sepolia post must hit the Sepolia
   * proxy, not the Base mainnet one. Caller derives this from the
   * post's chain (`post.chain.chainId`).
   */
  chainId: SupportedChainId
  /**
   * The on-chain `uint256` post id. The PostCard composite id is
   * `{slug}-{onchainId}`; the caller must split it before passing this
   * in (use `splitCompositeId` from `lib/queries`).
   */
  postId: bigint
  upCount: number
  downCount: number
  /**
   * Address of the post's author. Used to detect "this is my post" so
   * we hide the vote buttons (the contract reverts self-votes anyway).
   * Case-insensitive comparison; pass whatever the indexer / contract
   * gives you.
   */
  posterAddress: string
}) {
  const queryClient = useQueryClient()
  const { address, isConnected } = useAccount()
  const { isWhitelisted, isLoading: isCheckingWhitelist } = useIsWhitelisted(address)
  const {
    direction: currentVote,
    isUp,
    isDown,
    refetch: refetchUserVote,
  } = useUserVote(chainId, postId, address)
  const { submit, isBroadcasting, isMining, isSwitching, isSuccess, error, hash, reset } =
    useConfirmPost(chainId)

  // Self-vote detection: connected + connected addr is the post author.
  // Address comparison is case-insensitive (poster comes from the indexer
  // lowercased; wagmi gives `0x` checksum form).
  const isOwnPost =
    !!address && address.toLowerCase() === posterAddress.toLowerCase()

  const [modalOpen, setModalOpen] = useState(false)

  // Track which direction the user clicked so the button shows a
  // pending spinner on the right side. `null` between actions.
  const [pendingDirection, setPendingDirection] = useState<1 | 2 | null>(null)

  // ----- optimistic overlay --------------------------------------------
  // When set, the displayed counts + the active-vote highlight come from
  // these instead of props. Cleared once the props (refetched after the
  // indexer catches up) match the predicted values, or on cutoff.
  const [optimisticUp, setOptimisticUp] = useState<number | null>(null)
  const [optimisticDown, setOptimisticDown] = useState<number | null>(null)
  const [optimisticVote, setOptimisticVote] =
    useState<ConfirmDirectionValue | null>(null)

  const clearOptimistic = () => {
    setOptimisticUp(null)
    setOptimisticDown(null)
    setOptimisticVote(null)
  }

  // Auto-close the modal once the wallet becomes connected + whitelisted.
  useEffect(() => {
    if (modalOpen && isConnected && !isCheckingWhitelist && isWhitelisted) {
      setModalOpen(false)
    }
  }, [modalOpen, isConnected, isCheckingWhitelist, isWhitelisted])

  // After a successful tx: kick off a polling loop that invalidates the
  // feed + post queries every 3s for up to 30s, until the indexer's
  // observed counts match our optimistic prediction. The 30s ceiling is
  // a defensive cutoff in case the indexer is unreachable or the tx
  // hash never resolves through the upstream chain — at that point we
  // give up and show whatever props say.
  //
  // The interval id lives in a ref (not a closure-local variable) so
  // re-fires of this effect — triggered when callbacks like
  // `refetchUserVote` get a new identity each render — can clear the
  // PRIOR interval before starting a new one. Without this, the per-hash
  // guard short-circuits and the prior interval keeps ticking alongside
  // a brand new one, multiplying RPC load.
  const lastSuccessHash = useRef<`0x${string}` | undefined>(undefined)
  const pollIntervalRef = useRef<number | null>(null)
  useEffect(() => {
    // Always clear any prior interval first — guarantees at most one
    // poller is active regardless of how many times this effect re-fires.
    if (pollIntervalRef.current !== null) {
      window.clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }

    if (!isSuccess || !hash || lastSuccessHash.current === hash) return
    lastSuccessHash.current = hash
    setPendingDirection(null)

    const startedAt = Date.now()
    const POLL_INTERVAL_MS = 3_000
    const POLL_CUTOFF_MS = 30_000

    const tick = () => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['post'] })
      void refetchUserVote()
    }
    tick() // immediate first tick

    pollIntervalRef.current = window.setInterval(() => {
      if (Date.now() - startedAt > POLL_CUTOFF_MS) {
        if (pollIntervalRef.current !== null) {
          window.clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        // Cutoff hit. Drop the overlay so the UI reflects whatever the
        // server actually returned — even if it disagrees with our
        // prediction. Better to show stale-but-real than a hopeful lie.
        clearOptimistic()
        return
      }
      tick()
    }, POLL_INTERVAL_MS) as unknown as number

    // Don't `reset()` synchronously — wagmi will surface `isSuccess: true`
    // again next render if we did, fighting our guard. Defer.
    const tReset = window.setTimeout(() => reset(), 0)
    return () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      window.clearTimeout(tReset)
    }
  }, [isSuccess, hash, queryClient, refetchUserVote, reset])

  // Once props (counts) catch up to the optimistic prediction, clear
  // the overlay so subsequent renders are driven by props alone. Doing
  // this in an effect keeps the polling loop simple — it only has to
  // refetch; reconciliation lives here.
  useEffect(() => {
    if (optimisticUp === null && optimisticDown === null) return
    const upMatch = optimisticUp === null || upCount === optimisticUp
    const downMatch = optimisticDown === null || downCount === optimisticDown
    if (upMatch && downMatch) {
      setOptimisticUp(null)
      setOptimisticDown(null)
    }
  }, [upCount, downCount, optimisticUp, optimisticDown])

  // Same for the user's own-vote highlight.
  useEffect(() => {
    if (optimisticVote === null) return
    if (currentVote === optimisticVote) setOptimisticVote(null)
  }, [currentVote, optimisticVote])

  // If the broadcast errors out (user rejected, sim revert, etc.),
  // surface it briefly via the button state, drop the optimistic
  // overlay so the UI snaps back to truth, and clear the pending dir.
  useEffect(() => {
    if (!error) return
    setPendingDirection(null)
    clearOptimistic()
  }, [error])

  const handleClick = async (clicked: 1 | 2) => {
    // Clear any stale error from a previous attempt so the UI starts clean
    // on each new click, regardless of what the prior attempt did.
    reset()

    // Disconnected → open the connect picker. No tx submitted.
    if (!isConnected) {
      setModalOpen(true)
      return
    }
    if (isCheckingWhitelist) return
    if (!isWhitelisted) {
      setModalOpen(true)
      return
    }
    // Self-vote attempt slipping through somehow (shouldn't be possible —
    // we don't render the buttons in that case). Defensive.
    if (isOwnPost) return

    // Build the action based on the user's CURRENT on-chain vote.
    const isToggleOff = currentVote === clicked
    const action: ConfirmAction = isToggleOff
      ? { kind: 'clear' }
      : { kind: 'vote', direction: clicked }

    // `submit` is async: it prompts a chain switch if needed, then fires the
    // wallet popup. Returns `false` if the user rejected the chain switch —
    // in that case nothing was submitted and there is nothing to revert.
    setPendingDirection(clicked)
    const submitted = await submit({ postId, action })

    if (!submitted) {
      // User cancelled the chain switch — bail without touching the overlay.
      setPendingDirection(null)
      return
    }

    // ---- optimistic overlay --------------------------------------------
    // Chain switch accepted; writeContract has been called. Predict the
    // post-action counts + the user's new highlight. Subtract the user's
    // PREVIOUS contribution, then add the new one.
    let nextUp = upCount
    let nextDown = downCount
    if (currentVote === ConfirmDirection.Up) nextUp = Math.max(0, nextUp - 1)
    else if (currentVote === ConfirmDirection.Down)
      nextDown = Math.max(0, nextDown - 1)
    if (!isToggleOff) {
      if (clicked === ConfirmDirection.Up) nextUp += 1
      else nextDown += 1
    }
    setOptimisticUp(nextUp)
    setOptimisticDown(nextDown)
    setOptimisticVote(isToggleOff ? ConfirmDirection.None : clicked)
  }

  const isAnyPending = isBroadcasting || isMining || isSwitching

  // Effective values to render — optimistic overlay wins when set, props
  // are the fallback. The user-vote highlight follows the same pattern.
  const displayUp = optimisticUp ?? upCount
  const displayDown = optimisticDown ?? downCount
  const effectiveVote = optimisticVote ?? currentVote
  const displayIsUp = effectiveVote === ConfirmDirection.Up
  const displayIsDown = effectiveVote === ConfirmDirection.Down

  // Self-post path: read-only counts, no buttons. Style mirrors the
  // VoteButton vocabulary so the row visually rhymes with other posts.
  if (isOwnPost) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex items-center gap-1 border-2 border-black px-2 py-0.5 text-[11px] font-mono font-black uppercase tracking-widest bg-white text-emerald-700">
          <span aria-hidden="true">↑</span>
          <span>{displayUp}</span>
        </span>
        <span className="inline-flex items-center gap-1 border-2 border-black px-2 py-0.5 text-[11px] font-mono font-black uppercase tracking-widest bg-white text-red-700">
          <span aria-hidden="true">↓</span>
          <span>{displayDown}</span>
        </span>
        <span
          className="ml-1 text-[10px] uppercase tracking-widest text-neutral-500"
          title="You reported this attack — the contract reverts self-votes."
        >
          [your attack]
        </span>
      </span>
    )
  }

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <VoteButton
          direction="up"
          count={displayUp}
          isActive={displayIsUp}
          isPending={isAnyPending && pendingDirection === ConfirmDirection.Up}
          isDisabled={isAnyPending}
          onClick={() => { void handleClick(ConfirmDirection.Up) }}
          ariaLabel={
            displayIsUp
              ? 'remove up vote'
              : displayIsDown
                ? 'switch to up vote'
                : 'vote up'
          }
        />
        <VoteButton
          direction="down"
          count={displayDown}
          isActive={displayIsDown}
          isPending={isAnyPending && pendingDirection === ConfirmDirection.Down}
          isDisabled={isAnyPending}
          onClick={() => { void handleClick(ConfirmDirection.Down) }}
          ariaLabel={
            displayIsDown
              ? 'remove down vote'
              : displayIsUp
                ? 'switch to down vote'
                : 'vote down'
          }
        />
      </span>
      {error && (
        <span
          className="block mt-1 font-mono text-[10px] uppercase tracking-widest text-red-700 border border-red-700 px-1 py-0.5 bg-red-50"
          role="alert"
          data-testid="vote-error"
        >
          {('shortMessage' in error && typeof error.shortMessage === 'string'
            ? error.shortMessage
            : error.message) || 'tx failed'}
        </span>
      )}
      <WhitelistGateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        isConnected={isConnected}
        address={address}
        isCheckingWhitelist={isCheckingWhitelist}
        isWhitelisted={isWhitelisted}
        title="[vote on attack]"
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
