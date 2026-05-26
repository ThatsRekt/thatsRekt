/**
 * Component tests for ConfirmVoteButtons error display.
 *
 * Verifies that when `useConfirmPost` returns a non-null `error`, the
 * component renders an inline error string so the user can see what
 * went wrong (fixes the silent no-op regression described in #138).
 *
 * Wagmi hooks are mocked at module level — error state is injected via
 * useWriteContract().error, which useConfirmPost surfaces as its own `error`
 * field. The real useConfirmPost hook runs here (no hook-level mock) so that
 * useConfirmPost.test.ts can import the real hook without interference
 * regardless of test file execution order.
 */
import { describe, expect, test, mock, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'

// ---------------------------------------------------------------------------
// Mutable wagmi mock state — error is injected via useWriteContract.
// ---------------------------------------------------------------------------

let mockBroadcastError: Error | null = null

// Minimal wagmi mocks. useWriteContract.error drives the error display path.
mock.module('wagmi', () => ({
  useAccount: () => ({
    address: '0xdeadbeef00000000000000000000000000000001' as `0x${string}`,
    isConnected: true,
    chainId: 1,
  }),
  useWriteContract: () => ({
    writeContract: mock(() => undefined),
    data: undefined,
    isPending: false,
    error: mockBroadcastError,
    reset: mock(() => undefined),
  }),
  useWaitForTransactionReceipt: () => ({
    isLoading: false,
    isSuccess: false,
    error: null,
  }),
  useSwitchChain: () => ({
    switchChainAsync: mock(() => Promise.resolve()),
    isPending: false,
  }),
}))

// Mock hooks that touch chain / contract state — not needed for error display.
mock.module('../src/hooks/useIsWhitelisted', () => ({
  useIsWhitelisted: () => ({ isWhitelisted: true, isLoading: false }),
}))

mock.module('../src/hooks/useUserVote', () => ({
  useUserVote: () => ({
    direction: 0,
    isUp: false,
    isDown: false,
    refetch: mock(() => Promise.resolve()),
  }),
}))

mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: mock(() => Promise.resolve()),
  }),
}))

mock.module('../src/components/WhitelistGateModal', () => ({
  WhitelistGateModal: () => null,
}))

// ---------------------------------------------------------------------------
// Import component AFTER mocks are registered.
// ---------------------------------------------------------------------------
// eslint-disable-next-line import/first
import { ConfirmVoteButtons } from '../src/components/ConfirmVoteButtons'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderButtons(props: Partial<Parameters<typeof ConfirmVoteButtons>[0]> = {}) {
  return render(
    React.createElement(ConfirmVoteButtons, {
      chainId: 1,
      postId: 7n,
      upCount: 3,
      downCount: 1,
      posterAddress: '0x0000000000000000000000000000000000000002',
      ...props,
    }),
  )
}

afterEach(() => {
  mockBroadcastError = null
  cleanup()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfirmVoteButtons — error display', () => {
  test('renders no error element when error is null', () => {
    mockBroadcastError = null
    renderButtons()
    expect(screen.queryByTestId('vote-error')).toBeNull()
  })

  test('renders inline error when useWriteContract returns a non-null error', () => {
    const err = Object.assign(new Error('nonce too low'), {
      shortMessage: 'nonce too low',
    })
    mockBroadcastError = err

    renderButtons()

    const errorEl = screen.getByTestId('vote-error')
    expect(errorEl).not.toBeNull()
    expect(errorEl.textContent).toContain('nonce too low')
  })

  test('prefers shortMessage over message when available', () => {
    const err = Object.assign(new Error('ContractFunctionExecutionError: long message here'), {
      shortMessage: 'chain mismatch',
    })
    mockBroadcastError = err

    renderButtons()

    const errorEl = screen.getByTestId('vote-error')
    expect(errorEl.textContent).toContain('chain mismatch')
    expect(errorEl.textContent).not.toContain('ContractFunctionExecutionError')
  })

  test('falls back to error.message when shortMessage is absent', () => {
    const err = new Error('user rejected transaction')
    mockBroadcastError = err

    renderButtons()

    const errorEl = screen.getByTestId('vote-error')
    expect(errorEl.textContent).toContain('user rejected transaction')
  })

  test('error element has role=alert for screen readers', () => {
    const err = new Error('tx failed')
    mockBroadcastError = err

    renderButtons()

    const errorEl = screen.getByRole('alert')
    expect(errorEl).not.toBeNull()
  })
})
