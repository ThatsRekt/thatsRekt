import { useCallback } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
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
 *   1. `submit({ postId, action })` — async. If the connected wallet is on
 *      a different chain than `chainId`, it first prompts the user to switch
 *      chains (via `useSwitchChain`). If the user rejects the switch, the
 *      promise resolves without calling the wallet (nothing to revert — no
 *      optimistic overlay was applied yet). Once the chain is correct, it
 *      fires the wallet popup for signing. While the user is signing and the
 *      tx is propagating, `isBroadcasting` is true and `hash` is undefined.
 *      Once broadcast, `hash` is set.
 *   2. After broadcast, `useWaitForTransactionReceipt` polls. While polling,
 *      `isMining` is true. On success, `isSuccess` flips true.
 *
 * The hook is parameterised on `chainId` (one of `SupportedChainId`) so the
 * tx lands on the correct registry contract — voting on a Base Sepolia post
 * must hit the Sepolia proxy, not the Base mainnet one. If the wallet is on
 * a different chain, `submit` auto-switches before firing the tx.
 *
 * The hook does NOT invalidate any TanStack queries on its own — the caller
 * passes its own success callback because cache shape (which `['feed', ...]`
 * keys exist) is owned by the page, not this hook.
 */
export function useConfirmPost(chainId: SupportedChainId) {
  const { chainId: connectedChainId } = useAccount()
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain()

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
    /**
     * Returns `true` if `writeContract` was called (chain switch accepted or
     * not needed), `false` if the user rejected the chain switch (no tx
     * submitted). Callers use the return value to decide whether to apply
     * optimistic UI — avoid showing a stale overlay when the switch was
     * cancelled.
     */
    async (params: { postId: bigint; action: ConfirmAction }): Promise<boolean> => {
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

      // Auto-switch the wallet to the post's chain if needed. If the user
      // rejects the switch prompt, bail cleanly — no error thrown to the
      // caller (rejection is expected user input; the caller has not yet
      // applied any optimistic overlay, so there is nothing to revert).
      if (connectedChainId !== chainId) {
        try {
          await switchChainAsync({ chainId })
        } catch {
          return false
        }
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
        return true
      }

      writeContract({
        address,
        abi: registryAbi,
        functionName: 'unconfirm',
        args: [postId],
        chainId,
      })
      return true
    },
    [writeContract, chainId, connectedChainId, switchChainAsync],
  )

  return {
    submit,
    reset,
    hash,
    isBroadcasting,
    isMining,
    /** True while the wallet's chain-switch prompt is open. */
    isSwitching,
    isSuccess,
    // Surface whichever stage failed; receipt errors only fire post-broadcast,
    // so `broadcastError` (rejection / chain mismatch / sim failure) takes
    // precedence in the early flow.
    error: broadcastError ?? receiptError ?? null,
    /** Convenience: any "in flight" state — chain switch, wallet popup, OR mining. */
    isPending: isBroadcasting || isMining || isSwitching,
  }
}
