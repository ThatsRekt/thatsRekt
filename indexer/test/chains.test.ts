/**
 * Unit tests for the indexer chain registry (src/chains.ts).
 *
 * These tests:
 *   1. Assert every canonical chain entry has the expected shape.
 *   2. Verify the BSC (chain 56) entry specifically — correctness of
 *      chainId, slug, env var names, gateway URL, and finality setting.
 *   3. Verify the Polygon (chain 137) entry — locked config from grill 2026-05-29.
 *   4. Confirm `getChain` resolves known slugs and throws on unknown ones
 *      (fail-fast, never silently default).
 *   5. Confirm CHAIN_SLUGS is exhaustive and matches CHAINS keys.
 */
import { describe, expect, test } from 'bun:test'
import {
  CHAINS,
  CHAIN_SLUGS,
  ChainConfig,
  ChainSlug,
  getChain,
} from '../src/chains'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const assertChainShape = (cfg: ChainConfig): void => {
  expect(typeof cfg.chainId).toBe('number')
  expect(cfg.chainId).toBeGreaterThan(0)
  expect(typeof cfg.slug).toBe('string')
  expect(cfg.slug.length).toBeGreaterThan(0)
  expect(typeof cfg.name).toBe('string')
  expect(cfg.name.length).toBeGreaterThan(0)
  // gateway is string | null — both are valid
  expect(cfg.gateway === null || typeof cfg.gateway === 'string').toBe(true)
  expect(typeof cfg.rpcEnvVar).toBe('string')
  expect(cfg.rpcEnvVar.length).toBeGreaterThan(0)
  expect(typeof cfg.contractEnvVar).toBe('string')
  expect(cfg.contractEnvVar.length).toBeGreaterThan(0)
  expect(typeof cfg.startBlockEnvVar).toBe('string')
  expect(cfg.startBlockEnvVar.length).toBeGreaterThan(0)
  expect(typeof cfg.finalityConfirmation).toBe('number')
  expect(cfg.finalityConfirmation).toBeGreaterThanOrEqual(0)
  expect(typeof cfg.rpcRateLimit).toBe('number')
  expect(cfg.rpcRateLimit).toBeGreaterThan(0)
}

// ---------------------------------------------------------------------------
// CHAIN_SLUGS integrity
// ---------------------------------------------------------------------------

describe('CHAIN_SLUGS', () => {
  test('matches the keys of CHAINS exactly', () => {
    const slugSet = new Set(CHAIN_SLUGS)
    const keySet = new Set(Object.keys(CHAINS) as ChainSlug[])
    expect(slugSet).toEqual(keySet)
  })

  test('includes bsc', () => {
    expect(CHAIN_SLUGS).toContain('bsc')
  })

  test('includes polygon', () => {
    expect(CHAIN_SLUGS).toContain('polygon')
  })
})

// ---------------------------------------------------------------------------
// Shape invariants — every entry must satisfy the ChainConfig contract
// ---------------------------------------------------------------------------

describe('CHAINS shape invariants', () => {
  for (const [slug, cfg] of Object.entries(CHAINS)) {
    test(`${slug} has valid ChainConfig shape`, () => {
      assertChainShape(cfg)
    })

    test(`${slug} slug field matches map key`, () => {
      expect(cfg.slug).toBe(slug)
    })
  }
})

// ---------------------------------------------------------------------------
// BSC-specific assertions
// ---------------------------------------------------------------------------

describe('CHAINS.bsc', () => {
  const bsc = CHAINS['bsc']

  test('chainId is 56', () => {
    expect(bsc.chainId).toBe(56)
  })

  test('slug is bsc', () => {
    expect(bsc.slug).toBe('bsc')
  })

  test('rpcEnvVar is RPC_BSC_HTTP', () => {
    expect(bsc.rpcEnvVar).toBe('RPC_BSC_HTTP')
  })

  test('contractEnvVar is CONTRACT_BSC', () => {
    expect(bsc.contractEnvVar).toBe('CONTRACT_BSC')
  })

  test('startBlockEnvVar is START_BLOCK_BSC', () => {
    expect(bsc.startBlockEnvVar).toBe('START_BLOCK_BSC')
  })

  test('gateway points to binance-mainnet Subsquid archive', () => {
    expect(bsc.gateway).toBe(
      'https://v2.archive.subsquid.io/network/binance-mainnet',
    )
  })

  test('finalityConfirmation is > 0 (PoSA real-chain, not Anvil)', () => {
    expect(bsc.finalityConfirmation).toBeGreaterThan(0)
  })

  test('rpcRateLimit is 10 (matches other mainnet chains)', () => {
    expect(bsc.rpcRateLimit).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Polygon-specific assertions
// ---------------------------------------------------------------------------

describe('CHAINS.polygon', () => {
  const polygon = CHAINS['polygon']

  test('chainId is 137', () => {
    expect(polygon.chainId).toBe(137)
  })

  test('slug is polygon', () => {
    expect(polygon.slug).toBe('polygon')
  })

  test('name is Polygon', () => {
    expect(polygon.name).toBe('Polygon')
  })

  test('rpcEnvVar is RPC_POLYGON_HTTP', () => {
    expect(polygon.rpcEnvVar).toBe('RPC_POLYGON_HTTP')
  })

  test('contractEnvVar is CONTRACT_POLYGON', () => {
    expect(polygon.contractEnvVar).toBe('CONTRACT_POLYGON')
  })

  test('startBlockEnvVar is START_BLOCK_POLYGON', () => {
    expect(polygon.startBlockEnvVar).toBe('START_BLOCK_POLYGON')
  })

  test('gateway points to polygon-mainnet Subsquid archive', () => {
    expect(polygon.gateway).toBe(
      'https://v2.archive.subsquid.io/network/polygon-mainnet',
    )
  })

  test('finalityConfirmation is 100 (deep reorg window for Polygon PoS)', () => {
    expect(polygon.finalityConfirmation).toBe(100)
  })

  test('rpcRateLimit is 10 (matches other mainnet chains)', () => {
    expect(polygon.rpcRateLimit).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// getChain — lookup + fail-fast
// ---------------------------------------------------------------------------

describe('getChain', () => {
  test('resolves bsc by slug', () => {
    const cfg = getChain('bsc')
    expect(cfg.chainId).toBe(56)
  })

  test('resolves ethereum by slug', () => {
    const cfg = getChain('ethereum')
    expect(cfg.chainId).toBe(1)
  })

  test('resolves polygon by slug', () => {
    const cfg = getChain('polygon')
    expect(cfg.chainId).toBe(137)
  })

  test('throws on unknown slug', () => {
    expect(() => getChain('solana')).toThrow(/Unknown chain slug/)
  })

  test('error message lists known slugs', () => {
    try {
      getChain('unknown-chain')
    } catch (e) {
      expect(String(e)).toContain('bsc')
      expect(String(e)).toContain('ethereum')
      expect(String(e)).toContain('polygon')
    }
  })
})

// ---------------------------------------------------------------------------
// Chain id uniqueness — two entries must not share a chain id
// ---------------------------------------------------------------------------

describe('CHAINS uniqueness', () => {
  test('every chainId is unique', () => {
    const ids = Object.values(CHAINS).map((c) => c.chainId)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })
})
