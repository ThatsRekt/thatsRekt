import { useReadContract } from 'wagmi'
import {
  ConfirmDirection,
  registryAddress,
  registryAbi,
  type ConfirmDirectionValue,
  type SupportedChainId,
} from '../lib/contracts'

/**
 * Read the connected wallet's current vote on a post. Wraps the registry's
 * `confirmationOf(postId, address)` mapping getter — returns:
 *   - 0 (None) when the user has never voted, or has called `unconfirm`
 *   - 1 (Up)
 *   - 2 (Down)
 *
 * Parameterised on `chainId` so the read hits the registry deployed on
 * the same chain as the post being voted on (Base mainnet posts → Base
 * proxy; Base Sepolia posts → Sepolia proxy). The hook auto-disables
 * when no address is given so it doesn't fire before the wallet is
 * connected.
 *
 * Caching:
 *   - 5s `staleTime` so consecutive renders / mounts of the same post-card
 *     don't re-hit RPC — TanStack dedupes by queryKey.
 *   - 30s `refetchInterval` so a vote cast in another tab eventually
 *     reflects without a hard reload. Tx success path explicitly
 *     refetches via the returned `refetch`, so the latency for the
 *     calling user themselves is one-block (mining time), not 30s.
 */
export function useUserVote(
  chainId: SupportedChainId,
  postId: bigint | undefined,
  address: `0x${string}` | undefined,
) {
  const enabled = postId !== undefined && !!address

  const query = useReadContract({
    address: registryAddress(chainId),
    abi: registryAbi,
    functionName: 'confirmationOf',
    args: enabled ? [postId, address] : undefined,
    chainId,
    query: {
      enabled,
      staleTime: 5_000,
      refetchInterval: 30_000,
    },
  })

  // Solidity returns uint8; viem decodes that into `number`. Narrow it
  // to our typed enum values so consumers can reason about it as a
  // tagged direction. Anything outside 0/1/2 is a contract-level
  // invariant violation; treat it as None for safety.
  const raw = query.data
  const direction: ConfirmDirectionValue =
    raw === ConfirmDirection.Up
      ? ConfirmDirection.Up
      : raw === ConfirmDirection.Down
        ? ConfirmDirection.Down
        : ConfirmDirection.None

  return {
    direction,
    isUp: direction === ConfirmDirection.Up,
    isDown: direction === ConfirmDirection.Down,
    isNone: direction === ConfirmDirection.None,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    refetch: query.refetch,
  }
}
