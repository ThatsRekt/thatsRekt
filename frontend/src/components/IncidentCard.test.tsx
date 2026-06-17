/**
 * Light component tests for ConsensusRow and IncidentCard.
 *
 * Style mirrors PostCard.test.tsx — stub wagmi + hook seams before import,
 * then render with MemoryRouter + QueryClientProvider.
 *
 * Assertions focus on external behaviour (what the user sees) rather than
 * internal DOM structure.
 */
import { describe, expect, it, mock } from 'bun:test'
import { render, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// Stub hook / wagmi seams — must come before any component import.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Imports after stubs.
// ---------------------------------------------------------------------------
const { IncidentCard } = await import('./IncidentCard')
import type { IncidentGroup } from '../lib/incidents'
import type { FeedPost } from '../lib/queries'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const ETH_CHAIN = { chainId: 1, slug: 'ethereum', name: 'Ethereum' }
const BSC_CHAIN = { chainId: 56, slug: 'bsc', name: 'BNB Smart Chain' }
const BASE_CHAIN = { chainId: 8453, slug: 'base', name: 'Base' }

function makePost(overrides: Partial<FeedPost> & { id: string }): FeedPost {
  return {
    id: overrides.id,
    chain: overrides.chain,
    poster: overrides.poster ?? { id: '0xe0396d6d738e726d39f96099b8f6a55d11184374' },
    attackedAt: overrides.attackedAt ?? '2024-06-01T12:00:00.000Z',
    title: overrides.title ?? 'MILC/MLT Cross-Chain Bridge',
    note: overrides.note ?? 'Compromised admin key granted DEFAULT_ADMIN_ROLE',
    confirmations: overrides.confirmations ?? 8,
    disconfirmations: overrides.disconfirmations ?? 0,
    netScore: overrides.netScore ?? 8,
    purged: overrides.purged ?? false,
    createdAtTimestamp: overrides.createdAtTimestamp ?? '2024-06-01T12:00:00.000Z',
    attackerLinks: overrides.attackerLinks ?? [{ address: { id: '0x2a09000000000000000000000000000000000a38', attackerScore: '10' } }],
    victimLinks: overrides.victimLinks ?? [{ address: { id: '0xdeadbeef00000000000000000000000000000001', attackerScore: '0' } }],
  }
}

const ethPost = makePost({ id: 'ethereum-1', chain: ETH_CHAIN })
const bscPost = makePost({
  id: 'bsc-1',
  chain: BSC_CHAIN,
  confirmations: 1,
  disconfirmations: 6, // disputed!
})
const basePost = makePost({ id: 'base-42', chain: BASE_CHAIN })

function makeCrossChainGroup(): IncidentGroup {
  return {
    key: 'h:incident-milc-mlt',
    posts: [ethPost, bscPost],
    leadPost: ethPost,
    chains: [ETH_CHAIN, BSC_CHAIN],
    isCrossChain: true,
  }
}

function makeSingleChainGroup(): IncidentGroup {
  return {
    key: 'h:incident-single',
    posts: [basePost],
    leadPost: basePost,
    chains: [BASE_CHAIN],
    isCrossChain: false,
  }
}

function renderCard(group: IncidentGroup) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IncidentCard group={group} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IncidentCard — cross-chain group', () => {
  it('renders the incident title once', () => {
    const { container } = renderCard(makeCrossChainGroup())
    // Should appear exactly once — the lead post's (normalized) title.
    const headings = container.querySelectorAll('h2')
    // Filter to the title heading (normalize lowercases, so check case-insensitively)
    const titleHeadings = Array.from(headings).filter((h) =>
      h.textContent?.toLowerCase().includes('milc/mlt cross-chain bridge'),
    )
    expect(titleHeadings.length).toBe(1)
  })

  it('renders one ConsensusRow per sibling post', () => {
    const { container } = renderCard(makeCrossChainGroup())
    // Each consensus row gets a data-testid="consensus-row"
    const rows = container.querySelectorAll('[data-testid="consensus-row"]')
    expect(rows.length).toBe(2)
  })

  it('renders chain badge cluster (isCrossChain=true)', () => {
    const { container } = renderCard(makeCrossChainGroup())
    // The cluster wrapper has data-testid="chain-cluster"
    const cluster = container.querySelector('[data-testid="chain-cluster"]')
    expect(cluster).not.toBeNull()
  })

  it('each row carries a view → link to the correct per-chain detail route', () => {
    const { container } = renderCard(makeCrossChainGroup())
    const links = within(container).getAllByRole('link', { name: /view →/i })
    // One link per post
    expect(links.length).toBe(2)
    // ETH post: /post/ethereum/1
    const hrefs = links.map((l) => l.getAttribute('href'))
    expect(hrefs).toContain('/post/ethereum/1')
    expect(hrefs).toContain('/post/bsc/1')
  })

  it('applies disputed tint when disconfirmations > confirmations', () => {
    const { container } = renderCard(makeCrossChainGroup())
    // The disputed row should have data-disputed="true"
    const disputedRows = container.querySelectorAll('[data-disputed="true"]')
    expect(disputedRows.length).toBe(1)
  })

  it('does NOT apply disputed tint to the non-disputed row', () => {
    const { container } = renderCard(makeCrossChainGroup())
    const nonDisputedRows = container.querySelectorAll('[data-disputed="false"]')
    expect(nonDisputedRows.length).toBe(1)
  })
})

describe('IncidentCard — single-chain group', () => {
  it('does NOT render chain badge cluster when isCrossChain=false', () => {
    const { container } = renderCard(makeSingleChainGroup())
    const cluster = container.querySelector('[data-testid="chain-cluster"]')
    expect(cluster).toBeNull()
  })

  it('renders one consensus row', () => {
    const { container } = renderCard(makeSingleChainGroup())
    const rows = container.querySelectorAll('[data-testid="consensus-row"]')
    expect(rows.length).toBe(1)
  })

  it('view → link targets the correct detail route', () => {
    const { container } = renderCard(makeSingleChainGroup())
    const links = within(container).getAllByRole('link', { name: /view →/i })
    expect(links.length).toBe(1)
    expect(links[0].getAttribute('href')).toBe('/post/base/42')
  })
})
