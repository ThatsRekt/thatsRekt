/**
 * Donation mapper — pure transform from a raw native value-transfer into
 * a normalized DonationRow, or null when the transfer should be dropped.
 *
 * Walking skeleton (slice #205): native-coin branch only.
 * Slice #207 will add the ERC20 log branch.
 *
 * Drop conditions:
 *   - Chain not in the allowlist.
 *   - Transfer value is below the per-chain native dust floor.
 *
 * The id is deterministic: `${chainId}-${txHash}-native`.
 * This key is stable and safe to re-index (idempotent upsert downstream).
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
