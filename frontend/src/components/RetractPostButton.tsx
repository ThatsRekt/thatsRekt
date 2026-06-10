import { useState } from 'react'
import { useAccount } from 'wagmi'
import { isSameAddress } from '../lib/address'
import { useRetractPost } from '../hooks/useRetractPost'
import { usePostMutationPoll } from '../hooks/usePostMutationPoll'
import type { SupportedChainId } from '../lib/contracts'

type RetractState = 'idle' | 'armed'

/**
 * Poster self-retract button for the post detail screen.
 *
 * Visibility matrix:
 *   - Disconnected → null
 *   - Connected, not the poster → null
 *   - Connected, is poster, alreadyRemoved=true → null (RetractedBanner handles UI)
 *   - Connected, is poster, alreadyRemoved=false → renders the retract button
 *
 * Two-step inline confirm (no modal):
 *   1. idle     → "retract". First click → armed (does NOT submit).
 *   2. armed    → "confirm — permanent" (filled red). Stays armed until the
 *                 second click or unmount — NO auto-revert timer.
 *   3. Second click → submit({ postId }). Hook auto-switches chain if needed.
 *   4. broadcasting → "retracting…"; mining → "confirming…"
 *   5. success  → "retracted ✓ · finalizing…" + poll loop until indexer flips
 *                 data.removed; once flipped, the page renders RetractedBanner
 *                 and this component unmounts (gated on !alreadyRemoved).
 *   6. error    → drop back to idle + inline red error span. Retry must re-arm.
 *
 * No whitelist gate — retract only requires msg.sender == poster.
 */
export function RetractPostButton({
  chainId,
  postId,
  posterAddress,
  alreadyRemoved,
}: {
  chainId: SupportedChainId
  postId: bigint
  /** EVM address of the post's author. Case-insensitive comparison is used. */
  posterAddress: string
  /** True if the post has already been removed (indexer-derived). */
  alreadyRemoved: boolean
}) {
  const { address } = useAccount()

  // Visibility gate: must be connected, must be the poster, must not already
  // be removed. Return null early — callers do not need to guard.
  const isPoster = isSameAddress(address, posterAddress)
  if (!address || !isPoster || alreadyRemoved) {
    return null
  }

  return (
    <RetractPostButtonInner
      chainId={chainId}
      postId={postId}
    />
  )
}

/**
 * Inner component that owns the FSM and hook calls. Separated so the outer
 * wrapper can return null cheaply without triggering any hook calls (hooks
 * must not be called conditionally).
 *
 * React guarantees that all hooks are called unconditionally inside a
 * rendered component. By splitting into a conditional outer wrapper and an
 * always-rendered inner, we satisfy that rule while keeping the null path
 * free of hook overhead.
 */
function RetractPostButtonInner({
  chainId,
  postId,
}: {
  chainId: SupportedChainId
  postId: bigint
}) {
  const [retractState, setRetractState] = useState<RetractState>('idle')
  const [localSuccess, setLocalSuccess] = useState(false)

  const {
    submit,
    reset,
    hash,
    isBroadcasting,
    isMining,
    isSuccess,
    error,
    isPending,
  } = useRetractPost(chainId)

  // Poll for indexer confirmation after the tx lands. Invalidates ['post'] +
  // ['feed'] so PostDetail re-fetches and eventually flips data.removed, which
  // causes this component to unmount (gated on !alreadyRemoved in the parent).
  usePostMutationPoll({ hash, isSuccess, reset })

  // Success: flip local success state for the transient "retracted ✓ · finalizing…"
  // label. The parent will unmount us once the indexer confirms.
  if (isSuccess && !localSuccess) {
    setLocalSuccess(true)
    setRetractState('idle')
  }

  // Error: drop back to idle so the user can retry. A retry must re-arm.
  if (error && retractState === 'armed') {
    setRetractState('idle')
  }

  const handleClick = async () => {
    if (retractState === 'idle') {
      // First click → arm. Do NOT submit.
      setRetractState('armed')
      return
    }

    // Second click → submit. The hook handles chain switching.
    await submit({ postId })
    // On success, isSuccess will flip true on next render and setLocalSuccess
    // will fire. On chain-switch rejection, submit returns false and we leave
    // the state as-is (armed), letting the user retry.
  }

  // ----- Label derivation ---------------------------------------------------

  let label: string
  if (localSuccess) {
    label = 'retracted ✓ · finalizing…'
  } else if (isBroadcasting) {
    label = 'retracting…'
  } else if (isMining) {
    label = 'confirming…'
  } else if (retractState === 'armed') {
    label = 'confirm — permanent'
  } else {
    label = 'retract'
  }

  // ----- Styling ------------------------------------------------------------

  const isArmed = retractState === 'armed'
  const baseClasses =
    'inline-flex items-center border-2 border-black px-2 py-0.5 text-[11px] font-mono font-black uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50'
  const colorClasses = isArmed
    ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-600'
    : 'bg-white text-red-700 hover:bg-red-50 focus:ring-red-600'
  const pendingClasses = isPending ? 'opacity-70 animate-pulse' : ''

  return (
    <>
      <button
        type="button"
        onClick={() => { void handleClick() }}
        disabled={isPending || localSuccess}
        aria-label={label}
        title={isArmed ? 'Click again to confirm permanent retraction' : 'Retract this post'}
        className={`${baseClasses} ${colorClasses} ${pendingClasses}`}
      >
        {label}
      </button>
      {error && (
        <span
          className="block mt-1 font-mono text-[10px] uppercase tracking-widest text-red-700 border border-red-700 px-1 py-0.5 bg-red-50"
          role="alert"
          data-testid="retract-error"
        >
          {('shortMessage' in error && typeof error.shortMessage === 'string'
            ? error.shortMessage
            : error.message) || 'tx failed'}
        </span>
      )}
    </>
  )
}
