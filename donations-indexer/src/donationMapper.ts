/**
 * Donation mapper — pure transforms from raw chain data into normalized
 * DonationRows, or null when the transfer should be dropped.
 *
 * Slice #205: native-coin branch only.
 * Slice #207: ERC20 log branch added (mapErc20Transfer).
 *
 * Drop conditions (native):
 *   - Chain not in the allowlist.
 *   - Transfer value is below the per-chain native dust floor.
 *
 * Drop conditions (ERC20):
 *   - Chain not in the allowlist.
 *   - Token address not in the ERC20 allowlist.
 *   - Transfer amount is zero.
 *
 * Row IDs are deterministic:
 *   native: `${chainId}-${txHash}-native`
 *   ERC20:  `${chainId}-${txHash}-${logIndex}`
 * These keys are stable and safe to re-index (idempotent upsert downstream).
 *
 * amount_norm is computed as the human-readable decimal value:
 *   amount_norm = amount_raw / 10^decimals
 * Stored as a PostgreSQL NUMERIC string to avoid floating-point drift.
 */

import { nativeFloor, tokenMeta } from './tokenAllowlist.js'

export interface NativeTransferInput {
  readonly chainId: number
  readonly chainSlug: string
  readonly fromAddress: string
  readonly txHash: string
  readonly blockNumber: number
  /** Unix epoch milliseconds (Subsquid EVM block.header.timestamp is already ms). */
  readonly blockTimestampMs: number
  /** Transfer value in wei (bigint). */
  readonly value: bigint
}

/**
 * Decoded ERC-20 Transfer(address from, address to, uint256 amount) event.
 * All fields derived from the Subsquid log item before being passed here.
 */
export interface Erc20TransferInput {
  readonly chainId: number
  readonly chainSlug: string
  /** The ERC-20 contract address (lowercased). */
  readonly tokenAddress: string
  /** Decoded `from` field (topic1, lowercased). */
  readonly fromAddress: string
  /** Decoded `to` field (topic2, lowercased) — must be the donation Safe. */
  readonly toAddress: string
  /** Decoded transfer amount (uint256). */
  readonly amount: bigint
  readonly txHash: string
  readonly logIndex: number
  readonly blockNumber: number
  /** Unix epoch milliseconds. */
  readonly blockTimestampMs: number
}

export interface DonationRow {
  readonly id: string
  readonly chainId: number
  readonly chainSlug: string
  readonly fromAddress: string
  /** null for native-coin donations. */
  readonly tokenAddress: string | null
  readonly tokenSymbol: string
  readonly tokenDecimals: number
  readonly amountRaw: string
  /** Decimal string, human-readable nominal amount. */
  readonly amountNorm: string
  readonly txHash: string
  /** null for native-coin donations (no log). */
  readonly logIndex: number | null
  readonly blockNumber: number
  readonly blockTimestamp: Date
}

/**
 * Compute the human-readable amount string from raw base-unit amount.
 * Returns a decimal string with full precision — no rounding.
 * Pure function, no I/O.
 */
export const normalizAmount = (raw: bigint, decimals: number): string => {
  if (decimals === 0) return raw.toString()
  const factor = 10n ** BigInt(decimals)
  const whole = raw / factor
  const remainder = raw % factor
  if (remainder === 0n) return whole.toString()
  // Pad remainder to full decimal width, then strip trailing zeros.
  const fracStr = remainder.toString().padStart(decimals, '0')
  const stripped = fracStr.replace(/0+$/, '')
  return `${whole}.${stripped}`
}

/**
 * Map a native value-transfer to a DonationRow.
 * Returns null when the transfer should be dropped (below floor, unknown chain).
 *
 * Pure — no I/O, no side effects.
 */
export const mapNativeTransfer = (input: NativeTransferInput): DonationRow | null => {
  const floor = nativeFloor(input.chainId)
  const meta = tokenMeta(input.chainId, null)

  // Unknown chain — no allowlist entry.
  if (!meta) return null

  // Below dust floor — drop silently.
  if (input.value < floor) return null

  return Object.freeze({
    id: `${input.chainId}-${input.txHash}-native`,
    chainId: input.chainId,
    chainSlug: input.chainSlug,
    fromAddress: input.fromAddress.toLowerCase(),
    tokenAddress: null,
    tokenSymbol: meta.symbol,
    tokenDecimals: meta.decimals,
    amountRaw: input.value.toString(),
    amountNorm: normalizAmount(input.value, meta.decimals),
    txHash: input.txHash,
    logIndex: null,
    blockNumber: input.blockNumber,
    blockTimestamp: new Date(input.blockTimestampMs),
  })
}

/**
 * Map a decoded ERC-20 Transfer log to a DonationRow.
 * Returns null when the transfer should be dropped:
 *   - Token not in the allowlist (anti-spam guarantee).
 *   - Amount is zero.
 *
 * Pure — no I/O, no side effects.
 */
export const mapErc20Transfer = (input: Erc20TransferInput): DonationRow | null => {
  const meta = tokenMeta(input.chainId, input.tokenAddress)

  // Token not in the allowlist — drop (anti-spam: scam/poison tokens never land).
  if (!meta) return null

  // Zero-amount transfers are meaningless — drop.
  if (input.amount === 0n) return null

  return Object.freeze({
    id: `${input.chainId}-${input.txHash}-${input.logIndex}`,
    chainId: input.chainId,
    chainSlug: input.chainSlug,
    fromAddress: input.fromAddress.toLowerCase(),
    tokenAddress: input.tokenAddress.toLowerCase(),
    tokenSymbol: meta.symbol,
    tokenDecimals: meta.decimals,
    amountRaw: input.amount.toString(),
    amountNorm: normalizAmount(input.amount, meta.decimals),
    txHash: input.txHash,
    logIndex: input.logIndex,
    blockNumber: input.blockNumber,
    blockTimestamp: new Date(input.blockTimestampMs),
  })
}
