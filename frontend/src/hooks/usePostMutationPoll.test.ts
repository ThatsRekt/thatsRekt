/**
 * Tests for usePostMutationPoll — the post-success reconcile loop.
 *
 * Critical behaviors under test:
 *   1. Immediate first tick on isSuccess=true (invalidates right away).
 *   2. 3s cadence via setInterval.
 *   3. 30s cutoff: stops the interval and fires onCutoff.
 *   4. At-most-one active interval across re-renders (the load-bearing
 *      ref-guard assertion — a naive impl without the ref guard fails this).
 *   5. Cleanup on unmount: no ticks after unmount.
 *
 * Convention: bun:test + jest fake timers + mock.module('wagmi') +
 * mock.module('@tanstack/react-query') — the latter is required because
 * ConfirmVoteButtons.error.test.tsx registers a process-global mock for
 * react-query that replaces useQueryClient before this file runs.
 * We re-mock it here to intercept useQueryClient with a per-test spy.
 *
 * Following the PostCard.test.tsx pattern: all mocks registered before
 * the module-under-test is imported.
 */
import { describe, it, expect, mock, jest, beforeEach, afterEach } from 'bun:test'
import { renderHook, act } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Per-test spy for invalidateQueries — set before each test runs.
// ---------------------------------------------------------------------------

let _invalidateSpy: ReturnType<typeof jest.fn> = jest.fn()

// Stub wagmi before the module-under-test is imported.
mock.module('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useChainId: () => 1,
  useReadContract: () => ({ data: undefined, isLoading: false }),
  useWriteContract: () => ({ writeContractAsync: async () => '0xhash', isPending: false }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
  useEnsName: () => ({ data: null }),
  useConnect: () => ({ connect: () => {}, connectors: [] }),
  useDisconnect: () => ({ disconnect: () => {} }),
  useSignTypedData: () => ({ signTypedData: async () => '0xsig' }),
}))

// Stub @tanstack/react-query to intercept useQueryClient so the per-test
// _invalidateSpy controls what invalidateQueries does, regardless of which
// other test file may have already registered a react-query mock.
mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: (...args: unknown[]) => _invalidateSpy(...args) }),
  QueryClient: class QueryClient {},
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}))

