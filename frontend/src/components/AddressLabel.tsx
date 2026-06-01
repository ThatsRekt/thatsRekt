/**
 * AddressLabel — wagmi-free public API component.
 *
 * On first paint the homepage renders immediately with contributor names
 * (when registered) or truncated hex addresses. There is ZERO static wagmi
 * import in this module — the ENS resolution lives in `AddressLabelEns.tsx`
 * which is lazy-loaded only AFTER the wallet runtime is ready.
 *
 * ENS swap-in: once `walletReady` is true (WalletRuntime mounted + WagmiProvider
 * in scope), the lazy `AddressLabelEns` chunk loads and addresses in the feed
 * that are still on screen show their ENS primary names with no second click
 * required.
 *
 * The Suspense fallback is the wagmi-free `AddressLabelCore` (same as the
 * initial render), so there is no layout shift.
 */

import { lazy, Suspense } from 'react'
import { useWalletReady } from '../wallet/WalletContext'
import { AddressLabelCore, type AddressLabelCoreProps } from './AddressLabelCore'

// AddressLabelEns is the ONLY module in this import graph that references wagmi.
// React.lazy ensures rollup places it in the async wagmi chunk, not in the
// homepage entry chunk.
const LazyAddressLabelEns = lazy(() => import('./AddressLabelEns'))

export type { AddressLabelCoreProps as AddressLabelProps }

/**
 * Address with mobile-friendly affordances:
 *   - ENS-aware text — shows `vitalik.eth` instead of the hex address once
 *     the wallet runtime loads (async, no first-paint delay). Contributor
 *     aliases always show immediately (no wagmi dependency).
 *   - Copy icon button — always copies the *raw address*, even when an
 *     ENS name is shown. Tap target >= 28px.
 *   - Explorer icon link — always points to the *raw address* on the
 *     chain's block explorer.
 *   - The displayed text is tappable too (also copies the address).
 *
 * Icons are inline SVG so the component has no asset dependency.
 */
export function AddressLabel(props: AddressLabelCoreProps) {
  const walletReady = useWalletReady()

  // Before the wagmi chunk loads: render immediately with ensName=null.
  // Contributor names and truncated hex are shown at once.
  if (!walletReady) {
    return <AddressLabelCore {...props} ensName={null} />
  }

  // After wallet runtime loads: swap in the ENS-resolving version.
  // Suspense fallback is the plain core so there is no layout shift
  // during the brief async chunk fetch.
  return (
    <Suspense fallback={<AddressLabelCore {...props} ensName={null} />}>
      <LazyAddressLabelEns {...props} />
    </Suspense>
  )
}
