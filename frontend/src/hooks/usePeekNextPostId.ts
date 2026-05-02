import { useEffect, useRef, useState } from 'react'
import { useReadContract } from 'wagmi'
import { registryAbi, registryAddress, type SupportedChainId } from '../lib/contracts'

/**
 * Subscribe to the registry's `peekNextPostId()` view on a specific
 * chain. Polls every 8s while enabled so the UI's displayed "your post
 * will be #N" stays fresh as other guardians race for the same slot.
 *
 * Tracks whether the value just changed (`bumped` flag) so the UI can
 * flash a visual cue. The flag auto-clears 4s after a bump — long enough
 * to be noticed, short enough not to linger.
 *
 * Returns:
 *   - id          — the current next-slot value (undefined while loading)
 *   - bumped      — true for a few seconds after the value changed, useful
 *                   for transient highlights
 *   - refetch     — manual refresh, e.g. right before submitting
 *   - isLoading   — initial fetch in flight
 *   - error       — read error if any
 */
export function usePeekNextPostId({
  chainId,
  enabled,
}: {
  chainId: number | undefined
  enabled: boolean
}): {
  id: bigint | undefined
  bumped: boolean
  refetch: () => void
  isLoading: boolean
  error: Error | null
} {
  // Resolve registry address. If the chain isn't supported, the read is
  // disabled — UI gates this upstream so this is just a guard.
  const address = chainId ? registryAddress(chainId) : undefined
  const supported = address !== null && chainId !== undefined

  const { data, isLoading, error, refetch } = useReadContract({
    address: address ?? undefined,
    abi: registryAbi,
    functionName: 'peekNextPostId',
    chainId: supported ? (chainId as SupportedChainId) : undefined,
    query: {
      enabled: enabled && supported,
      // Poll every 8s. Tradeoff: tighter (= fresher displayed ID, more
      // RPC requests) vs looser (= staler ID, more PostIdMismatch
      // surprises on submit). 8s feels right for human-paced form
      // composition without hammering the RPC.
      refetchInterval: 8000,
      // Refetch on tab focus too — user away → back is a common pattern
      // and stale ID would silently mislead them.
      refetchOnWindowFocus: true,
      staleTime: 0,
    },
  })

  // Track bump: when `data` changes from a previous non-undefined value,
  // flip `bumped` true for 4 seconds. Initial fetch (undefined → first
  // value) is NOT a bump — we don't want to flash on first paint.
  const [bumped, setBumped] = useState(false)
  const previousIdRef = useRef<bigint | undefined>(undefined)

  useEffect(() => {
    const prev = previousIdRef.current
    if (prev !== undefined && data !== undefined && data !== prev) {
      setBumped(true)
      const t = window.setTimeout(() => setBumped(false), 4000)
      previousIdRef.current = data
      return () => window.clearTimeout(t)
    }
    previousIdRef.current = data
  }, [data])

  return {
    id: data,
    bumped,
    refetch: () => {
      void refetch()
    },
    isLoading,
    error: (error as Error | null) ?? null,
  }
}
