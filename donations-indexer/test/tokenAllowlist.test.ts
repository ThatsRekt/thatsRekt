/**
 * Unit tests for tokenAllowlist — pure module, no I/O.
 * Written test-first (TDD).
 */
import { describe, expect, test } from 'bun:test'
import {
  allowlistFor,
  isAllowed,
  nativeFloor,
  tokenMeta,
} from '../src/tokenAllowlist.ts'

describe('allowlistFor', () => {
  test('returns non-null for Ethereum mainnet (chainId 1)', () => {
    expect(allowlistFor(1)).not.toBeNull()
  })

  test('returns null for unknown chain', () => {
    expect(allowlistFor(999999)).toBeNull()
  })

  test('Ethereum allowlist has native entry with ETH symbol', () => {
    const list = allowlistFor(1)
    expect(list?.native.symbol).toBe('ETH')
    expect(list?.native.decimals).toBe(18)
  })

  test('Ethereum nativeFloorWei is greater than 0', () => {
    const list = allowlistFor(1)
    expect(list!.nativeFloorWei).toBeGreaterThan(0n)
  })
})

describe('isAllowed', () => {
  test('native (null tokenAddress) is allowed on Ethereum', () => {
    expect(isAllowed(1, null)).toBe(true)
  })

  test('unknown token address is NOT allowed on Ethereum', () => {
    expect(isAllowed(1, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false)
  })

  test('native is NOT allowed on unknown chain', () => {
    expect(isAllowed(999999, null)).toBe(false)
  })
})

describe('nativeFloor', () => {
  test('Ethereum floor is positive (100000000000000 wei)', () => {
    const floor = nativeFloor(1)
    expect(floor).toBe(100_000_000_000_000n)
  })

  test('unknown chain returns 0n (fail-open)', () => {
    expect(nativeFloor(999999)).toBe(0n)
  })
})

describe('tokenMeta', () => {
  test('native token meta on Ethereum: ETH, 18 decimals', () => {
    const meta = tokenMeta(1, null)
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('ETH')
    expect(meta!.decimals).toBe(18)
  })

  test('unknown ERC20 on Ethereum returns null', () => {
    expect(tokenMeta(1, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
  })

  test('unknown chain returns null', () => {
    expect(tokenMeta(999999, null)).toBeNull()
  })
})
