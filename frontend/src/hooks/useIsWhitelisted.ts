import { useReadContract } from 'wagmi'
import { base } from 'wagmi/chains'
import { REGISTRY_PROXY_ADDRESS, registryAbi } from '../lib/contracts'

/**
 * On-chain whitelist gate. Calls `isWhitelisted(address)` on the
 * registry proxy via wagmi's `useReadContract` (TanStack Query under
 * the hood, automatic dedupe + cache + react to address changes).
 *
 * Pinned to Base (the only chain the registry is currently deployed
 * to). Auto-disables when no address is provided (so it doesn't fire
 * before the user connects).
 *
 * Refetches on the connected account changing AND on a 30s interval —
 * the whitelist is mutable on-chain (the cold wallet can add/remove
 * via the 3-day TLC for adds, instant for removes), so we want fresh
 * state without forcing the user to refresh manually.
 */
export function useIsWhitelisted(address: `0x${string}` | undefined) {
  const query = useReadContract({
    address: REGISTRY_PROXY_ADDRESS,
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: {
      enabled: !!address,
      // 30s — the gate doesn't need to be sub-second-fresh, but should
      // pick up an instant remove without a page reload.
      refetchInterval: 30_000,
      staleTime: 5_000,
    },
  })

  return {
    isWhitelisted: query.data === true,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    refetch: query.refetch,
  }
}
