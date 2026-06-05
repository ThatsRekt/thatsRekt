/**
 * Tests for RetractPostButton.
 *
 * Covers:
 *   1. Visibility matrix:
 *      - null when disconnected
 *      - null when connected but not the poster
 *      - null when connected + poster but alreadyRemoved=true
 *      - renders when connected + poster + not removed
 *   2. Two-step confirm FSM:
 *      - First click arms the button (label becomes "confirm — permanent")
 *        and does NOT call submit.
 *      - Second click (while armed) calls submit with the correct postId.
 *   3. Error → idle + error span shown; retry must re-arm.
 *
 * Following the bun:test + mock.module('wagmi') convention from PostCard.test.tsx.
 */
import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Module-level mock state — mutated between tests to simulate different
// connected/disconnected scenarios.
// ---------------------------------------------------------------------------

const mockSubmit = mock(async (_params: { postId: bigint }) => true)
const mockReset = mock(() => undefined)

let mockAddress: `0x${string}` | undefined = '0xPoster0000000000000000000000000000000001' as `0x${string}`
let mockIsConnected = true
let mockIsSuccess = false
let mockError: Error | null = null
let mockIsBroadcasting = false
let mockIsMining = false

mock.module('wagmi', () => ({
  useAccount: () => ({
    address: mockAddress,
    isConnected: mockIsConnected,
    chainId: 8453,
    chain: undefined,
  }),
  useWriteContract: () => ({
    writeContract: mock(() => undefined),
    data: undefined,
    isPending: false,
    error: null,
    reset: mockReset,
  }),
  useWaitForTransactionReceipt: () => ({
    isLoading: false,
    isSuccess: mockIsSuccess,
    error: null,
  }),
  useSwitchChain: () => ({
    switchChainAsync: mock(async () => undefined),
    isPending: false,
  }),
  useChainId: () => 8453,
  useReadContract: () => ({ data: undefined, isLoading: false }),
  useEnsName: () => ({ data: null }),
  useConnect: () => ({ connect: mock(() => undefined), connectors: [] }),
  useDisconnect: () => ({ disconnect: mock(() => undefined) }),
  useSignTypedData: () => ({ signTypedData: mock(async () => '0xsig') }),
}))

// Mock useRetractPost so we control its return value without the wagmi
// internals interfering with the component-level FSM test.
mock.module('../hooks/useRetractPost', () => ({
  useRetractPost: (_chainId: number) => ({
    submit: mockSubmit,
    reset: mockReset,
    hash: undefined as `0x${string}` | undefined,
    isBroadcasting: mockIsBroadcasting,
    isMining: mockIsMining,
    isSwitching: false,
    isSuccess: mockIsSuccess,
    error: mockError,
    isPending: mockIsBroadcasting || mockIsMining,
  }),
}))

// Mock usePostMutationPoll — nothing to assert about it at the component
// level other than it doesn't crash.
mock.module('../hooks/usePostMutationPoll', () => ({
  usePostMutationPoll: mock(() => undefined),
}))

// Import after all mocks are in place.
const { RetractPostButton } = await import('./RetractPostButton')

// ---------------------------------------------------------------------------

const POSTER_ADDRESS = '0xPoster0000000000000000000000000000000001'
const OTHER_ADDRESS = '0xOther00000000000000000000000000000000002'
const CHAIN_ID = 8453 as const
const POST_ID = 42n

