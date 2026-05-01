import { useCallback } from 'react'
import { useReadContract } from 'wagmi'
import { registryAddress, registryAbi } from '../lib/contracts'

/**
 * On-chain whitelist gate, multi-chain.
 *
 * Reads `isWhitelisted(address)` on each registry proxy we have deployed
 * (today: Base mainnet [8453] and Base Sepolia [84532]). The user is
 * considered whitelisted if AT LEAST ONE chain returns `true` — the post
 * form gates the chain selector on per-chain status separately.
 *
 * Per-chain queries are independent — a stalled RPC on one chain won't
 * block the others. Auto-disables when no address is provided so we
 * don't fire pre-connect.
 *
 * Refetches on the connected account changing AND on a 30s interval —
 * the whitelist is mutable on-chain, so we want fresh state without
 * forcing the user to refresh manually.
 *
 * Implementation note: `useReadContract` is a hook, so its call ordering
 * MUST be stable across renders (Rules of Hooks). We deliberately unroll
 * one explicit call per chain rather than mapping over an array — that
 * keeps the call ordering visibly stable and removes the eslint-disable
 * lint dance. Adding a third chain in the future is a 5-line edit here
 * (declare the query, fold it into the aggregates) — same effort as
 * adding a row to a `.map`, just React-correct.
 */

const COMMON_QUERY_OPTS = {
  // 30s — the gate doesn't need to be sub-second-fresh, but should
  // pick up an instant remove without a page reload.
  refetchInterval: 30_000,
  staleTime: 5_000,
} as const

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

  const baseQuery = useReadContract({
    address: registryAddress(8453),
    abi: registryAbi,
    functionName: 'isWhitelisted',
    args,
    chainId: 8453,
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

  // `data` is `unknown` until the query resolves — coerce to bool/undefined.
  const baseValue: boolean | undefined =
    baseQuery.data === undefined ? undefined : baseQuery.data === true
  const baseSepoliaValue: boolean | undefined =
    baseSepoliaQuery.data === undefined ? undefined : baseSepoliaQuery.data === true

  const perChain: Readonly<Record<number, boolean | undefined>> = Object.freeze({
    8453: baseValue,
    84532: baseSepoliaValue,
  })

  const isWhitelisted = baseValue === true || baseSepoliaValue === true
  const anyLoading = baseQuery.isLoading || baseSepoliaQuery.isLoading
  const anyFetching = baseQuery.isFetching || baseSepoliaQuery.isFetching
  const anyError = baseQuery.isError || baseSepoliaQuery.isError

  // Stable refetch closure — depends on the underlying refetch refs (each
  // of which is stable across renders for a given query key), so consumers
  // can safely place this in dep arrays.
  const refetch = useCallback(() => {
    void baseQuery.refetch()
    void baseSepoliaQuery.refetch()
  }, [baseQuery.refetch, baseSepoliaQuery.refetch])

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
