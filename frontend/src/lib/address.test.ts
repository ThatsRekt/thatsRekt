/**
 * Tests for isSameAddress — null-safe, case-insensitive EVM address equality.
 *
 * The indexer lowercases addresses; wagmi returns EIP-55 checksum form.
 * Both forms must compare equal for the same underlying address.
 */
import { describe, expect, it } from 'bun:test'
import { isSameAddress } from './address'

// Same address in checksum form (EIP-55) and lowercase form.
const CHECKSUMMED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const LOWERCASED = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'

const OTHER_ADDRESS = '0x1234567890123456789012345678901234567890'

describe('isSameAddress', () => {
  it('returns true for checksum vs lowercase of the same address', () => {
    expect(isSameAddress(CHECKSUMMED, LOWERCASED)).toBe(true)
  })

  it('returns true for two identical strings', () => {
    expect(isSameAddress(CHECKSUMMED, CHECKSUMMED)).toBe(true)
    expect(isSameAddress(LOWERCASED, LOWERCASED)).toBe(true)
  })

  it('returns false for two different addresses', () => {
    expect(isSameAddress(CHECKSUMMED, OTHER_ADDRESS)).toBe(false)
    expect(isSameAddress(LOWERCASED, OTHER_ADDRESS)).toBe(false)
  })

  it('returns false when first argument is null', () => {
    expect(isSameAddress(null, LOWERCASED)).toBe(false)
  })

  it('returns false when second argument is null', () => {
    expect(isSameAddress(CHECKSUMMED, null)).toBe(false)
  })

  it('returns false when first argument is undefined', () => {
    expect(isSameAddress(undefined, LOWERCASED)).toBe(false)
  })

  it('returns false when second argument is undefined', () => {
    expect(isSameAddress(CHECKSUMMED, undefined)).toBe(false)
  })

  it('returns false when both arguments are null', () => {
    expect(isSameAddress(null, null)).toBe(false)
  })

  it('returns false when both arguments are undefined', () => {
    expect(isSameAddress(undefined, undefined)).toBe(false)
  })
})
