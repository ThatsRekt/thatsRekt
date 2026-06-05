/**
 * Tests for useRetractPost.
 *
 * Covers:
 *   1. submit({ postId }) calls writeContract with the correct arguments.
 *   2. Chain-switch rejection → returns false and does NOT call writeContract.
 *
 * wagmi is mocked at the module boundary (bun:test mock.module convention).
 * We do NOT test onchain retract semantics — those live in the Foundry suite.
 */
import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'

// --- mutable state cells read dynamically by mock factories -----------------

let mockedConnectedChainId = 8453
let mockSwitchChainShouldReject = false

// These mocks are created once; their state is reset between tests via
// mockReset(). switchChainAsync uses an outer function that reads the
// `mockSwitchChainShouldReject` flag at CALL time (not at mock-creation time).
const mockWriteContract = mock(() => undefined)
const mockSwitchChainAsync = mock(async (_params: { chainId: number }) => {
  if (mockSwitchChainShouldReject) {
    throw new Error('user rejected chain switch')
  }
  return undefined
})

// --- wagmi mock -------------------------------------------------------------
// mock.module must be declared before any import of the module under test.

mock.module('wagmi', () => ({
  useAccount: () => ({
    address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as `0x${string}`,
    // Reads the mutable cell every time the hook is called (per render).
    chainId: mockedConnectedChainId,
    isConnected: true,
  }),
  useWriteContract: () => ({
    writeContract: mockWriteContract,
    data: undefined as `0x${string}` | undefined,
    isPending: false,
    error: null,
    reset: mock(() => undefined),
  }),
  useWaitForTransactionReceipt: () => ({
    isLoading: false,
    isSuccess: false,
    error: null,
  }),
  useSwitchChain: () => ({
    // Always return the same mock so bun:test can track calls. The mock
    // itself reads `mockSwitchChainShouldReject` at invocation time.
    switchChainAsync: mockSwitchChainAsync,
    isPending: false,
  }),
}))

// --- import AFTER mocks are registered ---------------------------------------
const { useRetractPost } = await import('./useRetractPost')

// --- test wrapper -----------------------------------------------------------

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return React.createElement(QueryClientProvider, { client: queryClient }, children)
}

// ---------------------------------------------------------------------------

describe('useRetractPost', () => {
  beforeEach(() => {
    mockWriteContract.mockReset()
    // Don't reset mockSwitchChainAsync — it reads the `mockSwitchChainShouldReject`
    // flag at call time, so resetting its implementation would break the rejection
    // test. Clear call records only.
    mockSwitchChainAsync.mock.calls.length = 0
    mockSwitchChainAsync.mock.results.length = 0
    mockedConnectedChainId = 8453
    mockSwitchChainShouldReject = false
  })

  it('calls writeContract with functionName "retract", correct args, address, and chainId', async () => {
    const { result } = renderHook(() => useRetractPost(8453), { wrapper })
    let submitted: boolean | undefined

    await act(async () => {
      submitted = await result.current.submit({ postId: 42n })
    })

    expect(submitted).toBe(true)
    expect(mockWriteContract).toHaveBeenCalledTimes(1)

    const call = mockWriteContract.mock.calls[0][0] as {
      functionName: string
      args: bigint[]
      chainId: number
      address: string
    }
    expect(call.functionName).toBe('retract')
    expect(call.args).toEqual([42n])
    expect(call.chainId).toBe(8453)
    // Canonical v1.2.0 proxy address on Base mainnet
    expect(call.address).toBe('0xBfaEEE9662b4c037De24e5Caa65815350d57b89A')
  })

  it('passes the correct postId in args when postId differs', async () => {
    const { result } = renderHook(() => useRetractPost(8453), { wrapper })

    await act(async () => {
      await result.current.submit({ postId: 99n })
    })

    expect(mockWriteContract).toHaveBeenCalledTimes(1)
    const call = mockWriteContract.mock.calls[0][0] as { args: bigint[] }
    expect(call.args).toEqual([99n])
  })

  it('does NOT call switchChainAsync when connected chain matches target chain', async () => {
    mockedConnectedChainId = 8453
    const { result } = renderHook(() => useRetractPost(8453), { wrapper })

    await act(async () => {
      await result.current.submit({ postId: 1n })
    })

    expect(mockSwitchChainAsync).not.toHaveBeenCalled()
    expect(mockWriteContract).toHaveBeenCalledTimes(1)
  })

  it('calls switchChainAsync when connected chain differs from target chain', async () => {
    mockedConnectedChainId = 1 // ethereum mainnet; hook targets base (8453)
    const { result } = renderHook(() => useRetractPost(8453), { wrapper })

    await act(async () => {
      await result.current.submit({ postId: 1n })
    })

    expect(mockSwitchChainAsync).toHaveBeenCalledWith({ chainId: 8453 })
    expect(mockWriteContract).toHaveBeenCalledTimes(1)
  })

  it('returns false and does NOT call writeContract when user rejects chain switch', async () => {
    mockedConnectedChainId = 1
    mockSwitchChainShouldReject = true

    const { result } = renderHook(() => useRetractPost(8453), { wrapper })
    let submitted: boolean | undefined

    await act(async () => {
      submitted = await result.current.submit({ postId: 1n })
    })

    expect(submitted).toBe(false)
    expect(mockWriteContract).not.toHaveBeenCalled()
  })
})
