/**
 * EVM address utilities.
 *
 * The indexer lowercases all addresses; wagmi returns EIP-55 checksum form.
 * Always normalize before comparing — never compare address strings raw.
 */

/**
 * Null-safe, case-insensitive EVM address equality.
 *
 * Returns `false` for any nullish input so callers can safely pass optional
 * wagmi `address` values without a guard clause.
 *
 * @example
 *   isSameAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
 *                 '0xd8da6bf26964af9d7eed9e03e53415d37aa96045') // → true
 *   isSameAddress(undefined, '0x...') // → false
 */
export function isSameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}
