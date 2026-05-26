/**
 * Tests for useConfirmPost — drives the real hook via renderHook.
 *
 * Wagmi is mocked at the module boundary so we never need a real chain
 * connection. The real hook is exercised through renderHook; the test
 * drives submit() and asserts on the mocked wagmi primitives
 * (writeContract, switchChainAsync) to verify the chain-switch logic.
 *
 * Scenarios covered:
 *   1. Happy path — chains match, vote action fires writeContract directly.
 *   2. Chain mismatch — switchChainAsync called first, then writeContract.
 *   3. User rejects chain switch — submit resolves false, no writeContract.
 *   4. Rejection does not throw — resolves to false, not rejects.
 *   5. Clear action — writeContract called with functionName 'unconfirm'.
 *   6. No registry for chainId — submit rejects with a descriptive error.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { renderHook, act } from '@testing-library/react'
import type { ConfirmAction } from '../src/hooks/useConfirmPost'

// ---------------------------------------------------------------------------
// Mutable mock state — set per test before renderHook is called.
// ---------------------------------------------------------------------------

let mockConnectedChainId: number | undefined = 1

// Per-test mock functions — replaced in beforeEach so call counts don't leak.
let mockWriteContract = mock(() => undefined)
let mockSwitchChainAsync = mock(() => Promise.resolve())
let mockReset = mock(() => undefined)

// ---------------------------------------------------------------------------
// Module-level wagmi mock — registered before any other imports that touch
// wagmi. The factory functions reference the mutable variables above so each
// test can reconfigure without re-registering the mock.
// ---------------------------------------------------------------------------
mock.module('wagmi', () => ({
  useAccount: () => ({ chainId: mockConnectedChainId }),
  useWriteContract: () => ({
    writeContract: mockWriteContract,
    data: undefined,
    isPending: false,
    error: null,
    reset: mockReset,
  }),
  useWaitForTransactionReceipt: () => ({
    isLoading: false,
    isSuccess: false,
    error: null,
  }),
  useSwitchChain: () => ({
    switchChainAsync: mockSwitchChainAsync,
    isPending: false,
  }),
}))

// Import AFTER mocks are registered.
import { useConfirmPost } from '../src/hooks/useConfirmPost'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POST_ID = 7n
const VOTE_ACTION: ConfirmAction = { kind: 'vote', direction: 1 }
const CLEAR_ACTION: ConfirmAction = { kind: 'clear' }

beforeEach(() => {
  // Fresh mocks for each test — prevents call-count bleed between scenarios.
  mockWriteContract = mock(() => undefined)
  mockSwitchChainAsync = mock(() => Promise.resolve())
  mockReset = mock(() => undefined)
  mockConnectedChainId = 1
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useConfirmPost — real hook via renderHook', () => {
  test('calls writeContract directly when chains match (no switch needed)', async () => {
    mockConnectedChainId = 1

    const { result } = renderHook(() => useConfirmPost(1))

    let returned: boolean = false
    await act(async () => {
      returned = await result.current.submit({ postId: POST_ID, action: VOTE_ACTION })
    })

    expect(returned).toBe(true)
    expect(mockWriteContract).toHaveBeenCalledTimes(1)
    expect(mockSwitchChainAsync).toHaveBeenCalledTimes(0)
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'confirm', args: [POST_ID, 1] }),
    )
  })

  test('calls switchChainAsync before writeContract when chains differ', async () => {
    mockConnectedChainId = 84532 // Base Sepolia — wrong chain

    const callOrder: string[] = []
    mockWriteContract = mock(() => { callOrder.push('writeContract') })
    mockSwitchChainAsync = mock(() => {
      callOrder.push('switchChainAsync')
      return Promise.resolve()
    })

    const { result } = renderHook(() => useConfirmPost(1))

    let returned: boolean = false
    await act(async () => {
      returned = await result.current.submit({ postId: POST_ID, action: VOTE_ACTION })
    })

    expect(returned).toBe(true)
    expect(mockSwitchChainAsync).toHaveBeenCalledTimes(1)
    expect(mockSwitchChainAsync).toHaveBeenCalledWith({ chainId: 1 })
    expect(mockWriteContract).toHaveBeenCalledTimes(1)
    // Order matters: switch must precede write.
    expect(callOrder).toEqual(['switchChainAsync', 'writeContract'])
  })

  test('returns false and skips writeContract when user rejects chain switch', async () => {
    mockConnectedChainId = 84532
    mockSwitchChainAsync = mock(() => Promise.reject(new Error('User rejected')))

    const { result } = renderHook(() => useConfirmPost(1))

    let returned: boolean = true
    await act(async () => {
      returned = await result.current.submit({ postId: POST_ID, action: VOTE_ACTION })
    })

    expect(returned).toBe(false)
    expect(mockSwitchChainAsync).toHaveBeenCalledTimes(1)
    expect(mockWriteContract).toHaveBeenCalledTimes(0)
  })

  test('resolves (does not throw) when user rejects chain switch', async () => {
    mockConnectedChainId = 84532
    mockSwitchChainAsync = mock(() => Promise.reject(new Error('User rejected')))

    const { result } = renderHook(() => useConfirmPost(1))

    // Must resolve to false — rejection is expected user input, not an error.
    await act(async () => {
      await expect(
        result.current.submit({ postId: POST_ID, action: VOTE_ACTION }),
      ).resolves.toBe(false)
    })
  })

  test('calls unconfirm writeContract for clear action', async () => {
    mockConnectedChainId = 8453

    const { result } = renderHook(() => useConfirmPost(8453))

    await act(async () => {
      await result.current.submit({ postId: POST_ID, action: CLEAR_ACTION })
    })

    expect(mockWriteContract).toHaveBeenCalledTimes(1)
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'unconfirm', args: [POST_ID] }),
    )
  })

  test('passes correct direction arg when voting down', async () => {
    mockConnectedChainId = 8453

    const { result } = renderHook(() => useConfirmPost(8453))

    await act(async () => {
      await result.current.submit({ postId: POST_ID, action: { kind: 'vote', direction: 2 } })
    })

    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'confirm', args: [POST_ID, 2] }),
    )
  })

  test('throws when chainId has no deployed registry', async () => {
    // 999 is not a supported chain — bypasses TypeScript via cast.
    mockConnectedChainId = 999

    const { result } = renderHook(() => useConfirmPost(999 as 1))

    await act(async () => {
      await expect(
        result.current.submit({ postId: POST_ID, action: VOTE_ACTION }),
      ).rejects.toThrow(/No registry deployed for chainId 999/)
    })
  })
})
