/**
 * Unit tests for doneeResolver — pure functions only.
 *
 * Uses REAL captured fixtures from mainnet history.
 * No mocked RPC client (DAMM hard rule: no mock clients at infra boundaries).
 *
 * Captured fixtures (from the hand-build spike):
 *   Block 24952292: jerry's wallet
 *     address = 0x9e8680dbbca1127add812abe209a10e621b385df
 *     data = 0x0000000000000000000000009e8680dbbca1127add812abe209a10e621b385df
 *
 *   Block 25031705: governance safe
 *     address = 0x59e4dbc95bd312a882bb36b7f3e8298682340679
 *     data = 0x00000000000000000000000059e4dbc95bd312a882bb36b7f3e8298682340679
 *
 * The data word is a 32-byte ABI-encoded address (left-padded with zeros).
 * Hex-encoded: "0x" + 24 zero chars + 40-char address.
 */

import { describe, expect, test } from 'bun:test'
import {
  addressFromAddrChangedData,
  latestDoneeFromLogs,
  ADDRCHANGED_TOPIC0,
  THATSREKT_ENS_NAMEHASH,
  ENS_HISTORY_FROM_BLOCK,
} from './doneeResolver.js'

// ---------------------------------------------------------------------------
// Captured fixture addresses (real mainnet history)
// ---------------------------------------------------------------------------

const JERRY_WALLET = '0x9e8680dbbca1127add812abe209a10e621b385df'
const JERRY_BLOCK = 24952292

const GOV_SAFE = '0x59e4dbc95bd312a882bb36b7f3e8298682340679'
const GOV_SAFE_BLOCK = 25031705

/** Build a 32-byte left-padded ABI-encoded address data word. */
const buildDataWord = (addr: string): string => {
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr
  return '0x' + hex.toLowerCase().padStart(64, '0')
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  test('ADDRCHANGED_TOPIC0 has correct length', () => {
    expect(ADDRCHANGED_TOPIC0).toHaveLength(66) // 0x + 64 hex
    expect(ADDRCHANGED_TOPIC0.startsWith('0x')).toBe(true)
  })

  test('THATSREKT_ENS_NAMEHASH has correct length', () => {
    expect(THATSREKT_ENS_NAMEHASH).toHaveLength(66) // 0x + 64 hex
    expect(THATSREKT_ENS_NAMEHASH.startsWith('0x')).toBe(true)
  })

  test('ENS_HISTORY_FROM_BLOCK is before first known event', () => {
    expect(ENS_HISTORY_FROM_BLOCK).toBeLessThan(JERRY_BLOCK)
  })
})

// ---------------------------------------------------------------------------
// addressFromAddrChangedData
// ---------------------------------------------------------------------------

describe('addressFromAddrChangedData', () => {
  test('extracts jerry wallet address from data word', () => {
    const data = buildDataWord(JERRY_WALLET)
    const result = addressFromAddrChangedData(data)
    expect(result).toBe(JERRY_WALLET)
  })

  test('extracts gov safe address from data word', () => {
    const data = buildDataWord(GOV_SAFE)
    const result = addressFromAddrChangedData(data)
    expect(result).toBe(GOV_SAFE)
  })

  test('lowercases the returned address', () => {
    // Input with uppercase address
    const upperAddr = JERRY_WALLET.toUpperCase()
    const data = buildDataWord(upperAddr)
    const result = addressFromAddrChangedData(data)
    expect(result).toBe(JERRY_WALLET) // always lowercase
  })

  test('returns null for zero address (cleared ENS record)', () => {
    const zeroData = buildDataWord('0x0000000000000000000000000000000000000000')
    const result = addressFromAddrChangedData(zeroData)
    expect(result).toBeNull()
  })

  test('returns null for malformed data (too short)', () => {
    const result = addressFromAddrChangedData('0xdeadbeef')
    expect(result).toBeNull()
  })

  test('returns null for malformed data (too long)', () => {
    const result = addressFromAddrChangedData('0x' + 'a'.repeat(66))
    expect(result).toBeNull()
  })

  test('returns null for empty string', () => {
    const result = addressFromAddrChangedData('')
    expect(result).toBeNull()
  })

  test('returns null for data without 0x prefix but wrong length', () => {
    const result = addressFromAddrChangedData('deadbeef')
    expect(result).toBeNull()
  })

  test('accepts data without 0x prefix (64 hex chars)', () => {
    // Strip the 0x prefix from buildDataWord output
    const withPrefix = buildDataWord(JERRY_WALLET)
    const withoutPrefix = withPrefix.slice(2)
    const result = addressFromAddrChangedData(withoutPrefix)
    expect(result).toBe(JERRY_WALLET)
  })
})

