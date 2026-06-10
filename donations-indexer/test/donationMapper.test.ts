/**
 * Unit tests for donationMapper — pure module, no I/O.
 * Written test-first (TDD).
 *
 * Slice #207 additions: ERC20 branch tests (mapErc20Transfer).
 */
import { describe, expect, test } from 'bun:test'
import {
  mapNativeTransfer,
  mapErc20Transfer,
  normalizAmount,
  type NativeTransferInput,
  type Erc20TransferInput,
} from '../src/donationMapper.ts'

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

// USDC — 6 decimals, allowlisted on Ethereum
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
// WBTC — 8 decimals, allowlisted on Ethereum
const WBTC_ADDRESS = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'
// A random non-allowlisted token
const SPAM_TOKEN = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

const DONATION_SAFE = '0x59e4dbc95bd312a882bb36b7f3e8298682340679'
const DONOR = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

const BASE_ERC20_INPUT: Erc20TransferInput = Object.freeze({
  chainId: 1,
  chainSlug: 'ethereum',
  tokenAddress: USDC_ADDRESS,
  fromAddress: DONOR,
  toAddress: DONATION_SAFE,
  amount: 1_000_000n, // 1 USDC (6 decimals)
  txHash: '0xerc20txhash00000000000000000000000000000000000000000000000000001',
  logIndex: 5,
  blockNumber: 20_000_001,
  blockTimestampMs: 1_700_000_012_000,
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

  test('8 decimals (WBTC): 100_000_000 = "1"', () => {
    expect(normalizAmount(100_000_000n, 8)).toBe('1')
  })

  test('8 decimals (WBTC): 50_000_000 = "0.5"', () => {
    expect(normalizAmount(50_000_000n, 8)).toBe('0.5')
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

  test('returns null for a completely unknown chain (e.g. chainId 9999)', () => {
    const row = mapNativeTransfer({ ...BASE_INPUT, chainId: 9999, chainSlug: 'unknown' })
    expect(row).toBeNull()
  })

  test('returns null for a completely unknown chain', () => {
    const row = mapNativeTransfer({ ...BASE_INPUT, chainId: 999999, chainSlug: 'unknown' })
    expect(row).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// mapErc20Transfer — success path
// ---------------------------------------------------------------------------

describe('mapErc20Transfer — success path', () => {
  test('returns a DonationRow for an allowlisted USDC transfer (6 decimals)', () => {
    const row = mapErc20Transfer(BASE_ERC20_INPUT)
    expect(row).not.toBeNull()
    expect(row!.id).toBe(`1-${BASE_ERC20_INPUT.txHash}-5`)
    expect(row!.chainId).toBe(1)
    expect(row!.chainSlug).toBe('ethereum')
    expect(row!.fromAddress).toBe(DONOR.toLowerCase())
    expect(row!.tokenAddress).toBe(USDC_ADDRESS)
    expect(row!.tokenSymbol).toBe('USDC')
    expect(row!.tokenDecimals).toBe(6)
    expect(row!.amountRaw).toBe('1000000')
    expect(row!.amountNorm).toBe('1')
    expect(row!.txHash).toBe(BASE_ERC20_INPUT.txHash)
    expect(row!.logIndex).toBe(5)
    expect(row!.blockNumber).toBe(BASE_ERC20_INPUT.blockNumber)
    expect(row!.blockTimestamp).toEqual(new Date(BASE_ERC20_INPUT.blockTimestampMs))
  })

  test('USDC 100.5 (6 decimals) normalizes correctly', () => {
    const row = mapErc20Transfer({ ...BASE_ERC20_INPUT, amount: 100_500_000n })
    expect(row).not.toBeNull()
    expect(row!.amountNorm).toBe('100.5')
    expect(row!.amountRaw).toBe('100500000')
  })

  test('WBTC 0.5 BTC (8 decimals) normalizes correctly', () => {
    const row = mapErc20Transfer({
      ...BASE_ERC20_INPUT,
      tokenAddress: WBTC_ADDRESS,
      amount: 50_000_000n,
      logIndex: 2,
    })
    expect(row).not.toBeNull()
    expect(row!.tokenSymbol).toBe('WBTC')
    expect(row!.tokenDecimals).toBe(8)
    expect(row!.amountNorm).toBe('0.5')
  })

  test('tokenAddress is lowercased in the row', () => {
    const row = mapErc20Transfer({
      ...BASE_ERC20_INPUT,
      tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // checksummed
    })
    expect(row).not.toBeNull()
    expect(row!.tokenAddress).toBe(USDC_ADDRESS)
  })

  test('fromAddress is lowercased in the row', () => {
    const row = mapErc20Transfer({
      ...BASE_ERC20_INPUT,
      fromAddress: '0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266',
    })
    expect(row).not.toBeNull()
    expect(row!.fromAddress).toBe(DONOR.toLowerCase())
  })

  test('id uses logIndex not "native"', () => {
    const row = mapErc20Transfer({ ...BASE_ERC20_INPUT, logIndex: 99 })
    expect(row!.id).toBe(`1-${BASE_ERC20_INPUT.txHash}-99`)
  })

  test('logIndex is populated (not null)', () => {
    const row = mapErc20Transfer(BASE_ERC20_INPUT)
    expect(row!.logIndex).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// mapErc20Transfer — drop conditions
// ---------------------------------------------------------------------------

describe('mapErc20Transfer — drop conditions (anti-spam guarantee)', () => {
  test('non-allowlisted token returns null', () => {
    const row = mapErc20Transfer({ ...BASE_ERC20_INPUT, tokenAddress: SPAM_TOKEN })
    expect(row).toBeNull()
  })

  test('zero amount returns null', () => {
    const row = mapErc20Transfer({ ...BASE_ERC20_INPUT, amount: 0n })
    expect(row).toBeNull()
  })

  test('unknown chain returns null even if address looks like a token', () => {
    const row = mapErc20Transfer({ ...BASE_ERC20_INPUT, chainId: 9999 })
    expect(row).toBeNull()
  })

  test('non-allowlisted token on unknown chain returns null', () => {
    const row = mapErc20Transfer({
      ...BASE_ERC20_INPUT,
      chainId: 999999,
      tokenAddress: SPAM_TOKEN,
    })
    expect(row).toBeNull()
  })
})
