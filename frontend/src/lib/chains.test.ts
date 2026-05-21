import { describe, expect, it } from 'bun:test'
import { CHAINS, liveIndexedChains, visibleChains } from './chains'

/**
 * The chain registry is ordered by relevance: live mainnets first
 * (Ethereum leading), then archive-only mainnets, then testnets last.
 * These tests pin that order so a registry edit that disturbs it fails
 * loudly — the chain selector and every other chain list in the app
 * render in `visibleChains()` order.
 *
 * Local anvil forks AND public testnets are hidden unless
 * `VITE_SHOW_LOCAL_FORKS` / `VITE_SHOW_TESTNETS` are set, which they
 * never are under the test runner — so the asserted set is exactly the
 * production-visible set.
 */
describe('chain registry ordering', () => {
  it('visibleChains() lists production chains by relevance — mainnets then archive', () => {
    expect(visibleChains().map((c) => c.slug)).toEqual([
      'ethereum',
      'base',
      'arbitrum',
      'optimism',
      'bsc',
      'blast',
    ])
  })

  it('liveIndexedChains() preserves that order, minus archive-only chains', () => {
    expect(liveIndexedChains().map((c) => c.slug)).toEqual([
      'ethereum',
      'base',
      'arbitrum',
      'optimism',
    ])
  })
})

/**
 * Testnet visibility gate (default: off).
 *
 * `visibleChains()` is the registry's single UI gate — it backs the
 * chain selector, leaderboard, guardians and contributors lists, and
 * (via `liveIndexedChains()`) the unfiltered live feed's chain scope.
 *
 * Production must never surface testnets (`sepolia`, `base-sepolia`).
 * They are gated behind `VITE_SHOW_TESTNETS`, which defaults off, so a
 * plain `bun test` run exercises the production-default path.
 */
describe('chain visibility — testnet gate (default: off)', () => {
  const TESTNET_SLUGS = ['sepolia', 'base-sepolia'] as const

  it('every chain has an explicit isTestnet flag', () => {
    for (const chain of Object.values(CHAINS)) {
      expect(typeof chain.isTestnet).toBe('boolean')
    }
  })

  it('isTestnet is true exactly for the testnet chains', () => {
    const flagged = Object.values(CHAINS)
      .filter((c) => c.isTestnet)
      .map((c) => c.slug)
      .sort()
    expect(flagged).toEqual([...TESTNET_SLUGS].sort())
  })

  it('visibleChains() excludes testnets', () => {
    const visibleSlugs = visibleChains().map((c) => c.slug)
    for (const slug of TESTNET_SLUGS) {
      expect(visibleSlugs).not.toContain(slug)
    }
  })

  it('liveIndexedChains() — the feed chain scope — excludes testnets', () => {
    const feedSlugs = liveIndexedChains().map((c) => c.slug)
    for (const slug of TESTNET_SLUGS) {
      expect(feedSlugs).not.toContain(slug)
    }
  })
})
