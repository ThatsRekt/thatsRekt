import { useEnsName } from 'wagmi'
import { mainnet } from 'wagmi/chains'

/**
 * Reverse-resolve an EVM address to its ENS primary name.
 *
 * Backed by wagmi's `useEnsName` (which itself uses TanStack Query under
 * the hood, so deduplication + caching is automatic). We pin chainId to
 * mainnet — ENS primary names live on Ethereum regardless of which
 * chain the address is actually active on (so the same address on Base
 * still gets its mainnet ENS name).
 *
 * **Import constraint**: this hook is only ever imported from modules that
 * live behind the wagmi lazy boundary (AddressLabelEns, PostAlertButtonLive,
 * AccountChipLive, etc.). Never import this hook from a module that is
 * reachable from the homepage entry chunk — it would anchor the entire wagmi
 * import graph to the critical path.
 *
 * WagmiProvider is guaranteed to be mounted whenever this hook is called,
 * so no `useWalletReady` guard is needed here.
 *
 * Caching strategy:
 *   - `staleTime: Infinity` — once resolved, never re-query for this
 *     address during the session. ENS primary names change rarely
 *     (manual `setName` tx on mainnet) and the cost of stale data is
 *     just showing the prior name briefly.
 *   - `gcTime: 1 day` — keep entries alive for 24h of inactivity so a
 *     user navigating between pages doesn't re-resolve familiar
 *     addresses.
 */
export function useEnsLookup(address: `0x${string}` | undefined | null) {
  const { data: name, isLoading } = useEnsName({
    address: address ?? undefined,
    chainId: mainnet.id,
    query: {
      enabled: !!address,
      staleTime: Infinity,
      gcTime: 24 * 60 * 60 * 1_000,
      retry: 1,
    },
  })
  return { name: name ?? null, isLoading }
}