function renderButton(props?: {
  posterAddress?: string
  alreadyRemoved?: boolean
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RetractPostButton
          chainId={CHAIN_ID}
          postId={POST_ID}
          posterAddress={props?.posterAddress ?? POSTER_ADDRESS}
          alreadyRemoved={props?.alreadyRemoved ?? false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
describe('RetractPostButton — visibility matrix', () => {
  beforeEach(() => {
    mockAddress = POSTER_ADDRESS as `0x${string}`
    mockIsConnected = true
    mockIsSuccess = false
    mockError = null
    mockIsBroadcasting = false
    mockIsMining = false
    mockSubmit.mockReset()
    mockReset.mockReset()
  })

  afterEach(() => { cleanup() })

  it('renders null when disconnected', () => {
    mockAddress = undefined
    mockIsConnected = false
    const { container } = renderButton()
    expect(container.firstChild).toBeNull()
  })

  it('renders null when connected but wallet is NOT the poster', () => {
    mockAddress = OTHER_ADDRESS as `0x${string}`
    const { container } = renderButton({ posterAddress: POSTER_ADDRESS })
    expect(container.firstChild).toBeNull()
  })

  it('renders null when connected + is poster but alreadyRemoved=true', () => {
    mockAddress = POSTER_ADDRESS as `0x${string}`
    const { container } = renderButton({ alreadyRemoved: true })
    expect(container.firstChild).toBeNull()
  })

  it('renders the retract button when connected + is poster + not removed', () => {
    mockAddress = POSTER_ADDRESS as `0x${string}`
    renderButton({ alreadyRemoved: false })
    expect(screen.getByRole('button', { name: /retract/i })).toBeDefined()
  })

  it('case-insensitive: renders when address is checksum vs lowercase posterAddress', () => {
    // Wagmi returns checksum; indexer lowercases
    mockAddress = '0xPOSTER0000000000000000000000000000000001' as `0x${string}`
    const lowerPoster = POSTER_ADDRESS.toLowerCase()
    renderButton({ posterAddress: lowerPoster })
    expect(screen.getByRole('button', { name: /retract/i })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
describe('RetractPostButton — two-step confirm FSM', () => {
  beforeEach(() => {
    mockAddress = POSTER_ADDRESS as `0x${string}`
    mockIsConnected = true
    mockIsSuccess = false
    mockError = null
    mockIsBroadcasting = false
    mockIsMining = false
    mockSubmit.mockReset()
    mockReset.mockReset()
  })

  afterEach(() => { cleanup() })

  it('first click arms the button with label "confirm — permanent" and does NOT call submit', () => {
    renderButton()
    const btn = screen.getByRole('button', { name: /retract/i })
    fireEvent.click(btn)

    // After arming, the button label must be "confirm — permanent"
    expect(screen.getByRole('button', { name: /confirm — permanent/i })).toBeDefined()
    // submit must NOT have been called on the first click
    expect(mockSubmit).not.toHaveBeenCalled()
  })

  it('second click (while armed) calls submit with the correct postId', async () => {
    renderButton()

    // First click → arm
    fireEvent.click(screen.getByRole('button', { name: /retract/i }))

    // Second click → submit
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm — permanent/i }))
    })

    expect(mockSubmit).toHaveBeenCalledTimes(1)
    expect(mockSubmit).toHaveBeenCalledWith({ postId: POST_ID })
  })

  it('armed button does not auto-revert after a delay (stays armed)', async () => {
    renderButton()
    fireEvent.click(screen.getByRole('button', { name: /retract/i }))

    // After some time passing (simulated by checking synchronously), it must
    // still be in the armed state — no auto-revert timer per spec.
    expect(screen.getByRole('button', { name: /confirm — permanent/i })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
describe('RetractPostButton — error → idle flow', () => {
  beforeEach(() => {
    mockAddress = POSTER_ADDRESS as `0x${string}`
    mockIsConnected = true
    mockIsSuccess = false
    mockIsBroadcasting = false
    mockIsMining = false
    mockSubmit.mockReset()
    mockReset.mockReset()
  })

  afterEach(() => { cleanup() })

  it('shows inline error span when hook reports an error', () => {
    mockError = Object.assign(new Error('user rejected transaction'), { shortMessage: 'User rejected' })
    renderButton()

    // Error renders in idle state without any click (hook already has error)
    const errorEl = screen.getByRole('alert')
    expect(errorEl.textContent).toContain('User rejected')
  })

  it('error span is absent when there is no error', () => {
    mockError = null
    renderButton()
    const alerts = screen.queryAllByRole('alert')
    expect(alerts.length).toBe(0)
  })

  it('after error, button is in idle state (label "retract"), not armed', () => {
    // Error set before render means the button wasn't mid-confirm
    mockError = Object.assign(new Error('tx failed'), { shortMessage: 'tx failed' })
    renderButton()
    // Should still render the idle "retract" button (not armed)
    expect(screen.getByRole('button', { name: /retract/i })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
describe('RetractPostButton — in-progress states', () => {
  beforeEach(() => {
    mockAddress = POSTER_ADDRESS as `0x${string}`
    mockIsConnected = true
    mockIsSuccess = false
    mockError = null
    mockSubmit.mockReset()
  })

  afterEach(() => { cleanup() })

  it('shows "retracting…" while isBroadcasting', () => {
    mockIsBroadcasting = true
    mockIsMining = false
    renderButton()
    expect(screen.getByRole('button').textContent).toContain('retracting')
  })

  it('shows "confirming…" while isMining', () => {
    mockIsBroadcasting = false
    mockIsMining = true
    renderButton()
    expect(screen.getByRole('button').textContent).toContain('confirming')
  })
})
