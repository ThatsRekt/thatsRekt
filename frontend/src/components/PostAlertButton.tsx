/**
 * PostAlertButton + AccountChip — lazy wrappers for the wagmi-dependent
 * header wallet UI.
 *
 * On first paint the wallet runtime (wagmi + viem + connectors) is not yet
 * loaded. These wrappers show stub UI (a disabled "report" button, nothing
 * for the account chip) until WalletRuntime resolves, then swap in the full
 * interactive versions from PostAlertButtonLive.tsx.
 *
 * The Live module contains all wagmi imports (useAccount, useDisconnect,
 * useIsWhitelisted, useConnect, useEnsLookup) — they land in the wagmi
 * async chunk, NOT the homepage-critical bundle.
 */

import { lazy, Suspense } from 'react'
import { useWalletReady } from '../wallet/WalletContext'

// React.lazy requires a default export.
// We create two separate lazy loaders, each re-exporting one named export
// as the default.  Both reference the same module so rollup merges them.
const PostAlertButtonLiveComponent = lazy(
  () => import('./PostAlertButtonLive').then((m) => ({ default: m.PostAlertButtonLive })),
)
const AccountChipLiveComponent = lazy(
  () => import('./PostAlertButtonLive').then((m) => ({ default: m.AccountChipLive })),
)

// ---------------------------------------------------------------------------
// PostAlertButton
// ---------------------------------------------------------------------------

/** Stub shown while the wallet runtime is loading. */
function PostAlertButtonStub({
  variant = 'desktop',
}: {
  variant?: 'desktop' | 'mobile'
}) {
  return (
    <button
      type="button"
      disabled
      aria-label="report attack"
      className={
        variant === 'desktop'
          ? 'inline-flex items-center gap-1 whitespace-nowrap border-2 border-red-600 bg-red-600 text-white px-3 py-1 text-[11px] uppercase tracking-widest font-black opacity-70 cursor-not-allowed'
          : 'block w-full text-left px-4 py-3 text-sm uppercase tracking-widest font-black bg-red-600 text-white opacity-70 cursor-not-allowed'
      }
    >
      report
    </button>
  )
}

/**
 * Header "report attack" button.
 * Shows a disabled stub until wagmi loads, then swaps to the interactive
 * version (PostAlertButtonLive) which handles connect → whitelist → compose.
 */
export function PostAlertButton({
  variant = 'desktop',
  onAfterClick,
}: {
  readonly variant?: 'desktop' | 'mobile'
  readonly onAfterClick?: () => void
}) {
  const walletReady = useWalletReady()

  if (!walletReady) {
    return <PostAlertButtonStub variant={variant} />
  }

  return (
    <Suspense fallback={<PostAlertButtonStub variant={variant} />}>
      <PostAlertButtonLiveComponent variant={variant} onAfterClick={onAfterClick} />
    </Suspense>
  )
}

// ---------------------------------------------------------------------------
// AccountChip
// ---------------------------------------------------------------------------

/**
 * Connected-wallet display chip for the header.
 * Returns null while wagmi is loading (AccountChipLive already returns null
 * when disconnected, so the visual effect is identical — nothing shown).
 */
export function AccountChip() {
  const walletReady = useWalletReady()

  if (!walletReady) return null

  return (
    <Suspense fallback={null}>
      <AccountChipLiveComponent />
    </Suspense>
  )
}
