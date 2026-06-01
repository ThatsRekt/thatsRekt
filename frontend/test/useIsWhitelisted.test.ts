/**
 * Tests for the multi-chain whitelist aggregation (`aggregateWhitelist`),
 * the pure core of `useIsWhitelisted`.
 *
 * Deliberately tests the pure helper rather than rendering the hook: the
 * repo's wagmi mocks are registered via `mock.module('wagmi', …)`, which is
 * process-global and collides across test files (documented in
 * `useDonations.test.ts`). Folding the per-chain reduce into a pure
 * function lets us assert the multi-chain contract with zero wagmi coupling.
 *
 * Regression guard for the bug where the composer only ever saw Base +
 * Base Sepolia: the aggregate must carry a `perChain` entry for EVERY
 * registry chain the hook feeds it, and OR `isWhitelisted` across them.
 */
import { describe, expect, test } from 'bun:test'
import { aggregateWhitelist, type ChainWhitelistRead } from '../src/hooks/useIsWhitelisted'
import { chainsWithRegistry } from '../src/lib/contracts'

// A settled read with a given whitelist result for a chain.
const settled = (chainId: number, data: boolean): ChainWhitelistRead => ({
  chainId,
  data,
  isLoading: false,
  isFetching: false,
  isError: false,
})

// An in-flight read (data still `unknown`/undefined).
const pending = (chainId: number): ChainWhitelistRead => ({
  chainId,
  data: undefined,
  isLoading: true,
  isFetching: true,
  isError: false,
})

// One settled read per registry chain, all with the given result.
const allChains = (data: boolean): ChainWhitelistRead[] =>
  chainsWithRegistry().map((id) => settled(id, data))

describe('aggregateWhitelist', () => {
  test('carries a perChain entry for every registry chain — not just Base/Sepolia', () => {
    const { perChain } = aggregateWhitelist(allChains(false))
    for (const id of chainsWithRegistry()) {
      expect(perChain).toHaveProperty(String(id))
    }
  })

  test('surfaces a true read on a non-Base mainnet (Arbitrum)', () => {
    const { perChain, isWhitelisted } = aggregateWhitelist([
      settled(1, false),
      settled(8453, false),
      settled(42161, true),
      settled(10, false),
    ])
    expect(perChain[42161]).toBe(true)
    expect(perChain[1]).toBe(false)
    expect(isWhitelisted).toBe(true)
  })

  test('isWhitelisted is the OR across all chains', () => {
    expect(aggregateWhitelist(allChains(false)).isWhitelisted).toBe(false)
    expect(aggregateWhitelist(allChains(true)).isWhitelisted).toBe(true)
  })

  test('an in-flight read is undefined and never counts as whitelisted', () => {
    const { perChain, isWhitelisted } = aggregateWhitelist([
      pending(1),
      settled(8453, false),
    ])
    expect(perChain[1]).toBeUndefined()
    expect(isWhitelisted).toBe(false)
  })

  test('OR-reduces the loading / fetching / error flags', () => {
    const agg = aggregateWhitelist([pending(1), settled(8453, false)])
    expect(agg.anyLoading).toBe(true)
    expect(agg.anyFetching).toBe(true)
    expect(agg.anyError).toBe(false)
    expect(aggregateWhitelist([settled(1, false)]).anyLoading).toBe(false)
  })

  test('coerces a non-boolean truthy read to false (defensive)', () => {
    // RPC quirk: a malformed read returns something non-bool. Strict
    // `=== true` keeps it out of the whitelisted set rather than trusting it.
    const { perChain, isWhitelisted } = aggregateWhitelist([
      { chainId: 1, data: 'yes', isLoading: false, isFetching: false, isError: false },
    ])
    expect(perChain[1]).toBe(false)
    expect(isWhitelisted).toBe(false)
  })
})
