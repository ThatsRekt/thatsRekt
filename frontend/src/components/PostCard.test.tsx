/**
 * Tests for PostCard after issue #151 changes:
 *   1. No composite-id label (#base-42) rendered.
 *   2. No redundant score badge (+N (↑/↓)) rendered.
 */
import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Stub all wagmi + hook dependencies before importing any components.
mock.module('../hooks/useEnsLookup', () => ({
  useEnsLookup: () => ({ name: null, isLoading: false }),
}))
mock.module('../hooks/useConfirmPost', () => ({
  useConfirmPost: () => ({ confirm: async () => {}, isPending: false, error: null }),
}))
mock.module('../hooks/useIsWhitelisted', () => ({
  useIsWhitelisted: () => ({ isWhitelisted: false, isLoading: false }),
}))
mock.module('../hooks/useUserVote', () => ({
  useUserVote: () => ({ vote: null, isLoading: false }),
}))
mock.module('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chain: undefined }),
  useChainId: () => 8453,
  useReadContract: () => ({ data: undefined, isLoading: false }),
  useWriteContract: () => ({ writeContractAsync: async () => '0xhash', isPending: false }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
  useEnsName: () => ({ data: null }),
  useConnect: () => ({ connect: () => {}, connectors: [] }),
  useDisconnect: () => ({ disconnect: () => {} }),
  useSignTypedData: () => ({ signTypedData: async () => '0xsig' }),
}))

const { PostCard } = await import('./PostCard')
import type { PostCardItem } from './PostCard'

const LIVE_ITEM: PostCardItem = {
  kind: 'live',
  post: {
    id: 'base-42',
    chain: {
      slug: 'base',
      name: 'Base',
      chainId: 8453,
      explorerUrl: 'https://basescan.org',
      liveIndexed: true,
      isTestnet: false,
      isLocalFork: false,
    },
    poster: { id: '0xe0396d6d738e726d39f96099b8f6a55d11184374' },
    attackedAt: '2024-01-01T00:00:00Z',
    title: 'Test Attack',
    note: '',
    confirmations: 1,
    disconfirmations: 0,
    netScore: 1,
    purged: false,
    createdAtTimestamp: '2024-01-01T00:00:00Z',
    attackerLinks: [],
    victimLinks: [],
  },
}

function renderCard(item: PostCardItem) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PostCard item={item} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('PostCard — issue #151 regressions', () => {
  it('does NOT render the composite-id label (e.g. #base-42)', () => {
    const { container } = renderCard(LIVE_ITEM)
    expect(container.textContent).not.toContain('#base-42')
  })

  it('does NOT render a score badge with up/down arrow counts', () => {
    const { container } = renderCard(LIVE_ITEM)
    // Score badge pattern: "1↑/0↓" — the ↑/↓ arrows are the tell.
    expect(container.textContent).not.toMatch(/\d+↑\/\d+↓/)
  })

  it('renders the post title', () => {
    renderCard(LIVE_ITEM)
    const headings = screen.getAllByRole('heading', { name: /test attack/i })
    expect(headings.length).toBeGreaterThan(0)
  })
})
