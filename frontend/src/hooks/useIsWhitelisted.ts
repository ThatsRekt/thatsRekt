import { useCallback } from 'react'
import { useReadContract } from 'wagmi'
import { registryAddress, registryAbi } from '../lib/contracts'

/**
 * Onchain whitelist gate, multi-chain.
 *
 * Reads `isWhitelisted(address)` on every registry proxy we have deployed:
 * the six v1.2.0 mainnets — Ethereum [1], Base [8453], Arbitrum [42161],
 * Optimism [10], BSC [56], Polygon [137] — plus Base Sepolia [84532]
 * (dev/staging testnet).
 * The user is considered whitelisted if AT LEAST ONE chain returns `true`; the post
 * form gates the chain selector on per-chain status separately
 * (`postableChainIds`), which also applies the prod testnet gate.
 *
 * Per-chain queries are independent — a stalled RPC on one chain won't
 * block the others. Auto-disables when no address is provided so we
 * don't fire pre-connect.
 *
 * Refetches on the connected account changing AND on a 30s interval —
 * the whitelist is mutable onchain, so we want fresh state without
 * forcing the user to refresh manually.
 *
 * Implementation note: `useReadContract` is a hook, so its call ordering
 * MUST be stable across renders (Rules of Hooks). We deliberately unroll
 * one explicit call per chain rather than mapping over an array — that
 * keeps the call ordering visibly stable and removes the eslint-disable
 * lint dance. The per-chain results are then folded over an array (plain
 * data, not hook calls) so the aggregation stays DRY.
 */

const COMMON_QUERY_OPTS = {
  // 30s — the gate doesn't need to be sub-second-fresh, but should
  // pick up an instant remove without a page reload.
  refetchInterval: 30_000,
  staleTime: 5_000,
} as const

/** One chain's `isWhitelisted` read, reduced to the fields we fold over. */
export interface ChainWhitelistRead {
  readonly chainId: number
  /** Raw `useReadContract` data — `unknown` until the query resolves. */
  readonly data: unknown
  readonly isLoading: boolean
  readonly isFetching: boolean
  readonly isError: boolean
}

export interface WhitelistAggregate {
  readonly perChain: Readonly<Record<number, boolean | undefined>>
  readonly isWhitelisted: boolean
  readonly anyLoading: boolean
  readonly anyFetching: boolean
  readonly anyError: boolean
}

/**
 * Pure fold of per-chain whitelist reads into the hook's aggregates.
 * Extracted so the multi-chain logic is unit-testable without standing up
 * a wagmi provider (the repo's wagmi mocks are process-global and collide
 * across test files — see `useDonations.test.ts`).
 *
 * `data` coerces to `undefined` while a read is in flight, else strict
 * `=== true`. `isWhitelisted` is the OR across chains; an in-flight chain
 * never counts as whitelisted (its `data` is `undefined`, not `true`).
 */
export const aggregateWhitelist = (
  reads: readonly ChainWhitelistRead[],
): WhitelistAggregate => ({
  perChain: Object.freeze(
    Object.fromEntries(
      reads.map((r) => [r.chainId, r.data === undefined ? undefined : r.data === true]),
    ),
  ),
  isWhitelisted: reads.some((r) => r.data === true),
  anyLoading: reads.some((r) => r.isLoading),
  anyFetching: reads.some((r) => r.isFetching),
  anyError: reads.some((r) => r.isError),
})

export function useIsWhitelisted(address: `0x${string}` | undefined): {
  isWhitelisted: boolean
  isLoading: boolean
  isFetching: boolean
  perChain: Readonly<Record<number, boolean | undefined>>
  isError: boolean
  refetch: () => void
} {
  const args = address ? ([address] as const) : undefined
  const enabled = !!address

  // One unrolled `useReadContract` per registry chain (Rules of Hooks:
  // stable call order). Explicit `chainId` literals preserve wagmi's typed
  // chain narrowing. Keep these in `chainsWithRegistry()` display order.
  const mainnetQuery = useReadContract({
    address: registryAddress(1),
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args,
    chainId: 1,
    query: { enabled, ...COMMON_QUERY_OPTS },
  })

  const baseQuery = useReadContract({
    address: registryAddress(8453),
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args,
    chainId: 8453,
    query: { enabled, ...COMMON_QUERY_OPTS },
  })

  const arbitrumQuery = useReadContract({
    address: registryAddress(42161),
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args,
    chainId: 42161,
    query: { enabled, ...COMMON_QUERY_OPTS },
  })

  const optimismQuery = useReadContract({
    address: registryAddress(10),
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args,
    chainId: 10,
    query: { enabled, ...COMMON_QUERY_OPTS },
  })

  const bscQuery = useReadContract({
    address: registryAddress(56),
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args,
    chainId: 56,
    query: { enabled, ...COMMON_QUERY_OPTS },
  })

  const polygonQuery = useReadContract({
    address: registryAddress(137),
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args,
    chainId: 137,
    query: { enabled, ...COMMON_QUERY_OPTS },
  })

  const baseSepoliaQuery = useReadContract({
    address: registryAddress(84532),
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args,
    chainId: 84532,
    query: { enabled, ...COMMON_QUERY_OPTS },
  })

  // Fold the per-chain results via a pure helper (NOT hook calls), so the
  // aggregation stays DRY and unit-testable. Order mirrors
  // `chainsWithRegistry()` for display-order parity.
  const { perChain, isWhitelisted, anyLoading, anyFetching, anyError } =
    aggregateWhitelist([
      { chainId: 1, ...mainnetQuery },
      { chainId: 8453, ...baseQuery },
      { chainId: 42161, ...arbitrumQuery },
      { chainId: 10, ...optimismQuery },
      { chainId: 56, ...bscQuery },
      { chainId: 137, ...polygonQuery },
      { chainId: 84532, ...baseSepoliaQuery },
    ])

  // Stable refetch closure — depends on the underlying refetch refs (each
  // of which is stable across renders for a given query key), so consumers
  // can safely place this in dep arrays.
  const refetch = useCallback(() => {
    void mainnetQuery.refetch()
    void baseQuery.refetch()
    void arbitrumQuery.refetch()
    void optimismQuery.refetch()
    void bscQuery.refetch()
    void polygonQuery.refetch()
    void baseSepoliaQuery.refetch()
  }, [
    mainnetQuery.refetch,
    baseQuery.refetch,
    arbitrumQuery.refetch,
    optimismQuery.refetch,
    bscQuery.refetch,
    polygonQuery.refetch,
    baseSepoliaQuery.refetch,
  ])

  return {
    isWhitelisted,
    // No-address case: nothing is in flight; report not-loading.
    isLoading: enabled && anyLoading,
    // `isFetching` is true on ANY fetch (including refetches), unlike
    // `isLoading` which is initial-fetch only. Surfacing both lets
    // callers distinguish "haven't loaded yet" from "currently revalidating".
    isFetching: enabled && anyFetching,
    perChain,
    isError: anyError,
    refetch,
  }
}
