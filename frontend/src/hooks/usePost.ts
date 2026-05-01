import { useCallback, useState } from 'react'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import {
  registryAbi,
  registryAddress,
  type SupportedChainId,
} from '../lib/contracts'
import { requiredConfirmations } from '../lib/chains'

/**
 * Inputs for `submit()`. The hook does NOT do field-level validation
 * (length, address checksum, timestamp upper bound) — that's the form's
 * job. The hook trusts that whatever it's handed will at least be the
 * right *shape*, and otherwise propagates whatever revert / reject the
 * wallet or chain returns.
 */
export interface PostSubmitParams {
  /** Chain to broadcast on. Must be a chain with a deployed registry. */
  chainId: number
  /** Required, 1..200 bytes (UTF-8). */
  title: string
  /** May be empty. Each entry must be a valid 0x-prefixed checksum or lowercase address. */
  attackers: readonly `0x${string}`[]
  /** May be empty. Same validation as attackers. */
  victims: readonly `0x${string}`[]
  /** May be empty. Free-form. */
  note: string
  /** Unix seconds, > 0, <= now. */
  attackedAt: bigint
}

/**
 * Submits a `post(...)` tx to the registry on the chosen chain, then
 * waits for the receipt. Two-stage hook (mirrors `useConfirmPost`):
 *
 *   1. `submit({ chainId, title, attackers, victims, note, attackedAt })`
 *      fires the wallet popup. While the user is signing and the tx is
 *      propagating, `isBroadcasting` is true and `hash` is undefined.
 *      Once broadcast, `hash` is set.
 *   2. After broadcast, `useWaitForTransactionReceipt` polls the chain
 *      that the tx was submitted on. While polling, `isMining` is true.
 *      On success, `isSuccess` flips true.
 *
 * Multi-chain: the chosen `chainId` is captured in component state so
 * the receipt waiter polls the right chain. wagmi automatically prompts
 * the wallet to switch chains if needed.
 *
 * The hook does NOT invalidate any TanStack queries on its own — the
 * caller passes its own success callback because cache shape (which
 * `['feed', ...]` keys exist) is owned by the page, not this hook.
 */
export function usePost(): {
  submit: (params: PostSubmitParams) => void
  reset: () => void
  hash: `0x${string}` | undefined
  isBroadcasting: boolean
  isMining: boolean
  isSuccess: boolean
  isPending: boolean
  error: Error | null
  submittedChainId: number | undefined
} {
  const {
    writeContract,
    data: hash,
    isPending: isBroadcasting,
    error: broadcastError,
    reset: resetWrite,
  } = useWriteContract()

  // Track which chain the in-flight tx was submitted on so the receipt
  // waiter polls the right RPC. Reset when `reset()` is called. Narrowed
  // to `SupportedChainId` because we validate the chain in `submit`
  // before storing it.
  const [submittedChainId, setSubmittedChainId] = useState<
    SupportedChainId | undefined
  >(undefined)

  // Chain-aware "truly confirmed" threshold. L2s flip green at 1 block;
  // L1 mainnet waits for 3. See `requiredConfirmations` for the table.
  // When `submittedChainId` is undefined (no tx in flight) the
  // confirmations value is irrelevant — wagmi won't poll without a hash.
  const confirmations = submittedChainId
    ? requiredConfirmations(submittedChainId)
    : 1

  const {
    isLoading: isMining,
    isSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash,
    chainId: submittedChainId,
    confirmations,
  })

  const submit = useCallback(
    (params: PostSubmitParams) => {
      const { chainId, title, attackers, victims, note, attackedAt } = params

      const address = registryAddress(chainId)
      // Programmer error: UI should never offer an unsupported chain.
      // Failing loud here beats a confusing wallet error two screens later.
      if (!address) {
        throw new Error(
          `usePost: no registry deployed on chainId ${chainId}. ` +
            `Use chainsWithRegistry() to gate the chain selector.`,
        )
      }

      // Once we've confirmed `registryAddress(chainId)` resolved, we know
      // chainId is a key in REGISTRY_PROXIES — i.e. a SupportedChainId.
      const supportedChainId = chainId as SupportedChainId
      setSubmittedChainId(supportedChainId)
      writeContract({
        address,
        abi: registryAbi,
        functionName: 'post',
        args: [title, attackers, victims, note, attackedAt],
        chainId: supportedChainId,
      })
    },
    [writeContract],
  )

  const reset = useCallback(() => {
    setSubmittedChainId(undefined)
    resetWrite()
  }, [resetWrite])

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
    submittedChainId,
  }
}
