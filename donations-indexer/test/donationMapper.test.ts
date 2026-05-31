/**
 * Unit tests for donationMapper — pure module, no I/O.
 * Written test-first (TDD).
 */
import { describe, expect, test } from 'bun:test'
import { mapNativeTransfer, normalizAmount, type NativeTransferInput } from '../src/donationMapper.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT: NativeTransferInput = Object.freeze({
  chainId: 1,
  chainSlug: 'ethereum',
  fromAddress: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
  txHash: '0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1',
  blockNumber: 20_000_000,
  blockTimestampMs: 1_700_000_000_000,
  value: 1_000_000_000_000_000_000n, // 1 ETH
})

// ---------------------------------------------------------------------------
// normalizAmount
// ---------------------------------------------------------------------------

describe('normalizAmount', () => {
  test('1 ETH (1e18 wei, 18 decimals) = "1"', () => {
    expect(normalizAmount(1_000_000_000_000_000_000n, 18)).toBe('1')
  })

  test('0.5 ETH (5e17 wei) = "0.5"', () => {
    expect(normalizAmount(500_000_000_000_000_000n, 18)).toBe('0.5')
  })

  test('0.0001 ETH (1e14 wei) = "0.0001"', () => {
    expect(normalizAmount(100_000_000_000_000n, 18)).toBe('0.0001')
  })

  test('trailing zeros stripped: 1.50 ETH = "1.5"', () => {
    expect(normalizAmount(1_500_000_000_000_000_000n, 18)).toBe('1.5')
  })

  test('0 decimals returns raw toString', () => {
    expect(normalizAmount(12345n, 0)).toBe('12345')
  })

  test('small fractional: 1 wei = "0.000000000000000001"', () => {
    expect(normalizAmount(1n, 18)).toBe('0.000000000000000001')
  })

  test('6 decimals: 1_000_000 = "1"', () => {
    expect(normalizAmount(1_000_000n, 6)).toBe('1')
  })

  test('6 decimals: 1_500_000 = "1.5"', () => {
    expect(normalizAmount(1_500_000n, 6)).toBe('1.5')
  })
})

// ---------------------------------------------------------------------------
// mapNativeTransfer — success path
// ---------------------------------------------------------------------------

describe('mapNativeTransfer — success path', () => {
  test('returns a DonationRow for a valid 1 ETH transfer on Ethereum', () => {
    const row = mapNativeTransfer(BASE_INPUT)
    expect(row).not.toBeNull()
    expect(row!.id).toBe(`1-${BASE_INPUT.txHash}-native`)
    expect(row!.chainId).toBe(1)
    expect(row!.chainSlug).toBe('ethereum')
    expect(row!.fromAddress).toBe(BASE_INPUT.fromAddress.toLowerCase())
    expect(row!.tokenAddress).toBeNull()
    expect(row!.tokenSymbol).toBe('ETH')
    expect(row!.tokenDecimals).toBe(18)
    expect(row!.amountRaw).toBe('1000000000000000000')
    expect(row!.amountNorm).toBe('1')
    expect(row!.txHash).toBe(BASE_INPUT.txHash)
    expect(row!.logIndex).toBeNull()
    expect(row!.blockNumber).toBe(BASE_INPUT.blockNumber)
    expect(row!.blockTimestamp).toEqual(new Date(BASE_INPUT.blockTimestampMs))
  })

  test('fromAddress is lowercased', () => {
    const row = mapNativeTransfer({
      ...BASE_INPUT,
      fromAddress: '0xAB5801A7D398351B8BE11C439E05C5B3259AEC9B',
    })
    expect(row!.fromAddress).toBe('0xab5801a7d398351b8be11c439e05c5b3259aec9b')
  })

  test('id is stable regardless of address casing', () => {
    const row1 = mapNativeTransfer({ ...BASE_INPUT, fromAddress: '0xABC' })
    const row2 = mapNativeTransfer({ ...BASE_INPUT, fromAddress: '0xabc' })
    expect(row1!.id).toBe(row2!.id)
  })
})

// ---------------------------------------------------------------------------
// mapNativeTransfer — drop conditions
// ---------------------------------------------------------------------------

describe('mapNativeTransfer — drop conditions', () => {
  test('returns null when value is below dust floor (1 wei)', () => {
    const row = mapNativeTransfer({ ...BASE_INPUT, value: 1n })
    expect(row).toBeNull()
  })

  test('returns null when value is exactly at floor - 1 (floor - 1 wei)', () => {
    // floor is 1e14 (100_000_000_000_000n); floor - 1 should be dropped
    const row = mapNativeTransfer({ ...BASE_INPUT, value: 99_999_999_999_999n })
    expect(row).toBeNull()
  })

  test('returns non-null when value equals the exact floor', () => {
    // Exactly at floor should pass
    const row = mapNativeTransfer({ ...BASE_INPUT, value: 100_000_000_000_000n })
    expect(row).not.toBeNull()
    expect(row!.amountNorm).toBe('0.0001')
  })

  test('returns null for an unknown chain (e.g. Base chainId 8453 not yet added)', () => {
    const row = mapNativeTransfer({ ...BASE_INPUT, chainId: 8453, chainSlug: 'base' })
    expect(row).toBeNull()
  })

  test('returns null for a completely unknown chain', () => {
    const row = mapNativeTransfer({ ...BASE_INPUT, chainId: 999999, chainSlug: 'unknown' })
    expect(row).toBeNull()
  })
})
