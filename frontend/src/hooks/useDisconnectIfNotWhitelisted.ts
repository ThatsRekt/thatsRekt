import { useEffect } from 'react'
import { useAccount, useDisconnect } from 'wagmi'
import { useIsWhitelisted } from './useIsWhitelisted'

/**
 * Auto-disconnect a wallet that turns out not to be whitelisted on
 * any deployed chain. Pure security-UX measure: a connected wallet
 * that can't take any guarded action is unnecessary attack surface
 * (signature-replay / phishing / accidental "I'm logged in" UX).
 *
 * Triggered by the multi-chain `useIsWhitelisted` read. When it
 * settles to false (NOT loading, NOT error), we disconnect. The
 * user is free to reconnect — if/when they're whitelisted, the
 * read will resolve true and we leave them alone.
 *
 * Mount once at the App level. Safe to mount multiple times — the
 * effect only fires when its inputs change, and `disconnect()` is
 * idempotent on an already-disconnected wallet.
 */
export function useDisconnectIfNotWhitelisted() {
  const { address, isConnected } = useAccount()
  const { isWhitelisted, isLoading, isFetching, isError } =
    useIsWhitelisted(address)
  const { disconnect } = useDisconnect()

  useEffect(() => {
    if (!isConnected || !address) return
    // Wait for a fully settled answer. `isLoading` only covers the
    // initial fetch — during a background refetch (RPC retry, polling
    // tick, refocus) TanStack Query temporarily holds `data: undefined`
    // with `{ isLoading: false, isFetching: true }`. Without the
    // `isFetching` guard, the previous render's truthy-by-accident path
    // could trigger a wrongful disconnect mid-refetch.
    if (isLoading || isFetching || isError) return
    if (isWhitelisted) return // happy path
    // Connected + read settled false → disconnect.
    disconnect()
  }, [
    address,
    isConnected,
    isLoading,
    isFetching,
    isError,
    isWhitelisted,
    disconnect,
  ])
}
