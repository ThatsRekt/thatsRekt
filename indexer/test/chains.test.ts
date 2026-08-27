import { describe, expect, test } from 'bun:test'
import {
  CHAINS,
  CHAIN_SLUGS,
  type ChainConfig,
  type ChainSlug,
  getChain,
} from '../src/chains'

const PRODUCTION_DATASETS = Object.freeze({
  ethereum: 'ethereum-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arbitrum-one',
  optimism: 'optimism-mainnet',
  bsc: 'binance-mainnet',
  polygon: 'polygon-mainnet',
})

const RPC_ONLY_SLUGS = Object.freeze([
  'anvil-eth',
  'anvil-base',
  'sepolia',
  'base-sepolia',
] as const)

const assertChainShape = (chain: ChainConfig): void => {
  expect(typeof chain.chainId).toBe('number')
  expect(chain.chainId).toBeGreaterThan(0)
  expect(typeof chain.slug).toBe('string')
  expect(chain.slug.length).toBeGreaterThan(0)
  expect(typeof chain.name).toBe('string')
  expect(chain.name.length).toBeGreaterThan(0)
  expect(typeof chain.finalityConfirmation).toBe('number')
  expect(chain.finalityConfirmation).toBeGreaterThanOrEqual(0)

  if (chain.source.kind === 'portal') {
    expect(typeof chain.source.dataset).toBe('string')
    expect(chain.source.dataset.length).toBeGreaterThan(0)
  } else {
    expect(typeof chain.source.rpcEnvVar).toBe('string')
    expect(chain.source.rpcEnvVar.length).toBeGreaterThan(0)
    expect(chain.source.rpcRateLimit).toBeGreaterThan(0)
  }
}

describe('Registry chain registry', () => {
  test('has a slug list matching its keys exactly', () => {
    expect([...CHAIN_SLUGS].sort()).toEqual(Object.keys(CHAINS).sort())
  })

  for (const [slug, chain] of Object.entries(CHAINS)) {
    test(`${slug} has a valid source discriminant`, () => {
      assertChainShape(chain)
      expect(chain.slug).toBe(slug)
    })
  }

  for (const [slug, dataset] of Object.entries(PRODUCTION_DATASETS)) {
    test(`${slug} uses its exact Portal Dataset Endpoint`, () => {
      const source = CHAINS[slug as keyof typeof CHAINS].source
      expect(source).toEqual({ kind: 'portal', dataset })
    })
  }

  test.each(RPC_ONLY_SLUGS)('%s remains an explicit RPC-only chain', (slug) => {
    expect(CHAINS[slug].source.kind).toBe('rpc')
  })

  test('keeps BNB Chain finality at 15 confirmations', () => {
    expect(CHAINS.bsc.finalityConfirmation).toBe(15)
  })

  test('keeps Polygon finality at 100 confirmations', () => {
    expect(CHAINS.polygon.finalityConfirmation).toBe(100)
  })

  test('resolves known chain slugs and rejects unknown ones', () => {
    expect(getChain('base').chainId).toBe(8453)
    expect(() => getChain('solana')).toThrow(/Unknown chain slug/)
  })

  test('never reuses an EIP-155 chain id', () => {
    const ids = Object.values(CHAINS).map((chain) => chain.chainId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
