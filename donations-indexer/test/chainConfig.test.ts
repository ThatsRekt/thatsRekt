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

  test('ethereum rpcEnvKey is RPC_ETHEREUM_HTTP', () => {
    expect(chainConfigFor('ethereum')?.rpcEnvKey).toBe('RPC_ETHEREUM_HTTP')
  })

  test('base rpcEnvKey is RPC_BASE_HTTP', () => {
    expect(chainConfigFor('base')?.rpcEnvKey).toBe('RPC_BASE_HTTP')
  })

  test('arbitrum rpcEnvKey is RPC_ARBITRUM_HTTP', () => {
    expect(chainConfigFor('arbitrum')?.rpcEnvKey).toBe('RPC_ARBITRUM_HTTP')
  })

  test('optimism rpcEnvKey is RPC_OPTIMISM_HTTP', () => {
    expect(chainConfigFor('optimism')?.rpcEnvKey).toBe('RPC_OPTIMISM_HTTP')
  })

  test('bsc rpcEnvKey is RPC_BSC_HTTP', () => {
    expect(chainConfigFor('bsc')?.rpcEnvKey).toBe('RPC_BSC_HTTP')
  })

  test('polygon rpcEnvKey is RPC_POLYGON_HTTP', () => {
    expect(chainConfigFor('polygon')?.rpcEnvKey).toBe('RPC_POLYGON_HTTP')
  })

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
