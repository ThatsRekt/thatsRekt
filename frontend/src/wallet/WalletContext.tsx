/**
 * WalletReadyContext — single boolean that signals whether the lazy
 * WalletRuntime (WagmiProvider + connectors) has finished loading.
 *
 * Default: false.  The WalletRuntime component flips it to true once it
 * mounts.  Any component that calls a wagmi hook must either:
 *   (a) live inside WalletRuntime (under WagmiProvider), or
 *   (b) check this context before calling the hook and return a no-op
 *       when the value is false.
 *
 * This context has no value setter — consumers only read it.  The setter
 * is internal to WalletRuntime.tsx.
 */

import { createContext, useContext } from 'react'

export const WalletReadyContext = createContext<boolean>(false)

/** Read whether the wallet runtime is mounted. */
export function useWalletReady(): boolean {
  return useContext(WalletReadyContext)
}
