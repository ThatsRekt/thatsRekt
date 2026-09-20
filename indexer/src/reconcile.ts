/**
 * Post-hoc drift correction for `Post.confirmations` / `Post.disconfirmations`.
 *
 * `handleConfirmed` (main.ts) maintains these as a running counter, applying
 * `oldDirection`/`newDirection` deltas taken straight from each `Confirmed`
 * event. That delta is always truthful about the transition it describes,
 * but the running total is only correct if every prior `Confirmed` event for
 * that post was actually processed. If the indexer ever misses a single one
 * (a Portal ingestion gap, a reorg edge case, etc.), the total silently and
 * permanently desyncs from the contract's own counter — later confirm/
 * unconfirm cycles don't self-heal it, because their deltas are relative to
 * the *true* prior on-chain direction, not the indexer's (already wrong)
 * running total.
 *
 * This module closes that gap for one post at a time: after `handleConfirmed`
 * applies its delta, it asks the contract itself (`getPost`) what the count
 * should be and overwrites on mismatch. Bounded to one `eth_call` per
 * `Confirmed` event handled — proportional to event volume already being
 * processed, not a sweep over every post.
 *
 * Scope: this corrects `Post.confirmations`/`disconfirmations` only. Other
 * aggregates derived from the same per-event delta (`Proposer` lifetime
 * totals, `Address.attackerScore`) can carry the same drift and are not
 * corrected here — a deliberate scope cut, not an oversight. See the PR
 * description for the follow-up.
 */
import type { Logger } from '@subsquid/logger'
import { functions } from './abi/ThatsRekt'

export interface OnchainPostCounts {
  readonly confirmations: number
  readonly disconfirmations: number
}

export interface Reconciler {
  /**
   * Reads `getPost(postId).confirmations/.disconfirmations` from chain.
   * Returns `undefined` on any failure (no endpoint configured, timeout,
   * RPC error, malformed response) — reconciliation is a best-effort safety
   * net, never a reason to fail or block ingestion.
   */
  readonly fetchOnchainCounts: (postId: bigint) => Promise<OnchainPostCounts | undefined>
}

/** Always reports "unknown" — the safe default when no endpoint is configured. */
export const noopReconciler: Reconciler = {
  fetchOnchainCounts: async () => undefined,
}

export const createReconciler = ({
  rpcUrl,
  contractAddress,
  log,
  timeoutMs = 5_000,
  fetchImpl = fetch,
}: {
  readonly rpcUrl: string | undefined
  readonly contractAddress: string
  readonly log: Logger
  readonly timeoutMs?: number
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
}): Reconciler => {
  if (!rpcUrl) return noopReconciler

  const fetchOnchainCounts = async (postId: bigint): Promise<OnchainPostCounts | undefined> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [
            { to: contractAddress, data: functions.getPost.encode({ id: postId }) },
            'latest',
          ],
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        log.warn(
          { postId: postId.toString(), status: response.status },
          'Reconciliation eth_call got a non-OK HTTP status; skipping this post',
        )
        return undefined
      }

      const json = (await response.json()) as {
        result?: string
        error?: { message?: string }
      }
      if (json.error || typeof json.result !== 'string') {
        log.warn(
          { postId: postId.toString(), error: json.error },
          'Reconciliation eth_call returned an RPC error; skipping this post',
        )
        return undefined
      }

      const decoded = functions.getPost.decodeResult(json.result)
      return {
        confirmations: decoded.confirmations,
        disconfirmations: decoded.disconfirmations,
      }
    } catch (error) {
      log.warn(
        {
          postId: postId.toString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'Reconciliation eth_call errored; skipping this post',
      )
      return undefined
    } finally {
      clearTimeout(timeout)
    }
  }

  return { fetchOnchainCounts }
}
