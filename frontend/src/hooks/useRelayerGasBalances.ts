import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { arbitrum, base, baseSepolia, bsc, mainnet, optimism, polygon } from 'wagmi/chains'
import type { Address } from 'viem'

// Structural subset of viem's `PublicClient` — just the one method we call.
// The full `PublicClient<Transport, Chain>` type isn't uniform across
// op-stack vs. non-op-stack chains (different tx/block formatter unions),
// so a `Record<number, PublicClient>` of clients for different chains
// doesn't typecheck as one map. We only need `getBalance`, so we narrow
// to that instead of fighting viem's per-chain generics.
interface BalanceReadable {
  getBalance: (args: { address: Address }) => Promise<bigint>
}

/** One (address, chain) pair to check the native-token balance for. */
export interface BalanceTarget {
  chainId: number
  chainSlug: string
  address: string
}

export interface BalanceResult extends BalanceTarget {
  /** Native balance in wei, or null if the read failed. */
  balanceWei: bigint | null
  /** Native currency symbol (ETH, BNB, MATIC, ...), from the wagmi chain config. */
  symbol: string
}

const NATIVE_SYMBOL: Readonly<Record<number, string>> = {
  [mainnet.id]: mainnet.nativeCurrency.symbol,
  [base.id]: base.nativeCurrency.symbol,
  [arbitrum.id]: arbitrum.nativeCurrency.symbol,
  [optimism.id]: optimism.nativeCurrency.symbol,
  [bsc.id]: bsc.nativeCurrency.symbol,
  [polygon.id]: polygon.nativeCurrency.symbol,
  [baseSepolia.id]: baseSepolia.nativeCurrency.symbol,
}

/**
 * Reads native-token ("gas") balances for a set of (address, chain) pairs
 * straight from the public RPC transports already configured in
 * `lib/wagmi.ts` — the same publicly-readable chain state anyone could
 * pull from a block explorer, just batched for the status page.
 *
 * `usePublicClient({ chainId })` is called once per registry chain
 * (unrolled, matching `useIsWhitelisted`'s Rules-of-Hooks-safe style)
 * regardless of how many targets are requested; the actual balance reads
 * happen inside the react-query `queryFn` (plain async calls, not hooks),
 * which is what lets the target list vary at runtime.
 */
export function useRelayerGasBalances(targets: readonly BalanceTarget[]): {
  balances: BalanceResult[]
  isLoading: boolean
} {
  const mainnetClient = usePublicClient({ chainId: mainnet.id })
  const baseClient = usePublicClient({ chainId: base.id })
  const arbitrumClient = usePublicClient({ chainId: arbitrum.id })
  const optimismClient = usePublicClient({ chainId: optimism.id })
  const bscClient = usePublicClient({ chainId: bsc.id })
  const polygonClient = usePublicClient({ chainId: polygon.id })
  const baseSepoliaClient = usePublicClient({ chainId: baseSepolia.id })

  const clientsByChainId: Readonly<Record<number, BalanceReadable | undefined>> = {
    [mainnet.id]: mainnetClient,
    [base.id]: baseClient,
    [arbitrum.id]: arbitrumClient,
    [optimism.id]: optimismClient,
    [bsc.id]: bscClient,
    [polygon.id]: polygonClient,
    [baseSepolia.id]: baseSepoliaClient,
  }

  const targetKey = targets.map((t) => `${t.chainId}:${t.address}`).join(',')

  const { data, isLoading } = useQuery({
    queryKey: ['relayerGasBalances', targetKey],
    queryFn: async (): Promise<BalanceResult[]> => {
      return Promise.all(
        targets.map(async (t): Promise<BalanceResult> => {
          const client = clientsByChainId[t.chainId]
          const symbol = NATIVE_SYMBOL[t.chainId] ?? '?'
          if (!client) return { ...t, balanceWei: null, symbol }
          try {
            const balanceWei = await client.getBalance({ address: t.address as Address })
            return { ...t, balanceWei, symbol }
          } catch {
            return { ...t, balanceWei: null, symbol }
          }
        }),
      )
    },
    enabled: targets.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  return { balances: data ?? [], isLoading: targets.length > 0 && isLoading }
}
