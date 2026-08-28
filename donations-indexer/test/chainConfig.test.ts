/**
 * Unit tests for chainConfig — pure module, no I/O.
 *
 * Slice #209: multi-chain processor parameterization.
 */
import { describe, expect, test } from 'bun:test'
import { chainConfigFor, supportedSlugs } from '../src/chainConfig.ts'

describe('chainConfigFor', () => {
  test('returns null for unknown slug', () => {
    expect(chainConfigFor('solana')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(chainConfigFor('')).toBeNull()
  })

  test('is case-insensitive (ETHEREUM -> ethereum)', () => {
    expect(chainConfigFor('ETHEREUM')).not.toBeNull()
  })

  test('ethereum config has chainId=1', () => {
    expect(chainConfigFor('ethereum')?.chainId).toBe(1)
  })

  test('base config has chainId=8453', () => {
    expect(chainConfigFor('base')?.chainId).toBe(8453)
  })

  test('arbitrum config has chainId=42161', () => {
    expect(chainConfigFor('arbitrum')?.chainId).toBe(42161)
  })

  test('optimism config has chainId=10', () => {
    expect(chainConfigFor('optimism')?.chainId).toBe(10)
  })

  test('bsc config has chainId=56', () => {
    expect(chainConfigFor('bsc')?.chainId).toBe(56)
  })

  test('polygon config has chainId=137', () => {
    expect(chainConfigFor('polygon')?.chainId).toBe(137)
  })

  test.each([
    ['ethereum', 'ethereum-mainnet', 'RPC_ETHEREUM_HTTP'],
    ['base', 'base-mainnet', 'RPC_BASE_HTTP'],
    ['arbitrum', 'arbitrum-one', 'RPC_ARBITRUM_HTTP'],
    ['optimism', 'optimism-mainnet', 'RPC_OPTIMISM_HTTP'],
    ['bsc', 'binance-mainnet', 'RPC_BSC_HTTP'],
    ['polygon', 'polygon-mainnet', 'RPC_POLYGON_HTTP'],
  ])(
    '%s uses its Portal Dataset Endpoint and RPC only for the head control plane',
    (slug, portalDataset, headRpcEnvKey) => {
      const config = chainConfigFor(slug)
      expect(config?.portalDataset).toBe(portalDataset)
      expect(config?.headRpcEnvKey).toBe(headRpcEnvKey)
    },
  )

  test('ethereum startBlockEnvKey is START_BLOCK_ETHEREUM', () => {
    expect(chainConfigFor('ethereum')?.startBlockEnvKey).toBe('START_BLOCK_ETHEREUM')
  })

  test('base startBlockEnvKey is START_BLOCK_BASE', () => {
    expect(chainConfigFor('base')?.startBlockEnvKey).toBe('START_BLOCK_BASE')
  })

  test('all defaultStartBlocks are positive integers', () => {
    for (const slug of ['ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon']) {
      const cfg = chainConfigFor(slug)
      expect(cfg?.defaultStartBlock).toBeGreaterThan(0)
    }
  })

  test('all finalityConfirmations are positive integers', () => {
    for (const slug of ['ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon']) {
      const cfg = chainConfigFor(slug)
      expect(cfg?.finalityConfirmation).toBeGreaterThan(0)
    }
  })

  test('ethereum defaultStartBlock is 19_000_000', () => {
    expect(chainConfigFor('ethereum')?.defaultStartBlock).toBe(19_000_000)
  })

  test('base defaultStartBlock is 45_301_000', () => {
    expect(chainConfigFor('base')?.defaultStartBlock).toBe(45_301_000)
  })

  test('arbitrum defaultStartBlock is 457_275_000', () => {
    expect(chainConfigFor('arbitrum')?.defaultStartBlock).toBe(457_275_000)
  })

  test('optimism defaultStartBlock is 150_896_000', () => {
    expect(chainConfigFor('optimism')?.defaultStartBlock).toBe(150_896_000)
  })

  test('bsc defaultStartBlock is 95_195_000', () => {
    expect(chainConfigFor('bsc')?.defaultStartBlock).toBe(95_195_000)
  })

  test('polygon defaultStartBlock is 86_136_000', () => {
    expect(chainConfigFor('polygon')?.defaultStartBlock).toBe(86_136_000)
  })
})

describe('supportedSlugs', () => {
  test('returns exactly 6 chains', () => {
    expect(supportedSlugs()).toHaveLength(6)
  })

  test('includes all expected slugs', () => {
    const slugs = supportedSlugs()
    for (const slug of ['ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon']) {
      expect(slugs).toContain(slug)
    }
  })
})
