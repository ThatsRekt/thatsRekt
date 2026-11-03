/**
 * Component tests for DonationsTimeline.
 *
 * Uses real MemoryRouter + afterEach cleanup. ChainBadge uses getChainBySlug
 * which is a pure lookup — no stub needed.
 *
 * Donor cells render via the shared AddressLabel, which reverse-resolves ENS
 * through wagmi's useEnsName. We stub useEnsLookup to null so wagmi never boots
 * in the test runner (same approach as AddressLabel.test.tsx); addresses then
 * fall back to the truncated hex form (0x…1234) we assert on.
 *
 * Tests:
 *   1. Renders loading state.
 *   2. Renders error state.
 *   3. Renders empty state.
 *   4. Renders donation rows with donor address, amount, tx link.
 *   5. "Load more" button calls onLoadMore when hasMore is true.
 *   6. "Load more" is absent when hasMore is false.
 *   7. Donor addresses are truncated (0x…1234 format) via AddressLabel.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

// Stub useEnsLookup before importing DonationsTimeline so the AddressLabel it
// now renders never boots wagmi (mirrors AddressLabel.test.tsx).
// Only the signer below has a primary name; every other address resolves to null.
const SAFE = '0x371b75388b95073e903648abbb205df1295f5ee3'
const SIGNER = '0x5920ca4a51d93052f111e90c387f70bcf723ea3f'
const NAMED_SAFE = '0x00000000000000000000000000000000000000aa'
const ENS_NAMES: Record<string, string> = {
  [SIGNER]: 'netrim.eth',
  [NAMED_SAFE]: 'safe.netrim.eth',
}
mock.module('../hooks/useEnsLookup', () => ({
  useEnsLookup: (addr?: string | null) => ({
    name: addr ? (ENS_NAMES[addr.toLowerCase()] ?? null) : null,
    isLoading: false,
  }),
}))

const { DonationsTimeline } = await import('./DonationsTimeline')
import type { Donation } from '../lib/queries'

afterEach(cleanup)

const SAMPLE_DONATIONS: Donation[] = [
  {
    id: '1-0xaaa-native',
    chainId: 1,
    chainSlug: 'ethereum',
    fromAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    txFromAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
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
    txFromAddress: null,
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
    const rows = screen.getAllByText(/0x[a-f0-9]{4}…[a-f0-9]{4}/i)
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
  it('truncates 0xd8da6bf2...6045 to 0xd8da…6045', () => {
    renderTimeline()
    // The test address starts 0xd8da6bf2 and ends 96045
    const truncated = screen.getAllByText(/0xd8da…\w{4}/i)
    expect(truncated.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Sort header tests
// ---------------------------------------------------------------------------

describe('DonationsTimeline — sort headers', () => {
  function renderWithSort(
    orderBy = 'date',
    direction: 'ASC' | 'DESC' = 'DESC',
    onSort = mock((_orderBy: string, _direction: string) => {}),
  ) {
    return renderTimeline({
      sortState: { orderBy, direction },
      onSort,
    })
  }

  it('renders clickable column headers for donor, amount, chain, when', () => {
    renderWithSort()
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map((b) => b.textContent?.toLowerCase() ?? '')
    expect(labels.some((l) => l.includes('donor'))).toBe(true)
    expect(labels.some((l) => l.includes('amount'))).toBe(true)
    expect(labels.some((l) => l.includes('chain'))).toBe(true)
    expect(labels.some((l) => l.includes('when'))).toBe(true)
  })

  it('clicking the "amount" header calls onSort with "amount"', async () => {
    const fn = mock((_orderBy: string, _direction: string) => {})
    renderWithSort('date', 'DESC', fn)
    const amountBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.toLowerCase().includes('amount'))
    expect(amountBtn).toBeDefined()
    await userEvent.click(amountBtn!)
    expect(fn).toHaveBeenCalledTimes(1)
    const [calledOrderBy] = fn.mock.calls[0]!
    expect(calledOrderBy).toBe('amount')
  })

  it('clicking the "donor" header calls onSort with "donor"', async () => {
    const fn = mock((_orderBy: string, _direction: string) => {})
    renderWithSort('date', 'DESC', fn)
    const donorBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.toLowerCase().includes('donor'))
    expect(donorBtn).toBeDefined()
    await userEvent.click(donorBtn!)
    const [calledOrderBy] = fn.mock.calls[0]!
    expect(calledOrderBy).toBe('donor')
  })

  it('clicking the active "date" (when) header calls onSort with "date" (toggle)', async () => {
    const fn = mock((_orderBy: string, _direction: string) => {})
    renderWithSort('date', 'DESC', fn)
    const dateBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.toLowerCase().includes('when'))
    expect(dateBtn).toBeDefined()
    await userEvent.click(dateBtn!)
    const [calledOrderBy] = fn.mock.calls[0]!
    expect(calledOrderBy).toBe('date')
  })

  it('shows a sort indicator on the active column', () => {
    renderWithSort('date', 'DESC')
    const buttons = screen.getAllByRole('button')
    const dateBtn = buttons.find((b) => b.textContent?.toLowerCase().includes('when'))
    expect(dateBtn).toBeDefined()
    const text = dateBtn!.textContent ?? ''
    const hasIndicator =
      text.includes('↑') ||
      text.includes('↓') ||
      text.includes('▲') ||
      text.includes('▼') ||
      dateBtn!.closest('th')?.getAttribute('aria-sort') !== null
    expect(hasIndicator).toBe(true)
  })

  it('passes toggled direction when clicking the active column', async () => {
    const fn = mock((_orderBy: string, _direction: string) => {})
    renderWithSort('date', 'DESC', fn)
    const dateBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.toLowerCase().includes('when'))
    await userEvent.click(dateBtn!)
    expect(fn.mock.calls[0]![1]).toBe('ASC')
  })

  it('passes default direction when clicking an inactive column', async () => {
    const fn = mock((_orderBy: string, _direction: string) => {})
    renderWithSort('date', 'DESC', fn)
    const chainBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.toLowerCase().includes('chain'))
    await userEvent.click(chainBtn!)
    const [calledOrderBy, calledDirection] = fn.mock.calls[0]!
    expect(calledOrderBy).toBe('chain')
    expect(calledDirection).toBe('ASC')
  })
})

describe('DonationsTimeline donor attribution', () => {
  const safeDonation = (txFromAddress: string | null): Donation => ({
    id: '1-0xccc-235',
    chainId: 1,
    chainSlug: 'ethereum',
    fromAddress: SAFE,
    txFromAddress,
    tokenAddress: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    tokenSymbol: 'USDS',
    tokenDecimals: 18,
    amountRaw: '1000000000000000000000',
    amountNorm: '1000',
    txHash: '0x0cffcb1003ab4fc7ba1046bf345ed570af5d2de9b1bbc23ef298f194ecb98da7',
    logIndex: 235,
    blockNumber: 26_334_638,
    blockTimestamp: new Date(Date.now() - 600_000).toISOString(),
  })

  it("credits the signer's ENS name when a nameless Safe sent the tokens", () => {
    renderTimeline({ donations: [safeDonation(SIGNER)] })
    expect(screen.getAllByText('netrim.eth').length).toBeGreaterThan(0)
  })

  it("prefers the signer's ENS name even when the Safe has its own", () => {
    renderTimeline({ donations: [{ ...safeDonation(SIGNER), fromAddress: NAMED_SAFE }] })
    expect(screen.getAllByText('netrim.eth').length).toBeGreaterThan(0)
    expect(screen.queryByText('safe.netrim.eth')).toBeNull()
  })

  it('falls back to the sender hex when no signer is recorded', () => {
    renderTimeline({ donations: [safeDonation(null)] })
    expect(screen.queryByText('netrim.eth')).toBeNull()
    expect(screen.getAllByText(/0x371b/i).length).toBeGreaterThan(0)
  })
})
