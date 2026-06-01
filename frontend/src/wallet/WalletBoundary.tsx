/**
 * WalletBoundary — lazy Suspense wrapper for the wallet runtime.
 *
 * Usage in App.tsx / main.tsx:
 *
 *   <WalletBoundary walletSlot={<PostAlertButton /> + <AccountChip />} />
 *
 * The `walletSlot` is rendered inside WalletRuntime (under WagmiProvider).
 * Any component that calls wagmi hooks must be passed here.
 *
 * While WalletRuntime is loading (the wagmi chunk is being fetched), the
 * `loadingFallback` is shown in place of the walletSlot.  Default fallback
 * is null (nothing rendered), so the header simply has no wallet buttons
 * until the chunk arrives.  This is acceptable because:
 *   - The chunk is typically <200ms on a warm CDN edge.
 *   - The feed content renders immediately without waiting.
 *   - A "Connect" stub that does nothing on click would be misleading.
 */

import { lazy, Suspense } from 'react'

const WalletRuntime = lazy(() => import('./WalletRuntime'))

interface WalletBoundaryProps {
  /**
   * Content that requires wagmi (PostAlertButton, AccountChip, etc.).
   * Rendered inside WagmiProvider once the chunk resolves.
   */
  readonly walletSlot: React.ReactNode
  /**
   * What to render in place of walletSlot while the chunk is loading.
   * Defaults to null — nothing shown, which is the safest initial state.
   */
  readonly loadingFallback?: React.ReactNode
}

export function WalletBoundary({
  walletSlot,
  loadingFallback = null,
}: WalletBoundaryProps) {
  return (
    <Suspense fallback={loadingFallback}>
      <WalletRuntime>{walletSlot}</WalletRuntime>
    </Suspense>
  )
}
