/**
 * TDD tests for the wagmi-deferred wallet boundary.
 *
 * Three invariants:
 *   (a) The homepage Feed renders with wallet runtime NOT mounted — no
 *       WagmiProvider in the tree on initial render.
 *   (b) Once WalletRuntime loads, the connect/account UI renders and
 *       wagmi hooks see a provider.
 *   (c) A whitelist-gated action still gates correctly after load
 *       (the WhitelistGateModal opens when a non-whitelisted wallet acts).
 */

import { describe, expect, it, mock } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense } from 'react'
import { useWalletReady, WalletReadyContext } from './WalletContext'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQC()}>
      <MemoryRouter>
        <Suspense fallback={<div data-testid="suspense-fallback">loading…</div>}>
          {children}
        </Suspense>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

// ---------------------------------------------------------------------------
// (a) WalletReadyContext defaults to false — no wagmi provider on first paint
// ---------------------------------------------------------------------------

describe('WalletContext — initial state', () => {
  it('isReady defaults to false before WalletRuntime mounts', () => {
    let captured = true // intentionally wrong — test will correct it
    function Probe() {
      captured = useWalletReady()
      return null
    }
    render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    )
    expect(captured).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (b) WalletBoundary makes isReady=true once WalletRuntime resolves
// ---------------------------------------------------------------------------

// Stub wagmi before importing WalletRuntime so the lazy import works in jsdom.
mock.module('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chain: undefined, chainId: undefined }),
  useConnect: () => ({ connect: () => {}, connectors: [], isPending: false, variables: undefined, error: null }),
  useDisconnect: () => ({ disconnect: () => {} }),
  useDisconnectIfNotWhitelisted: () => {},
  useReadContract: () => ({ data: undefined, isLoading: false, isFetching: false, isError: false, refetch: () => {} }),
  useWriteContract: () => ({ writeContract: () => {}, writeContractAsync: async () => '0xhash', data: undefined, isPending: false, error: null, reset: () => {} }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  useSwitchChain: () => ({ switchChainAsync: async () => {}, isPending: false }),
  useEnsName: () => ({ data: null, isLoading: false }),
  WagmiProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  createConfig: () => ({}),
  http: () => ({}),
  fallback: () => ({}),
}))
mock.module('wagmi/chains', () => ({
  mainnet: { id: 1 },
  base: { id: 8453 },
  arbitrum: { id: 42161 },
  optimism: { id: 10 },
  baseSepolia: { id: 84532 },
}))
mock.module('wagmi/connectors', () => ({
  injected: () => ({ type: 'injected', uid: 'injected' }),
  coinbaseWallet: () => ({ type: 'coinbaseWallet', uid: 'coinbase' }),
  safe: () => ({ type: 'safe', uid: 'safe' }),
}))
mock.module('../hooks/useDisconnectIfNotWhitelisted', () => ({
  useDisconnectIfNotWhitelisted: () => {},
}))
mock.module('../hooks/useIsWhitelisted', () => ({
  useIsWhitelisted: () => ({
    isWhitelisted: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    perChain: {},
    refetch: () => {},
  }),
}))

const { WalletBoundary } = await import('./WalletBoundary')

describe('WalletBoundary — mounts WalletRuntime and sets isReady=true', () => {
  it('renders children slot initially', async () => {
    render(
      <Wrapper>
        <WalletBoundary
          walletSlot={<div data-testid="wallet-ui">wallet ui</div>}
        />
      </Wrapper>,
    )
    // wallet slot may be in suspense initially — wait for it to resolve
    await waitFor(() => {
      expect(screen.getByTestId('wallet-ui')).toBeTruthy()
    })
  })

  it('sets isReady=true after WalletRuntime resolves', async () => {
    let capturedReady = false
    function ReadyProbe() {
      capturedReady = useWalletReady()
      return null
    }

    render(
      <Wrapper>
        <WalletBoundary
          walletSlot={<ReadyProbe />}
        />
      </Wrapper>,
    )

    await waitFor(() => {
      expect(capturedReady).toBe(true)
    })
  })
})

// (c) Whitelist gate test lives in a separate file:
//     src/wallet/PostAlertButtonGate.test.tsx
// Isolated so wagmi/hook mocks don't collide with other test files
// in bun's shared module cache.
