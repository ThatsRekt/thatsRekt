import { useEffect, useMemo, useRef, useState } from 'react'
import { useEnsLookup } from '../hooks/useEnsLookup'
import { useAccount, useDisconnect } from 'wagmi'
import { useIsWhitelisted } from '../hooks/useIsWhitelisted'
import { WhitelistGateModal } from './WhitelistGateModal'
import { PostFormModal } from './PostFormModal'
import { chainsWithRegistry } from '../lib/contracts'

/**
 * Header-mounted "Post" CTA. Two-modal flow:
 *
 *   - **Gate modal** (`WhitelistGateModal`) handles connect + the
 *     "not whitelisted, here's how to apply" panel.
 *   - **Composer modal** (`PostFormModal`) is the actual on-chain post
 *     form, scoped to the chains the user is whitelisted on.
 *
 * Click matrix:
 *
 *   1. **Disconnected.** → opens gate (connector picker). Once a
 *      connector succeeds AND the per-chain whitelist read settles in
 *      the user's favor, the gate auto-closes and the composer auto-
 *      opens — operator requirement: no second click.
 *   2. **Connected, whitelisted.** → opens composer directly.
 *   3. **Connected, not whitelisted.** → opens gate; the gate's own
 *      panel logic shows the "become a poster" mailto.
 *
 * Visual: red-fill button, matches the `REKT` brand accent.
 */
export function PostAlertButton({
  variant = 'desktop',
  onAfterClick,
}: {
  /** `desktop` for the header strip; `mobile` for inside the mobile menu */
  variant?: 'desktop' | 'mobile'
  /** invoked after the button is clicked — used by mobile menu to close itself */
  onAfterClick?: () => void
}) {
  const [gateOpen, setGateOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const { address, isConnected } = useAccount()
  const {
    isWhitelisted,
    isLoading: isCheckingWhitelist,
    perChain,
  } = useIsWhitelisted(address)

  // Chains the user is currently whitelisted on. Filtering on `=== true`
  // (not truthy) deliberately excludes `undefined` (read still in flight)
  // and `false`. Recomputed on every render — `perChain` is a small
  // record (2 entries today), so the cost is negligible.
  const chainsAvailable = useMemo(
    () => chainsWithRegistry().filter((id) => perChain[id] === true),
    [perChain],
  )

  // Auto-promote from gate → composer once the post-connect whitelist
  // read resolves true. This replaces the old "silent close" effect:
  // the gate goes away AND the composer opens in the same tick, so the
  // user clicks "post" once and sees the form (operator requirement).
  useEffect(() => {
    if (
      gateOpen &&
      isConnected &&
      !isCheckingWhitelist &&
      isWhitelisted &&
      chainsAvailable.length > 0
    ) {
      setGateOpen(false)
      setComposerOpen(true)
    }
  }, [gateOpen, isConnected, isCheckingWhitelist, isWhitelisted, chainsAvailable.length])

  const handleClick = () => {
    onAfterClick?.()
    // Fast path: already connected + whitelisted + we know which chain(s)
    // → straight to the composer, no gate flash.
    if (isConnected && isWhitelisted && chainsAvailable.length > 0) {
      setComposerOpen(true)
      return
    }
    // Otherwise route through the gate. The gate handles connect AND the
    // not-whitelisted panel; the auto-promote effect above will swap to
    // the composer once the read settles in our favor (e.g. user just
    // connected and the per-chain reads are still in flight).
    setGateOpen(true)
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={
          variant === 'desktop'
            ? 'inline-flex items-center gap-1 border-2 border-red-600 bg-red-600 text-white px-3 py-1 text-[11px] uppercase tracking-widest font-black hover:bg-red-700 hover:border-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1'
            : 'block w-full text-left px-4 py-3 text-sm uppercase tracking-widest font-black bg-red-600 text-white hover:bg-red-700 active:bg-red-800 transition-colors'
        }
        aria-label="post alert"
      >
        post
      </button>
      <WhitelistGateModal
        open={gateOpen}
        onClose={() => setGateOpen(false)}
        isConnected={isConnected}
        address={address}
        isCheckingWhitelist={isCheckingWhitelist}
        isWhitelisted={isWhitelisted}
        title="[post]"
        // No `whenWhitelisted` slot: the auto-promote effect above does
        // the work — gate closes, composer opens — so the user never
        // needs an interstitial "ready to post" panel.
      />
      <PostFormModal
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        whitelistedChains={chainsAvailable}
      />
    </>
  )
}

/**
 * Compact account display + disconnect dropdown for the header.
 * Visible only when a wallet is connected; replaces nothing — sits
 * next to the Post button and the nav.
 *
 * Shows the ENS primary name when one resolves on mainnet (cached via
 * `useEnsLookup`), otherwise truncated hex. The disconnect dropdown
 * always uses the underlying address so users can still verify they're
 * disconnecting the right account.
 */
export function AccountChip() {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { name: ensName } = useEnsLookup(address)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close on click outside / Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!isConnected || !address) return null

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={address}
        className="inline-flex items-center gap-1 border-2 border-black bg-[#f5f4ee] px-2 py-1 text-[10px] uppercase tracking-widest font-mono hover:bg-yellow-100 transition-colors"
      >
        {ensName ?? truncate(address)}
        <span aria-hidden="true" className="text-[9px]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-44 border-2 border-black bg-[#f5f4ee] shadow-[4px_4px_0_0_#000]"
        >
          <button
            type="button"
            onClick={() => {
              disconnect()
              setOpen(false)
            }}
            className="block w-full text-left px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-yellow-100"
          >
            disconnect
          </button>
        </div>
      )}
    </div>
  )
}

function truncate(addr: `0x${string}`): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
