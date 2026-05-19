import { describe, expect, it } from 'bun:test'
import { liveIndexedChains, visibleChains } from './chains'

/**
 * The chain registry is ordered by relevance: live mainnets first
 * (Ethereum leading), then archive-only mainnets, then testnets last.
 * These tests pin that order so a registry edit that disturbs it fails
 * loudly — the chain selector and every other chain list in the app
 * render in `visibleChains()` order.
 *
 * Local anvil forks are hidden unless VITE_SHOW_LOCAL_FORKS=true, which
 * it never is under the test runner, so the asserted set is exactly the
 * production-visible set.
 */
describe('chain registry ordering', () => {
  it('visibleChains() lists chains by relevance — mainnets, archive, testnets', () => {
    expect(visibleChains().map((c) => c.slug)).toEqual([
      'ethereum',
      'base',
      'arbitrum',
      'optimism',
      'bsc',
      'blast',
      'sepolia',
      'base-sepolia',
    ])
  })

  it('liveIndexedChains() preserves that order, minus archive-only chains', () => {
    expect(liveIndexedChains().map((c) => c.slug)).toEqual([
      'ethereum',
      'base',
      'arbitrum',
      'optimism',
      'sepolia',
      'base-sepolia',
    ])
  })
})
