import { useEffect, useRef } from 'react'
import { useConnect } from 'wagmi'
import { AddressLabel } from './AddressLabel'

const APPLY_EMAIL = 'thatsrekt@protonmail.com'

/**
 * Shared connect-or-gate modal. Three states:
 *
 *   1. **Disconnected.** Renders a connector picker. Once a connector
 *      succeeds wagmi advances state; the parent component decides
 *      what happens next (auto-close + submit, swap to a different
 *      panel, etc.).
 *   2. **Connected, whitelist read in flight.** Renders a "checking…"
 *      panel so the user gets feedback during the brief window where
 *      we don't yet know if they can act.
 *   3. **Connected, not whitelisted.** Renders the "become a guardian"
 *      gate with a pre-filled mailto.
 *
 * The "connected + whitelisted" state is intentionally NOT rendered by
 * this component — different callers want different UIs (PostAlert
 * shows a brief "ready" confirmation; vote buttons just submit the tx
 * silently). Callers handle that branch themselves and either close the
 * modal or swap content via the `whenWhitelisted` slot.
 *
 * Visual: brutalist (`border-2 border-black`, sharp corners, hard
 * shadow). Locks body scroll while open; closes on Escape and on
 * backdrop click.
 */
export function WhitelistGateModal({
  open,
  onClose,
  isConnected,
  address,
  isCheckingWhitelist,
  isWhitelisted,
  title = '[whitelist required]',
  whenWhitelisted,
}: {
  open: boolean
  onClose: () => void
  isConnected: boolean
  address: `0x${string}` | undefined
  isCheckingWhitelist: boolean
  isWhitelisted: boolean
  /** Title strip text. Lowercase brutalist convention. */
  title?: string
  /**
   * Optional render slot for the "connected + whitelisted" panel. When
   * omitted, callers are expected to close the modal as soon as that
   * state is reached (the typical pattern for action-flow gates — the
   * user has already opted in by clicking, so no confirmation is needed).
   */
  whenWhitelisted?: (address: `0x${string}`) => React.ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Close on Escape; lock body scroll while modal is open.
  useEffect(() => {
    if (!open) return
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
  }, [open, onClose])

  // Focus the close button on first paint so Escape isn't the only exit.
  useEffect(() => {
    if (!open) return
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-close]')?.focus()
  }, [open])

  // Hide the modal during the post-connect on-chain whitelist check,
  // and silently after a verdict of "whitelisted" when no
  // `whenWhitelisted` slot is provided. Two reasons:
  //
  //   1. Whitelisted users who connect via this modal should never see
  //      a flash of "checking…" or "ready" — they expect the modal to
  //      simply disappear once their wallet is connected. Rendering
  //      anything in that window is visual noise.
  //   2. Non-whitelisted users get the gate panel as soon as the read
  //      settles; brief "no modal" gap during the check is acceptable
  //      (typically <500 ms via the routeme.sh Base RPC).
  //
  // The check window can be skipped entirely on cache hits — wagmi's
  // `useReadContract` returns the cached value synchronously on
  // re-renders, so a returning user sees no gap at all.
  const showCheckingPanel = false
  const hideForSilentClose =
    isConnected && address && !isCheckingWhitelist && isWhitelisted && !whenWhitelisted

  if (!open || hideForSilentClose) return null

  // Pick the right inner content for the current state.
  let body: React.ReactNode
  if (!isConnected) {
    body = <ConnectPanel />
  } else if (isCheckingWhitelist || !address) {
    // Render NOTHING during the check — modal frame is also hidden via
    // the early return below. Keeping `CheckingPanel` import for any
    // future flow that explicitly opts into showing it.
    if (!showCheckingPanel) return null
    body = <CheckingPanel address={address} />
  } else if (isWhitelisted) {
    // Caller-provided content (e.g. a "ready to post" confirmation).
    // When omitted, we already returned null above for silent close.
    body = whenWhitelisted ? whenWhitelisted(address) : null
  } else {
    body = <NotWhitelistedPanel address={address} onClose={onClose} />
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="whitelist-gate-modal-title"
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
            id="whitelist-gate-modal-title"
            className="text-[11px] uppercase tracking-widest font-black"
          >
            {title}
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
 * Connector picker. Lists every configured connector except `mock`.
 * On a successful connect, wagmi flips `useAccount().isConnected` to
 * true; the parent re-renders this modal and the next-state panel
 * takes over.
 */
function ConnectPanel() {
  const { connectors, connect, error, isPending, variables } = useConnect()
  const visibleConnectors = connectors.filter((c) => c.type !== 'mock')

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-neutral-800">
        Connect your wallet to continue. We'll check whether your
        address is whitelisted; if so you can act directly. If not,
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
                onClick={() => connect({ connector })}
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

function NotWhitelistedPanel({
  address,
  onClose,
}: {
  address: `0x${string}` | undefined
  onClose: () => void
}) {
  const subject = encodeURIComponent('thatsRekt — guardian application')
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
        This address is not whitelisted.
      </p>
      {address && <AddressLabel addr={address} chainSlug="base" full />}
      <section className="border-2 border-black bg-white p-4 space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-neutral-700">
          [become a guardian]
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

function connectorLabel(rawName: string): string {
  // Map upstream connector names to lowercase brutalist labels. Wagmi's
  // `injected` connector shows the EIP-6963 wallet name when one is
  // available (e.g. "MetaMask", "Rabby"). Pass that through.
  return rawName.toLowerCase()
}
