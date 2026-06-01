/**
 * WalletRuntime — lazily-loaded wallet boundary.
 *
 * This module is the entry point for the wagmi chunk.  It is NEVER imported
 * eagerly — only via React.lazy() in WalletBoundary.tsx.  Rollup will split
 * it (and all its transitive imports: wagmi, viem, connectors) into a
 * separate async chunk that does not appear on the homepage critical path.
 *
 * What this module does:
 *   1. Creates the wagmiConfig (connectors + transports).  Config creation
 *      lives here instead of lib/wagmi.ts so that the module is only
 *      evaluated after the lazy import resolves, not at app startup.
 *   2. Mounts WagmiProvider around the `children` slot.
 *   3. Sets WalletReadyContext to true so hook-guards downstream can
 *      re-enable (e.g. useEnsLookup starts resolving ENS names).
 *   4. Mounts useDisconnectIfNotWhitelisted — the security guard that
 *      disconnects non-whitelisted wallets.
 *
 * Components inside `children` (passed from WalletBoundary) are rendered
 * inside the WagmiProvider tree, so all wagmi hooks work there.
 */

import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from '../lib/wagmi'
import { WalletReadyContext } from './WalletContext'
import { useDisconnectIfNotWhitelisted } from '../hooks/useDisconnectIfNotWhitelisted'

interface WalletRuntimeProps {
  readonly children: React.ReactNode
}

/**
 * Inner component (inside WagmiProvider) that activates the security guard.
 * Must be a child of WagmiProvider so the wagmi hooks inside the guard
 * work correctly.
 */
function WalletGuard({ children }: { readonly children: React.ReactNode }) {
  useDisconnectIfNotWhitelisted()
  return <>{children}</>
}

/**
 * The lazily-loaded runtime.  React.lazy requires a default export.
 */
export default function WalletRuntime({ children }: WalletRuntimeProps) {
  return (
    <WalletReadyContext.Provider value={true}>
      <WagmiProvider config={wagmiConfig}>
        <WalletGuard>{children}</WalletGuard>
      </WagmiProvider>
    </WalletReadyContext.Provider>
  )
}
