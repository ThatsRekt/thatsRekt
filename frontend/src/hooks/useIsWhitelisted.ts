import { useMemo } from 'react'
import { useReadContract } from 'wagmi'
import {
  chainsWithRegistry,
  registryAddress,
  registryAbi,
} from '../lib/contracts'

/**
 * On-chain whitelist gate, multi-chain.
 *
 * Calls `isWhitelisted(address)` on every registry proxy returned by
 * `chainsWithRegistry()` (Base + Optimism today). The user is considered
 * whitelisted if AT LEAST ONE chain returns `true` — the post form will
 * still gate the chain selector on per-chain status.
 *
 * Per-chain queries are independent — a stalled RPC on one chain won't
 * block the others. Auto-disables when no address is provided so we
 * don't fire pre-connect.
 *
 * Refetches on the connected account changing AND on a 30s interval —
 * the whitelist is mutable on-chain (the cold wallet can add/remove via
 * the 3-day TLC for adds, instant for removes), so we want fresh state
 * without forcing the user to refresh manually.
 *
 * NOTE on hook ordering: wagmi v2's `useReadContract` is a hook, so its
 * call ordering must be stable across renders. `chainsWithRegistry()`
 * returns a fixed-length array (today: `[8453, 10]`); growing it
 * requires a release, so a `.map` over it is safe in practice. If you
 * ever conditionally drop a chain from that list at runtime, this loop
 * will break the Rules of Hooks — switch to explicit per-chain `useReadContract`
 * calls at that point.
 */
export function useIsWhitelisted(address: `0x${string}` | undefined): {
  isWhitelisted: boolean
  isLoading: boolean
  perChain: Readonly<Record<number, boolean | undefined>>
  isError: boolean
  refetch: () => void
} {
  const chainIds = chainsWithRegistry()

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const queries = chainIds.map((chainId) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useReadContract({
      address: registryAddress(chainId),
      abi: registryAbi,
      functionName: 'isWhitelisted',
      args: address ? [address] : undefined,
      chainId,
      query: {
        enabled: !!address,
        // 30s — the gate doesn't need to be sub-second-fresh, but should
        // pick up an instant remove without a page reload.
        refetchInterval: 30_000,
        staleTime: 5_000,
      },
    }),
  )

  const perChain: Record<number, boolean | undefined> = {}
  let anyTrue = false
  let anyLoading = false
  let anyError = false
  for (let i = 0; i < chainIds.length; i++) {
    const chainId = chainIds[i]
    const q = queries[i]
    // `data` is `unknown` until the query resolves — coerce to bool/undefined.
    const value: boolean | undefined =
      q.data === undefined ? undefined : q.data === true
    perChain[chainId] = value
    if (value === true) anyTrue = true
    if (q.isLoading) anyLoading = true
    if (q.isError) anyError = true
  }

  // Stable refetch callback that fans out to every per-chain query.
  // useMemo ensures consumers can put `refetch` in dep arrays without
  // triggering a re-render storm — the closure changes only when the
  // queries array identity does.
  const refetch = useMemo(
    () => () => {
      for (const q of queries) q.refetch()
    },
    // queries is rebuilt every render; depend on the underlying refetch
    // refs (each one is stable across renders for a given query key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    queries.map((q) => q.refetch),
  )

  return {
    isWhitelisted: anyTrue,
    // No-address case: nothing is in flight; report not-loading.
    isLoading: !!address && anyLoading,
    perChain,
    isError: anyError,
    refetch,
  }
}
