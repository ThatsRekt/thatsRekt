import { describe, expect, it } from 'bun:test'
import {
  REGISTRY_PROXIES,
  registryAddress,
  chainsWithRegistry,
} from './contracts'

/**
 * The registry wiring has historically drifted across three independent
 * hardcoded lists (the proxy map, the display-ordered `chainsWithRegistry`
 * list, and — until this change — a Base-only hardcode inside the whitelist
 * hook). That drift is exactly why BSC posts silently lost their vote bar:
 * the proxy was live on-chain but never wired into the frontend.
 *
 * These tests pin the invariant that matters — every chain with a deployed
 * proxy is also surfaced by `chainsWithRegistry()` — so the next chain
 * rollout (Polygon) fails loudly here instead of shipping a half-wired chain.
 */
describe('registry proxies', () => {
  it('exposes the BSC (56) registry at the canonical CREATE2 proxy', () => {
    // Verified on-chain: eth_getCode at this address on BSC returns the
    // EIP-1967 proxy bytecode (same canonical address as Mainnet/Base/Arb/OP).
    expect(registryAddress(56)).toBe(
      '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A',
    )
  })

  it('exposes the Polygon (137) registry at the canonical CREATE2 proxy', () => {
    // Verified on-chain: eth_getCode at this address on Polygon returns the
    // EIP-1967 proxy bytecode (same canonical address as the other mainnets).
    expect(registryAddress(137)).toBe(
      '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A',
    )
  })

  it('returns undefined for a chain with no deployed registry', () => {
    expect(registryAddress(999_999)).toBeUndefined()
  })

  it('lists BSC and Polygon among the chains with a deployed registry', () => {
    expect(chainsWithRegistry()).toContain(56)
    expect(chainsWithRegistry()).toContain(137)
  })

  it('keeps chainsWithRegistry() in sync with REGISTRY_PROXIES (no drift)', () => {
    const proxyKeys = Object.keys(REGISTRY_PROXIES)
      .map(Number)
      .sort((a, b) => a - b)
    const listed = chainsWithRegistry()
      .map(Number)
      .sort((a, b) => a - b)
    expect(listed).toEqual(proxyKeys)
  })
})
