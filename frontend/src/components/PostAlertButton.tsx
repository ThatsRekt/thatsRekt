import { useEffect, useRef, useState } from 'react'
import { useAccount, useDisconnect } from 'wagmi'
import { useIsWhitelisted } from '../hooks/useIsWhitelisted'
import { AddressLabel } from './AddressLabel'
import { WhitelistGateModal } from './WhitelistGateModal'

/**
 * Header-mounted "Post" CTA. Three-state UX:
 *
 *   1. **Disconnected.** Click → opens the connector picker (injected /
 *      Coinbase / Safe / future WalletConnect). Once a connector
 *      succeeds wagmi advances state to "connected".
 *   2. **Connected, whitelisted.** No modal pops up. The user is now
 *      ready to post — the on-chain composer (full form + tx) is the
 *      next feature; for v1 we just confirm the connect succeeded by
 *      letting the modal close. The connected address is shown in the
 *      header (see {@link AccountChip}).
 *   3. **Connected, not whitelisted.** Modal swaps to the
 *      "become a poster" gate explaining the application path.
 *
 * On any "wallet not whitelisted" judgment we wait for the read to
 * actually settle before deciding — flashing the gate while
 * `isWhitelisted` is still loading would mislead users who actually
 * are whitelisted.
 *
 * Visual: red-fill button, matches the `REKT` brand accent. Red is the
 * site's reserved CTA color.
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
  const [open, setOpen] = useState(false)
  const { address, isConnected } = useAccount()
  const { isWhitelisted, isLoading: isCheckingWhitelist } = useIsWhitelisted(address)

  // Whitelisted = no popup, ever. Two paths into that state:
  //   1. User clicks Post while ALREADY whitelisted → silent no-op.
  //   2. User clicks Post → connects via the modal → check resolves
  //      true → modal auto-closes here. The gate (NotWhitelistedPanel)
  //      is the only thing the user reads, and only when needed.
  useEffect(() => {
    if (open && isConnected && !isCheckingWhitelist && isWhitelisted) {
      setOpen(false)
    }
  }, [open, isConnected, isCheckingWhitelist, isWhitelisted])

  const handleClick = () => {
    onAfterClick?.()
    if (isConnected && isWhitelisted) return
    setOpen(true)
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
        open={open}
        onClose={() => setOpen(false)}
        isConnected={isConnected}
        address={address}
        isCheckingWhitelist={isCheckingWhitelist}
        isWhitelisted={isWhitelisted}
        title="[post]"
        whenWhitelisted={(addr) => <ReadyPanel address={addr} />}
      />
    </>
  )
}

/**
 * Brief confirmation between "wallet became whitelisted" and the
 * effect-driven auto-close. Only renders for ~one render tick during
 * the connect-then-already-whitelisted path.
 */
function ReadyPanel({ address }: { address: `0x${string}` }) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-neutral-800">
        You're whitelisted. Composer is shipping next — for now, post
        directly to the registry contract from this address.
      </p>
      <AddressLabel addr={address} chainSlug="base" full />
    </div>
  )
}

/**
 * Compact account display + disconnect dropdown for the header.
 * Visible only when a wallet is connected; replaces nothing — sits
 * next to the Post button and the nav.
 */
export function AccountChip() {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
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
        className="inline-flex items-center gap-1 border-2 border-black bg-[#f5f4ee] px-2 py-1 text-[10px] uppercase tracking-widest font-mono hover:bg-yellow-100 transition-colors"
      >
        {truncate(address)}
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
