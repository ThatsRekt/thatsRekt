import { useCallback } from 'react'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import {
  registryAddress,
  registryAbi,
  type ConfirmDirectionValue,
  type SupportedChainId,
} from '../lib/contracts'

/**
 * Action surface for the confirm flow:
 *   - `{ kind: 'vote', direction: Up | Down }` → calls `confirm(postId, dir)`.
 *     Use this both for casting a fresh vote AND for switching from Up→Down
 *     (the contract handles the swap atomically).
 *   - `{ kind: 'clear' }` → calls `unconfirm(postId)`. Use this when the
 *     user clicks their own current vote (toggles it off).
 */
export type ConfirmAction =
  | { kind: 'vote'; direction: Exclude<ConfirmDirectionValue, 0> }
  | { kind: 'clear' }

/**
 * Submits a confirm / unconfirm tx to the registry, then waits for the
 * receipt. Two-stage hook:
 *
 *   1. `submit({ postId, action })` — fires the wallet popup. While the
 *      user is signing and the tx is propagating, `isBroadcasting` is
 *      true and `hash` is undefined. Once broadcast, `hash` is set.
 *   2. After broadcast, `useWaitForTransactionReceipt` polls. While
 *      polling, `isMining` is true. On success, `isSuccess` flips true.
 *
 * The hook is parameterised on `chainId` (one of `SupportedChainId`) so the
 * tx lands on the correct registry contract — voting on a Base Sepolia
 * post must hit the Sepolia proxy, not the Base mainnet one. The wallet
 * may need to switch chains; wagmi handles that prompt automatically when
 * `chainId` is provided.
 *
 * The hook does NOT invalidate any TanStack queries on its own — the
 * caller passes its own success callback because cache shape (which
 * `['feed', ...]` keys exist) is owned by the page, not this hook.
 */
export function useConfirmPost(chainId: SupportedChainId) {
  const {
    writeContract,
    data: hash,
    isPending: isBroadcasting,
    error: broadcastError,
    reset,
  } = useWriteContract()

  const {
    isLoading: isMining,
    isSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash,
    chainId,
  })

  const submit = useCallback(
    (params: { postId: bigint; action: ConfirmAction }) => {
      const { postId, action } = params
      const address = registryAddress(chainId)
      // `chainId` is typed as `SupportedChainId` (a literal union over the
      // keys of REGISTRY_PROXIES), so `registryAddress` is guaranteed to
      // resolve. The undefined branch is a defensive belt-and-suspenders
      // — if a caller bypasses the type with a cast, fail loud rather
      // than fire a tx with `address: undefined`.
      if (!address) {
        throw new Error(`No registry deployed for chainId ${chainId}`)
      }
      // The `ConfirmAction` type already excludes `direction: None` from
      // the `vote` variant (`Exclude<…, 0>`); the contract would revert
      // anyway on `InvalidConfirmDirection`. To clear a vote, callers
      // pass `{ kind: 'clear' }` instead.

      if (action.kind === 'vote') {
        writeContract({
          address,
          abi: registryAbi,
          functionName: 'confirm',
          args: [postId, action.direction],
          chainId,
        })
        return
      }

      writeContract({
        address,
        abi: registryAbi,
        functionName: 'unconfirm',
        args: [postId],
        chainId,
      })
    },
    [writeContract, chainId],
  )

  return {
    submit,
    reset,
    hash,
    isBroadcasting,
    isMining,
    isSuccess,
    // Surface whichever stage failed; receipt errors only fire post-broadcast,
    // so `broadcastError` (rejection / chain mismatch / sim failure) takes
    // precedence in the early flow.
    error: broadcastError ?? receiptError ?? null,
    /** Convenience: any "in flight" state — wallet popup OR mining. */
    isPending: isBroadcasting || isMining,
  }
}
