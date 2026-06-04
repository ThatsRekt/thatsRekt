import { describe, expect, it } from 'bun:test'
import { aggregateWhitelist, type ChainWhitelistRead } from './useIsWhitelisted'

/**
 * The whitelist gate is an OR across every deployed registry: an address is
 * "whitelisted" in the UI sense if it is whitelisted on at least one chain.
 * The impure hook fans out one independent read per chain; this pure reducer
 * is where the OR + per-chain map live, so it carries the actual semantics
 * and is unit-tested without standing up a wagmi provider.
 *
 * Regression context: BSC [56] is now one of the folded chains. These tests
 * pin the cross-chain OR + per-chain mapping so a future chain addition
 * (Polygon) can't silently change the gate's meaning.
 */

// Minimal builder — only `chainId` + `data` drive the assertions here; the
// loading/error flags default to a settled, non-erroring read.
const read = (
  chainId: number,
  data: unknown,
): ChainWhitelistRead => ({
  chainId,
  data,
  isLoading: false,
  isFetching: false,
  isError: false,
})

describe('aggregateWhitelist', () => {
  it('is whitelisted when ANY chain returns true', () => {
    const { isWhitelisted } = aggregateWhitelist([
      read(1, false),
      read(8453, true),
      read(56, false),
    ])
    expect(isWhitelisted).toBe(true)
  })

  it('is NOT whitelisted when every chain returns false', () => {
    const { isWhitelisted } = aggregateWhitelist([
      read(1, false),
      read(8453, false),
      read(56, false),
    ])
    expect(isWhitelisted).toBe(false)
  })

  it('treats all-undefined (nothing resolved yet) as not whitelisted', () => {
    const { isWhitelisted, perChain } = aggregateWhitelist([
      read(1, undefined),
      read(56, undefined),
    ])
    expect(isWhitelisted).toBe(false)
    expect(perChain[1]).toBeUndefined()
    expect(perChain[56]).toBeUndefined()
  })

  it('flips to whitelisted as soon as one chain resolves true, others pending', () => {
    const { isWhitelisted } = aggregateWhitelist([
      read(1, undefined),
      read(56, true),
    ])
    expect(isWhitelisted).toBe(true)
  })

  it('coerces each chain read into a strict boolean / undefined in perChain', () => {
    const { perChain } = aggregateWhitelist([
      read(1, true),
      read(56, false),
      read(8453, undefined),
    ])
    expect(perChain).toEqual({ 1: true, 56: false, 8453: undefined })
  })

  it('surfaces aggregate loading / error flags across chains', () => {
    const agg = aggregateWhitelist([
      { chainId: 1, data: undefined, isLoading: true, isFetching: true, isError: false },
      { chainId: 56, data: false, isLoading: false, isFetching: false, isError: true },
    ])
    expect(agg.anyLoading).toBe(true)
    expect(agg.anyFetching).toBe(true)
    expect(agg.anyError).toBe(true)
  })
})
