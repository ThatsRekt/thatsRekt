/**
 * Tests for postableChainIds — the pure composer that decides which chains
 * the "report attack" composer offers.
 *
 * Three filters, AND-ed:
 *   1. deployed registry        — `chainsWithRegistry()` (1, 8453, 42161, 10, 84532)
 *   2. build-visible            — `visibleChains()` gate; under the test runner
 *      `VITE_SHOW_TESTNETS` is never set, so testnets (Base Sepolia 84532)
 *      are excluded — exactly the production-visible set.
 *   3. whitelisted              — `perChain[id] === true`
 *
 * Regression guard for the bug where the composer only ever offered Base +
 * Base Sepolia: Mainnet / Arbitrum / Optimism must appear when whitelisted,
 * and the Base Sepolia testnet must NOT appear in a prod-shaped build.
 */
import { describe, expect, it } from 'bun:test'
import { postableChainIds } from '../src/lib/contracts'

const ALL_TRUE: Readonly<Record<number, boolean>> = {
  1: true,
  8453: true,
  42161: true,
  10: true,
  84532: true,
}

describe('postableChainIds', () => {
  it('offers every prod mainnet the user is whitelisted on — not just Base', () => {
    const ids = postableChainIds(ALL_TRUE)
    expect(ids).toContain(1) // Ethereum
    expect(ids).toContain(8453) // Base
    expect(ids).toContain(42161) // Arbitrum
    expect(ids).toContain(10) // Optimism
  })

  it('excludes the Base Sepolia testnet in a prod-shaped build', () => {
    // Whitelisted on the testnet, but VITE_SHOW_TESTNETS is unset under the
    // runner → the testnet is build-hidden, mirroring production.
    expect(postableChainIds(ALL_TRUE)).not.toContain(84532)
  })

  it('returns the registry mainnets in canonical display order', () => {
    expect([...postableChainIds(ALL_TRUE)]).toEqual([1, 8453, 42161, 10])
  })

  it('drops chains the user is not whitelisted on', () => {
    const ids = postableChainIds({ 1: true, 8453: false })
    expect(ids).toEqual([1])
  })

  it('treats undefined (read in flight) as not-whitelisted', () => {
    const ids = postableChainIds({ 1: undefined, 8453: true })
    expect(ids).toEqual([8453])
  })

  it('returns empty when whitelisted on no visible registry chain', () => {
    expect(postableChainIds({})).toEqual([])
    // Whitelisted only on the build-hidden testnet → still empty in prod.
    expect(postableChainIds({ 84532: true })).toEqual([])
  })
})
