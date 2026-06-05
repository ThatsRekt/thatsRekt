import { useCallback } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { registryAddress, registryAbi, type SupportedChainId } from '../lib/contracts'

/**
 * Submits a `retract(postId)` tx to the registry on behalf of the poster.
 *
 * Near-mirror of `useConfirmPost`. Two-stage flow:
 *
 *   1. `submit({ postId })` — async. If the connected wallet is on a different
 *      chain than `chainId`, it first prompts the user to switch chains. If the
 *      user rejects the switch, the promise resolves `false` without calling the
 *      wallet (nothing to revert — no tx was submitted). Once the chain is
 *      correct it fires the wallet popup. While the user is signing and the tx
 *      propagates, `isBroadcasting` is true and `hash` is undefined. Once
 *      broadcast, `hash` is set.
 *   2. After broadcast, `useWaitForTransactionReceipt` polls. While polling,
 *      `isMining` is true. On receipt, `isSuccess` flips true.
 *
 * The hook does NOT gate on whitelist status — `retract` only requires
 * `msg.sender == poster`. The caller (RetractPostButton) is responsible for
 * showing the button only to the connected poster.
 */
export function useRetractPost(chainId: SupportedChainId) {
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
  } = useWaitForTransactionReceipt({ hash, chainId })

  const submit = useCallback(
    /**
     * Returns `true` if `writeContract` was called (chain switch accepted or
     * not needed), `false` if the user rejected the chain switch.
     */
    async (params: { postId: bigint }): Promise<boolean> => {
      const { postId } = params
      const address = registryAddress(chainId)
      // Defensive: SupportedChainId is typed to ensure a registry exists,
      // but fail loudly if something slips through via a cast.
      if (!address) {
        throw new Error(`No registry deployed for chainId ${chainId}`)
      }

      // Auto-switch the wallet to the post's chain if needed. If the user
      // rejects, bail cleanly — no error thrown to the caller.
      if (connectedChainId !== chainId) {
        try {
          await switchChainAsync({ chainId })
        } catch {
          return false
        }
      }

      writeContract({
        address,
        abi: registryAbi,
        functionName: 'retract',
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
    // Broadcast errors (rejection / chain mismatch / sim failure) take
    // precedence; receipt errors only fire post-broadcast.
    error: broadcastError ?? receiptError ?? null,
    /** Convenience: any "in flight" state — chain switch, wallet popup, OR mining. */
    isPending: isBroadcasting || isMining || isSwitching,
  }
}
