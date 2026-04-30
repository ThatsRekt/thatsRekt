import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { useIsWhitelisted } from '../hooks/useIsWhitelisted'
import { AddressLabel } from './AddressLabel'

const APPLY_EMAIL = 'thatsrekt@protonmail.com'

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
      {open && (
        <PostFlowModal
          onClose={() => setOpen(false)}
          isConnected={isConnected}
          address={address}
          isCheckingWhitelist={isCheckingWhitelist}
          isWhitelisted={isWhitelisted}
        />
      )}
    </>
  )
}

/**
 * The connect-or-gate modal. Renders one of three panels depending on
 * wallet state. Shared chrome (border, title strip, close button)
 * stays consistent across all three so the user sees a stable surface
 * as state advances.
 */
function PostFlowModal({
  onClose,
  isConnected,
  address,
  isCheckingWhitelist,
  isWhitelisted,
}: {
  onClose: () => void
  isConnected: boolean
  address: `0x${string}` | undefined
  isCheckingWhitelist: boolean
  isWhitelisted: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Close on Escape; lock body scroll while modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  // Focus the close button on first paint so Escape isn't the only exit.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-close]')?.focus()
  }, [])

  // Pick the right inner content for the current state.
  let body: React.ReactNode
  if (!isConnected) {
    body = <ConnectPanel onConnected={() => { /* useAccount picks it up; gate evaluates next render */ }} />
  } else if (isCheckingWhitelist || !address) {
    body = <CheckingPanel address={address} />
  } else if (isWhitelisted) {
    // The button's effect closes this case automatically; render a
    // brief confirmation so the user gets visual feedback before the
    // close fires next tick.
    body = <ReadyPanel address={address} />
  } else {
    body = <NotWhitelistedPanel address={address} onClose={onClose} />
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="post-alert-modal-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 py-12 sm:py-20 overflow-y-auto"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md border-2 border-black bg-[#f5f4ee] shadow-[6px_6px_0_0_#000]"
      >
        <header className="flex items-center justify-between border-b-2 border-black px-4 py-2 bg-black text-[#f5f4ee]">
          <h2
            id="post-alert-modal-title"
            className="text-[11px] uppercase tracking-widest font-black"
          >
            [post]
          </h2>
          <button
            type="button"
            data-close
            onClick={onClose}
            aria-label="close"
            className="text-[#f5f4ee] hover:text-red-500 -mr-1 px-1 leading-none text-lg"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-5">{body}</div>
      </div>
    </div>
  )
}

/**
 * Connector picker. Lists every configured connector that's `ready` —
 * skips the ones whose target wallet isn't actually installed (so we
 * don't show a dead "MetaMask" row when no extension exists).
 */
function ConnectPanel({ onConnected }: { onConnected: () => void }) {
  const { connectors, connect, error, isPending, variables } = useConnect()

  // Connectors come pre-configured from `wagmiConfig`. Filter out any
  // that aren't ready in this browser (e.g., Safe connector outside an
  // iframe context, injected with no extension installed).
  const visibleConnectors = connectors.filter((c) => c.type !== 'mock')

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-neutral-800">
        Connect your wallet to post an alert. We'll check whether your
        address is whitelisted; if so you can post directly. If not,
        we'll show how to apply.
      </p>
      <ul className="space-y-2">
        {visibleConnectors.map((connector) => {
          const isThisPending = isPending && variables?.connector === connector
          return (
            <li key={connector.uid}>
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  connect(
                    { connector },
                    {
                      onSuccess: () => onConnected(),
                    },
                  )
                }}
                className="w-full flex items-center justify-between border-2 border-black bg-white px-3 py-2 text-sm uppercase tracking-widest font-black hover:bg-yellow-100 active:bg-yellow-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <span>{connectorLabel(connector.name)}</span>
                {isThisPending ? (
                  <span className="text-xs">connecting…</span>
                ) : (
                  <span aria-hidden="true">→</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {error && (
        <p className="text-xs text-red-700 border-2 border-red-700 bg-red-50 px-3 py-2 uppercase tracking-widest">
          {error.message}
        </p>
      )}
      <p className="text-[10px] uppercase tracking-widest text-neutral-600">
        [no wallet?] install a browser wallet (MetaMask, Rabby, Brave) and reload.
      </p>
    </div>
  )
}

function CheckingPanel({ address }: { address: `0x${string}` | undefined }) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-neutral-800">
        Checking whitelist status…
      </p>
      {address && <AddressLabel addr={address} chainSlug="base" full />}
    </div>
  )
}

function ReadyPanel({ address }: { address: `0x${string}` | undefined }) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-neutral-800">
        You're whitelisted. Composer is shipping next — for now, post
        directly to the registry contract from this address.
      </p>
      {address && <AddressLabel addr={address} chainSlug="base" full />}
    </div>
  )
}

function NotWhitelistedPanel({
  address,
  onClose,
}: {
  address: `0x${string}` | undefined
  onClose: () => void
}) {
  const subject = encodeURIComponent('thatsRekt — vetted poster application')
  // Pre-fill the body so the recipient gets the exact info we need to
  // vet, including the connected address (saves the user a copy/paste).
  const bodyLines = [
    'Team / detector name:',
    'Public profile (X / GitHub / website):',
    'Detection focus (which protocols, chains, exploit classes):',
    'Existing track record (writeups, prior incidents flagged):',
    address ? `Address to whitelist: ${address}` : 'Address to whitelist:',
    '',
    "We'll review and reply with next steps.",
  ]
  const mailto = `mailto:${APPLY_EMAIL}?subject=${subject}&body=${encodeURIComponent(bodyLines.join('\n'))}`

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-neutral-800">
        This address is not whitelisted to post.
      </p>
      {address && <AddressLabel addr={address} chainSlug="base" full />}
      <section className="border-2 border-black bg-white p-4 space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-neutral-700">
          [become a poster]
        </p>
        <p className="text-sm leading-relaxed text-neutral-800">
          Email us with who you are, what you'd be reporting, and the
          address you want whitelisted. We'll review and add you.
        </p>
        <a
          href={mailto}
          onClick={onClose}
          className="inline-flex items-center gap-1 border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-red-700 hover:border-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1"
        >
          email {APPLY_EMAIL} →
        </a>
      </section>
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

function connectorLabel(rawName: string): string {
  // Map upstream connector names to lowercase brutalist labels. Wagmi's
  // `injected` connector shows the EIP-6963 wallet name when one is
  // available (e.g. "MetaMask", "Rabby"). Pass that through.
  return rawName.toLowerCase()
}
