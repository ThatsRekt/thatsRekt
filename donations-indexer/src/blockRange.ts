/**
 * Bounded block-range resolution for the donations indexer.
 *
 * The indexer is a scheduled batch job, not a follower: it processes a bounded
 * range of finalized blocks and exits. The upper bound decides which data
 * source Subsquid can use for the run.
 *
 * Targeting `head - finalityConfirmation` puts the bound ~100 blocks behind
 * chain head, but the Subsquid archive trails head by far more (~21,000 blocks
 * on arbitrum, measured 2026-07-20). Once saved state passes the archive
 * height, `archiveHeight > state.height` is permanently false and every run
 * falls through to RPC ingestion at ~9 blocks/sec — the failure mode observed
 * in production, where runs took ~22 minutes against a 30-minute schedule.
 *
 * Clamping to the archive height keeps each run inside the range the archive
 * can serve, at thousands of blocks/sec and no RPC cost. The tradeoff is that
 * donations trail chain head by the archive lag.
 */

export interface ResolveToBlockArgs {
  /** First block the indexer is ever allowed to process (contract deploy). */
  readonly startBlock: number
  /** Current chain head, from eth_blockNumber. */
  readonly head: number
  /** Blocks behind head treated as finalized. */
  readonly finalityConfirmation: number
  /**
   * Current Subsquid archive height, or `null` when no gateway is configured
   * (RPC-only mode — local Anvil and tests).
   */
  readonly archiveHeight: number | null
}

/**
 * Upper bound (inclusive) for this run's block range.
 *
 * Pure: same inputs always yield the same bound, no I/O.
 */
export const resolveToBlock = ({
  startBlock,
  head,
  finalityConfirmation,
  archiveHeight,
}: ResolveToBlockArgs): number => {
  if (!Number.isFinite(head)) {
    throw new Error(`resolveToBlock: head must be finite, got ${head}`)
  }
  if (!Number.isFinite(startBlock) || startBlock < 0) {
    throw new Error(
      `resolveToBlock: startBlock must be a non-negative finite number, got ${startBlock}`,
    )
  }
  if (!Number.isFinite(finalityConfirmation) || finalityConfirmation < 0) {
    throw new Error(
      `resolveToBlock: finalityConfirmation must be non-negative, got ${finalityConfirmation}`,
    )
  }
  if (archiveHeight !== null && !Number.isFinite(archiveHeight)) {
    throw new Error(
      `resolveToBlock: archiveHeight must be finite or null, got ${archiveHeight}`,
    )
  }

  const finalizedTarget = head - finalityConfirmation
  const bound =
    archiveHeight === null
      ? finalizedTarget
      : Math.min(finalizedTarget, archiveHeight)

  // Never regress below the deploy block — an archive that has not yet reached
  // the contract yields an empty range, which the processor handles as no-op.
  return Math.max(startBlock, bound)
}

/**
 * Read the current height of a Subsquid Network archive gateway.
 *
 * Throws on any failure rather than falling back to the finalized head:
 * a silent fallback would restore the RPC-only grind this module exists to
 * prevent, and a missed 30-minute run is cheap for a donations ledger.
 */
export const fetchArchiveHeight = async (gatewayUrl: string): Promise<number> => {
  const url = `${gatewayUrl.replace(/\/$/, '')}/height`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `archive height HTTP ${response.status} ${response.statusText} (${url})`,
    )
  }
  const text = (await response.text()).trim()
  const height = Number.parseInt(text, 10)
  if (!Number.isInteger(height) || height < 0) {
    throw new Error(`archive height: unexpected body ${JSON.stringify(text)} (${url})`)
  }
  return height
}
