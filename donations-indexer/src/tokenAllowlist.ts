/**
 * Token allowlist for the donations indexer.
 *
 * Walking skeleton (slice #205): Ethereum only, native ETH only.
 * Later slices add ERC20 entries and additional chains.
 *
 * Design:
 * - Pure module — no I/O, no side effects. Testable in total isolation.
 * - `nativeFloor(chainId)` filters 1-wei spam; returns 0n for unknown chains
 *   (fail-open on unfamiliar chains — the processor validates chain before
 *   calling, so returning 0n for unknown is safe).
 * - `isAllowed(chainId, tokenAddress)` returns true for the native sentinel
 *   (null/undefined/'') and for any whitelisted ERC20. Returns false for
 *   unknown chains or unknown tokens.
 * - `tokenMeta(chainId, tokenAddress)` returns symbol + decimals for allowed
 *   tokens. Returns null for unknown tokens (processor skips them).
 *
 * The native sentinel is represented as null (tokenAddress === null).
 * ERC20 entries are lowercased addresses.
 */

export interface TokenMeta {
  readonly symbol: string
  readonly decimals: number
}

export interface ChainAllowlist {
  /** Native coin entry. */
  readonly native: TokenMeta
  /** Dust floor in native base units (wei). Transfers below this are dropped. */
  readonly nativeFloorWei: bigint
  /** ERC20 allowlist: lowercased address -> meta. */
  readonly erc20: Readonly<Record<string, TokenMeta>>
}

// Ethereum mainnet — slice #205: native ETH only.
// ERC20 entries will be added in slice #207.
const ETHEREUM_ALLOWLIST: ChainAllowlist = Object.freeze({
  native: Object.freeze({ symbol: 'ETH', decimals: 18 }),
  // 0.0001 ETH dust floor (1e14 wei). Filters 1-wei spam while still
  // allowing any meaningful micro-donation.
  nativeFloorWei: 100_000_000_000_000n,
  erc20: Object.freeze({}),
})

// Allowlist registry keyed by EIP-155 chain id.
// Chains absent from this map are not indexed by the donations processor.
const ALLOWLISTS: Readonly<Record<number, ChainAllowlist>> = Object.freeze({
  1: ETHEREUM_ALLOWLIST,
})

/** Return the allowlist for a chain, or null if the chain is not indexed. */
export const allowlistFor = (chainId: number): ChainAllowlist | null =>
  ALLOWLISTS[chainId] ?? null

/**
 * Is `tokenAddress` allowlisted on `chainId`?
 * `tokenAddress` is null for native-coin transfers.
 */
export const isAllowed = (chainId: number, tokenAddress: string | null): boolean => {
  const list = allowlistFor(chainId)
  if (!list) return false
  if (tokenAddress === null) return true
  return Object.prototype.hasOwnProperty.call(list.erc20, tokenAddress.toLowerCase())
}

/**
 * Return the native dust floor (in wei) for a chain.
 * Returns 0n for unknown chains (fail-open; caller validates chain before use).
 */
export const nativeFloor = (chainId: number): bigint =>
  allowlistFor(chainId)?.nativeFloorWei ?? 0n

/**
 * Return token metadata for an allowlisted token.
 * `tokenAddress` is null for the native coin.
 * Returns null for unknown chains or tokens (caller skips the transfer).
 */
export const tokenMeta = (chainId: number, tokenAddress: string | null): TokenMeta | null => {
  const list = allowlistFor(chainId)
  if (!list) return null
  if (tokenAddress === null) return list.native
  return list.erc20[tokenAddress.toLowerCase()] ?? null
}