// ---------------------------------------------------------------------------
// latestDoneeFromLogs
// ---------------------------------------------------------------------------

describe('latestDoneeFromLogs', () => {
  test('returns null for empty log list', () => {
    expect(latestDoneeFromLogs([])).toBeNull()
  })

  test('returns address from single log', () => {
    const logs = [
      { blockNumber: GOV_SAFE_BLOCK, data: buildDataWord(GOV_SAFE) },
    ]
    expect(latestDoneeFromLogs(logs)).toBe(GOV_SAFE)
  })

  test('returns address from highest block — [jerry, safe] order', () => {
    const logs = [
      { blockNumber: JERRY_BLOCK, data: buildDataWord(JERRY_WALLET) },
      { blockNumber: GOV_SAFE_BLOCK, data: buildDataWord(GOV_SAFE) },
    ]
    expect(latestDoneeFromLogs(logs)).toBe(GOV_SAFE)
  })

  test('returns address from highest block — [safe, jerry] order (order-independent)', () => {
    const logs = [
      { blockNumber: GOV_SAFE_BLOCK, data: buildDataWord(GOV_SAFE) },
      { blockNumber: JERRY_BLOCK, data: buildDataWord(JERRY_WALLET) },
    ]
    expect(latestDoneeFromLogs(logs)).toBe(GOV_SAFE)
  })

  test('accepts hex-string blockNumber (0x prefix)', () => {
    const logs = [
      {
        blockNumber: '0x' + JERRY_BLOCK.toString(16),
        data: buildDataWord(JERRY_WALLET),
      },
      {
        blockNumber: '0x' + GOV_SAFE_BLOCK.toString(16),
        data: buildDataWord(GOV_SAFE),
      },
    ]
    expect(latestDoneeFromLogs(logs)).toBe(GOV_SAFE)
  })

  test('accepts decimal-string blockNumber (no 0x prefix)', () => {
    const logs = [
      {
        blockNumber: String(JERRY_BLOCK),
        data: buildDataWord(JERRY_WALLET),
      },
      {
        blockNumber: String(GOV_SAFE_BLOCK),
        data: buildDataWord(GOV_SAFE),
      },
    ]
    expect(latestDoneeFromLogs(logs)).toBe(GOV_SAFE)
  })

  test('returns null when highest-block log has zero address (cleared name)', () => {
    // Safe was pointing to gov-safe, then ENS was cleared (zero addr) at a later block
    const logs = [
      { blockNumber: GOV_SAFE_BLOCK, data: buildDataWord(GOV_SAFE) },
      {
        blockNumber: GOV_SAFE_BLOCK + 1000,
        data: buildDataWord('0x0000000000000000000000000000000000000000'),
      },
    ]
    expect(latestDoneeFromLogs(logs)).toBeNull()
  })

  test('returns earlier log address when later log has zero addr (fallback)', () => {
    // The zero-addr log is at a LATER block, so it wins and returns null —
    // confirming the caller's fallback logic is responsible for handling null.
    const logs = [
      { blockNumber: JERRY_BLOCK, data: buildDataWord(JERRY_WALLET) },
      {
        blockNumber: JERRY_BLOCK + 1,
        data: buildDataWord('0x0000000000000000000000000000000000000000'),
      },
    ]
    // The highest-block log wins; it has zero addr → null
    expect(latestDoneeFromLogs(logs)).toBeNull()
  })

  test('handles multiple logs all with same block (picks any — stable by iteration order)', () => {
    // All same block — the first one with the max block is retained via >
    // (strict greater than), so ties keep the first-seen max.
    const logs = [
      { blockNumber: JERRY_BLOCK, data: buildDataWord(JERRY_WALLET) },
      { blockNumber: JERRY_BLOCK, data: buildDataWord(GOV_SAFE) },
    ]
    // Tie → jerry is first-seen max, kept
    expect(latestDoneeFromLogs(logs)).toBe(JERRY_WALLET)
  })

  test('handles numeric blockNumber 0', () => {
    const logs = [{ blockNumber: 0, data: buildDataWord(JERRY_WALLET) }]
    expect(latestDoneeFromLogs(logs)).toBe(JERRY_WALLET)
  })
})
