/**
 * usePostMutationPoll — generic post-success reconcile loop for registry mutations.
 *
 * After a mutation tx confirms (`isSuccess=true`), invalidates the `['post']`
 * and `['feed']` TanStack queries on an immediate-first-tick 3s cadence for up
 * to a 30s cutoff.
 *
 * Design notes:
 *
 * **Ref-guarded single interval.** The interval id lives in a ref so that
 * re-fires of this effect — triggered when unstable callback identities (e.g.
 * wagmi's `reset`) get new references each render — can clear the PRIOR interval
 * before starting a new one. Without this guard, each re-render would spawn a
 * second interval alongside the first, multiplying RPC load on every tick.
 *
 * **Per-hash guard.** `lastSuccessHash` tracks the hash we already started a
 * poll for. Repeated re-renders with the same `hash` do NOT restart the loop.
 *
 * **Deferred reset.** Calling `reset()` synchronously inside the effect would
 * cause wagmi to flip `isSuccess` back to `false` immediately, which fights the
 * hash guard on the next render. We defer via `setTimeout(..., 0)`.
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

const POLL_INTERVAL_MS = 3_000
const POLL_CUTOFF_MS = 30_000

export interface UsePostMutationPollOptions {
  /** Transaction hash returned by wagmi after the tx is sent. */
  hash: `0x${string}` | undefined
  /** `true` once the transaction receipt has been received (wagmi `isSuccess`). */
  isSuccess: boolean
  /** Wagmi's `reset()` for the write hook — deferred to avoid fighting the hash guard. */
  reset: () => void
  /**
   * Optional callback fired on EVERY tick: the immediate first tick and each
   * subsequent 3s interval tick, up to the 30s cutoff.
   *
   * Use this for per-tick side effects whose query key is NOT touched by the
   * `['post']`/`['feed']` invalidations — e.g. `refetchUserVote`, which reads
   * `confirmationOf` directly from chain on its own query key. Passing it here
   * preserves the original ≤3s correction window instead of the one-shot
   * semantics of a `useEffect([isSuccess, hash])`.
   */
  onTick?: () => void
  /**
   * Optional callback fired when the 30s cutoff is reached.
   * Use this to clear any optimistic overlay so the UI reflects real server state.
   */
  onCutoff?: () => void
}

export function usePostMutationPoll({
  hash,
  isSuccess,
  reset,
  onTick,
  onCutoff,
}: UsePostMutationPollOptions): void {
  const queryClient = useQueryClient()
  const lastSuccessHash = useRef<`0x${string}` | undefined>(undefined)
  const pollIntervalRef = useRef<ReturnType<typeof globalThis.setInterval> | null>(null)

  useEffect(() => {
    // Always clear any prior interval first — guarantees at most one poller is
    // active regardless of how many times this effect re-fires due to unstable
    // callback identities.
    if (pollIntervalRef.current !== null) {
      globalThis.clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }

    if (!isSuccess || !hash || lastSuccessHash.current === hash) return
    lastSuccessHash.current = hash

    const startedAt = Date.now()

    const tick = () => {
      void queryClient.invalidateQueries({ queryKey: ['post'] })
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      onTick?.()
    }

    // Immediate first tick — surface indexer updates ASAP without waiting 3s.
    tick()

    pollIntervalRef.current = globalThis.setInterval(() => {
      if (Date.now() - startedAt > POLL_CUTOFF_MS) {
        if (pollIntervalRef.current !== null) {
          globalThis.clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        onCutoff?.()
        return
      }
      tick()
    }, POLL_INTERVAL_MS)

    // Defer reset() so wagmi's isSuccess stays `true` through the current render
    // cycle, preventing the hash guard from inadvertently re-running.
    const tReset = globalThis.setTimeout(() => reset(), 0)

    return () => {
      if (pollIntervalRef.current !== null) {
        globalThis.clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      globalThis.clearTimeout(tReset)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess, hash, queryClient, reset, onTick, onCutoff])
}
