/**
 * Component tests for DonationsTimeline.
 *
 * Uses real MemoryRouter + afterEach cleanup. No mock.module (process-global
 * poison risk per spec). ChainBadge uses getChainBySlug which is a pure
 * lookup — no stub needed.
 *
 * Tests:
 *   1. Renders loading state.
 *   2. Renders error state.
 *   3. Renders empty state.
 *   4. Renders donation rows with donor address, amount, tx link.
 *   5. "Load more" button calls onLoadMore when hasMore is true.
 *   6. "Load more" is absent when hasMore is false.
 *   7. Donor addresses are truncated (0x...1234 format).
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

// No mock.module calls — DonationsTimeline has no module-level side effects.
// We import it directly.
const { DonationsTimeline } = await import('./DonationsTimeline')
import type { Donation } from '../lib/queries'

afterEach(cleanup)

const SAMPLE_DONATIONS: Donation[] = [
  {
    id: '1-0xaaa-native',
    chainId: 1,
    chainSlug: 'ethereum',
    fromAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    tokenAddress: null,
    tokenSymbol: 'ETH',
    tokenDecimals: 18,
    amountRaw: '500000000000000000',
    amountNorm: '0.5',
    txHash: '0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1',
    logIndex: null,
    blockNumber: 20_100_001,
    blockTimestamp: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    id: '1-0xbbb-native',
    chainId: 1,
    chainSlug: 'ethereum',
    fromAddress: '0x1234567890abcdef1234567890abcdef12345678',
    tokenAddress: null,
    tokenSymbol: 'ETH',
    tokenDecimals: 18,
    amountRaw: '1000000000000000000',
    amountNorm: '1',
    txHash: '0xdef456def456def456def456def456def456def456def456def456def456def4',
    logIndex: null,
    blockNumber: 20_100_000,
    blockTimestamp: new Date(Date.now() - 7200_000).toISOString(),
  },
]

function renderTimeline(props: Partial<React.ComponentProps<typeof DonationsTimeline>> = {}) {
  const defaults = {
    donations: SAMPLE_DONATIONS,
    isLoading: false,
    isError: false,
    hasMore: false,
    onLoadMore: () => {},
    isFetchingMore: false,
    ...props,
  }
  return render(
    <MemoryRouter>
      <DonationsTimeline {...defaults} />
    </MemoryRouter>,
  )
}

describe('DonationsTimeline — states', () => {
  it('renders "loading donations..." in loading state', () => {
    renderTimeline({ donations: [], isLoading: true })
    expect(screen.getByText(/loading donations/i)).toBeTruthy()
  })

  it('renders "donations unavailable" in error state', () => {
    renderTimeline({ donations: [], isLoading: false, isError: true })
    expect(screen.getByText(/donations unavailable/i)).toBeTruthy()
  })

  it('renders "no donations yet" when list is empty and not loading', () => {
    renderTimeline({ donations: [], isLoading: false, isError: false })
    expect(screen.getByText(/no donations yet/i)).toBeTruthy()
  })
})

describe('DonationsTimeline — donation rows', () => {
  it('renders two rows for two donations', () => {
    renderTimeline()
    // Each row has a truncated donor address — two should appear.
    const rows = screen.getAllByText(/0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}/i)
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('renders nominal amounts', () => {
    renderTimeline()
    // amountNorm values from SAMPLE_DONATIONS
    expect(screen.getAllByText('0.5').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)
  })

  it('renders ETH symbol', () => {
    renderTimeline()
    const ethLabels = screen.getAllByText('ETH')
    expect(ethLabels.length).toBeGreaterThan(0)
  })

  it('renders tx explorer links', () => {
    renderTimeline()
    const txLinks = screen.getAllByRole('link', { name: 'tx' })
    expect(txLinks.length).toBeGreaterThanOrEqual(2)
    // Each link should point to etherscan
    const hrefs = txLinks.map((l) => l.getAttribute('href'))
    hrefs.forEach((href) => {
      expect(href).toContain('etherscan.io/tx/0x')
    })
  })

  it('donor address links point to explorer', () => {
    renderTimeline()
    // Donor addresses rendered as links (a[href] containing /address/)
    const links = screen.getAllByRole('link')
    const addrLinks = links.filter((l) =>
      l.getAttribute('href')?.includes('/address/'),
    )
    expect(addrLinks.length).toBeGreaterThan(0)
  })
})

describe('DonationsTimeline — load more', () => {
  it('shows "load more" button when hasMore is true', () => {
    renderTimeline({ hasMore: true })
    expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy()
  })

  it('does not show "load more" button when hasMore is false', () => {
    renderTimeline({ hasMore: false })
    const btn = screen.queryByRole('button', { name: /load more/i })
    expect(btn).toBeNull()
  })

  it('calls onLoadMore when the button is clicked', async () => {
    const onLoadMore = mock(() => {})
    renderTimeline({ hasMore: true, onLoadMore })
    const btn = screen.getByRole('button', { name: /load more/i })
    await userEvent.click(btn)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('button is disabled and shows "loading..." while isFetchingMore', () => {
    renderTimeline({ hasMore: true, isFetchingMore: true })
    const btn = screen.getByRole('button', { name: /loading/i })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})

describe('DonationsTimeline — address truncation', () => {
  it('truncates 0xd8da6bf2...6045 to 0xd8da...6045', () => {
    renderTimeline()
    // The test address starts 0xd8da6bf2 and ends 96045
    const truncated = screen.getAllByText(/0xd8da\.\.\.\w{4}/i)
    expect(truncated.length).toBeGreaterThan(0)
  })
})