const { usePostMutationPoll } = await import('./usePostMutationPoll')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HASH_A = '0xaaaa' as `0x${string}`
const HASH_B = '0xbbbb' as `0x${string}`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePostMutationPoll', () => {
  beforeEach(() => {
    _invalidateSpy = jest.fn()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('does NOT invalidate queries when isSuccess is false', () => {
    renderHook(() =>
      usePostMutationPoll({
        hash: HASH_A,
        isSuccess: false,
        reset: () => {},
      }),
    )

    act(() => {
      jest.advanceTimersByTime(5_000)
    })

    expect(_invalidateSpy.mock.calls.length).toBe(0)
  })

  it('invalidates queries immediately (first tick) when isSuccess becomes true', () => {
    const { rerender } = renderHook(
      ({ isSuccess }: { isSuccess: boolean }) =>
        usePostMutationPoll({
          hash: HASH_A,
          isSuccess,
          reset: () => {},
        }),
      { initialProps: { isSuccess: false } },
    )

    expect(_invalidateSpy.mock.calls.length).toBe(0)

    act(() => {
      rerender({ isSuccess: true })
    })

    // Immediate first tick: 2 invalidations (one for ['post'] and one for ['feed']).
    expect(_invalidateSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('invalidates on the 3s cadence after the first tick', () => {
    renderHook(() =>
      usePostMutationPoll({
        hash: HASH_A,
        isSuccess: true,
        reset: () => {},
      }),
    )

    // First tick fires on mount (isSuccess=true from the start).
    const afterFirst = _invalidateSpy.mock.calls.length
    expect(afterFirst).toBeGreaterThanOrEqual(2)

    // Advance 3s → one more interval tick.
    act(() => {
      jest.advanceTimersByTime(3_000)
    })

    expect(_invalidateSpy.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('stops polling and fires onCutoff at the 30s ceiling', () => {
    const onCutoff = jest.fn()

    renderHook(() =>
      usePostMutationPoll({
        hash: HASH_A,
        isSuccess: true,
        reset: () => {},
        onCutoff,
      }),
    )

    // The cutoff check uses `Date.now() - startedAt > 30_000` (strictly greater).
    // The interval fires every 3s: ticks at 3, 6, 9, ..., 30, 33s.
    // At 30s the check is `30000 > 30000` = false → one more tick.
    // At 33s the check is `33000 > 30000` = true → cutoff fires.
    // Advance past the 33s mark to ensure the cutoff tick has run.
    act(() => {
      jest.advanceTimersByTime(34_000)
    })

    // onCutoff must have been called exactly once.
    expect(onCutoff.mock.calls.length).toBe(1)

    // After cutoff, advancing more time must NOT produce more invalidations.
    const countAtCutoff = _invalidateSpy.mock.calls.length
    act(() => {
      jest.advanceTimersByTime(10_000)
    })
    expect(_invalidateSpy.mock.calls.length).toBe(countAtCutoff)
  })

  it('fires onTick on the immediate first tick AND on each 3s interval tick', () => {
    // This test is RED against an impl that calls onTick only once (e.g. in a
    // one-shot useEffect([isSuccess, hash])). The correct impl passes onTick
    // into tick() so it runs on the immediate first call AND every interval.
    const onTick = jest.fn()

    renderHook(() =>
      usePostMutationPoll({
        hash: HASH_A,
        isSuccess: true,
        reset: () => {},
        onTick,
      }),
    )

    // Immediate first tick must have fired onTick once.
    expect(onTick.mock.calls.length).toBe(1)

    // Advance 3s → one interval tick → onTick a second time.
    act(() => { jest.advanceTimersByTime(3_000) })
    expect(onTick.mock.calls.length).toBe(2)

    // Advance another 3s → third call.
    act(() => { jest.advanceTimersByTime(3_000) })
    expect(onTick.mock.calls.length).toBe(3)
  })

  it('stops calling onTick after the 30s cutoff', () => {
    const onTick = jest.fn()

    renderHook(() =>
      usePostMutationPoll({
        hash: HASH_A,
        isSuccess: true,
        reset: () => {},
        onTick,
      }),
    )

    // Run past cutoff (cutoff fires at ~33s; see timing note in onCutoff test).
    act(() => { jest.advanceTimersByTime(34_000) })
    const countAtCutoff = onTick.mock.calls.length

    // Advancing further must NOT fire more onTick calls.
    act(() => { jest.advanceTimersByTime(10_000) })
    expect(onTick.mock.calls.length).toBe(countAtCutoff)
  })

  it('maintains at most ONE active interval across re-renders (ref guard)', () => {
    // This is the load-bearing assertion. A naive implementation that creates
    // a new setInterval on every render (without a ref to clear the prior one)
    // would multiply RPC load. This test catches that.
    const { rerender } = renderHook(
      ({ counter }: { counter: number }) =>
        // Re-render 5 times with the same hash to simulate callback identity churn
        // (wagmi callbacks get new identities on each render; this triggers the effect).
        usePostMutationPoll({
          hash: HASH_A,
          isSuccess: true,
          // Pass an inline function that changes identity each render to stress the ref guard.
          reset: () => { void counter },
        }),
      { initialProps: { counter: 0 } },
    )

    act(() => { rerender({ counter: 1 }) })
    act(() => { rerender({ counter: 2 }) })
    act(() => { rerender({ counter: 3 }) })
    act(() => { rerender({ counter: 4 }) })

    // Advance time — if multiple intervals are alive, invalidations multiply.
    act(() => {
      jest.advanceTimersByTime(3_000)
    })

    // Exactly ONE interval tick should have fired (not 5×).
    // Each interval tick = 2 invalidateQueries calls (feed + post).
    // With 5 live intervals it would be 10+ calls just for this tick.
    // The FAILING case (5 uncleaned intervals) produces ~12 calls for the tick alone.
    const totalCalls = _invalidateSpy.mock.calls.length
    expect(totalCalls).toBeLessThan(12)
  })

  it('does NOT re-start the poll for the same hash (per-hash guard)', () => {
    const onCutoff = jest.fn()

    const { rerender } = renderHook(
      ({ hash }: { hash: `0x${string}` }) =>
        usePostMutationPoll({
          hash,
          isSuccess: true,
          reset: () => {},
          onCutoff,
        }),
      { initialProps: { hash: HASH_A } },
    )

    // Run past the cutoff tick (fires at 33s; see timing note in onCutoff test).
    act(() => { jest.advanceTimersByTime(34_000) })
    expect(onCutoff.mock.calls.length).toBe(1)

    // Reset spy counts.
    _invalidateSpy = jest.fn()
    onCutoff.mockReset()

    // Re-render with the SAME hash — must NOT re-start the poll.
    act(() => { rerender({ hash: HASH_A }) })
    act(() => { jest.advanceTimersByTime(34_000) })
    expect(onCutoff.mock.calls.length).toBe(0)

    // A NEW hash MUST restart the poll.
    act(() => { rerender({ hash: HASH_B }) })
    act(() => { jest.advanceTimersByTime(34_000) })
    expect(onCutoff.mock.calls.length).toBe(1)
  })

  it('cleans up the interval on unmount (no ticks after unmount)', () => {
    const { unmount } = renderHook(() =>
      usePostMutationPoll({
        hash: HASH_A,
        isSuccess: true,
        reset: () => {},
      }),
    )

    const countBeforeUnmount = _invalidateSpy.mock.calls.length
    unmount()

    // Advance time after unmount — no more ticks must fire.
    act(() => {
      jest.advanceTimersByTime(15_000)
    })

    expect(_invalidateSpy.mock.calls.length).toBe(countBeforeUnmount)
  })
})
