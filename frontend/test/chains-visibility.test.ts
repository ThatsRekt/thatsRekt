/**
 * Chain-visibility gate tests.
 *
 * `visibleChains()` is the registry's single UI gate — it backs the
 * chain selector, leaderboard, guardians and contributors lists, and
 * (via `liveIndexedChains()`) the unfiltered live feed's chain scope.
 *
 * Production must never surface testnets (`sepolia`, `base-sepolia`) or
 * local Anvil forks. Both are hidden behind env gates that default to
 * off (`VITE_SHOW_TESTNETS` / `VITE_SHOW_LOCAL_FORKS`), so a plain
 * `bun test` run with no env exercises the production-default path.
 *
 * This test fails loudly if a future chain is added without an
 * `isTestnet` flag, or if the gate ever regresses to leaking testnets
 * into the feed.
 */
import { describe, expect, test } from 'bun:test'
import { CHAINS, visibleChains, liveIndexedChains } from '../src/lib/chains'

const TESTNET_SLUGS = ['sepolia', 'base-sepolia'] as const

describe('chain visibility — testnet gate (default: off)', () => {
  test('every chain has an explicit isTestnet flag', () => {
    for (const chain of Object.values(CHAINS)) {
      expect(typeof chain.isTestnet).toBe('boolean')
    }
  })

  test('isTestnet is true exactly for the testnet chains', () => {
    const flagged = Object.values(CHAINS)
      .filter((c) => c.isTestnet)
      .map((c) => c.slug)
      .sort()
    expect(flagged).toEqual([...TESTNET_SLUGS].sort())
  })

  test('visibleChains() excludes testnets', () => {
    const visibleSlugs = visibleChains().map((c) => c.slug)
    for (const slug of TESTNET_SLUGS) {
      expect(visibleSlugs).not.toContain(slug)
    }
  })

  test('visibleChains() still includes mainnet chains', () => {
    const visibleSlugs = visibleChains().map((c) => c.slug)
    expect(visibleSlugs).toContain('ethereum')
    expect(visibleSlugs).toContain('base')
  })

  test('liveIndexedChains() — the feed chain scope — excludes testnets', () => {
    const feedSlugs = liveIndexedChains().map((c) => c.slug)
    for (const slug of TESTNET_SLUGS) {
      expect(feedSlugs).not.toContain(slug)
    }
  })
})
