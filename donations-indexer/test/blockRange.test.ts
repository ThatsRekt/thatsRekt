/**
 * Tests for resolveToBlock — the upper bound of the donations indexer's
 * bounded block range.
 *
 * Why this exists (incident 2026-07-20):
 *   The job targeted `head - FINALITY_CONFIRMATION`, i.e. ~100 blocks behind
 *   chain head. The Subsquid archive trails head by far more than that
 *   (~21,000 blocks on arbitrum). Once saved state passed the archive height,
 *   `archiveHeight > state.height` went false forever and every run fell
 *   through to "using chain RPC data source" at ~9 blocks/sec — grinding
 *   ~13,000 blocks over ~22 minutes against a 30-minute schedule, and
 *   accounting for a large share of a ~1.34M/day JSON-RPC bill.
 *
 *   Clamping the target to the archive height keeps every run inside the
 *   range the archive can actually serve (thousands of blocks/sec, free).
 *   The cost is that donations trail by the archive lag, which is acceptable
 *   for a donations ledger.
 */
import { describe, expect, test } from 'bun:test'
import { resolveToBlock } from '../src/blockRange'

describe('resolveToBlock', () => {
  test('clamps to archive height when the archive trails the finalized head', () => {
    // The arbitrum incident, with real numbers.
    expect(
      resolveToBlock({
        startBlock: 457_275_000,
        head: 485_916_754,
        finalityConfirmation: 100,
        archiveHeight: 485_894_481,
      }),
    ).toBe(485_894_481)
  })

  test('uses the finalized head when the archive is ahead of it', () => {
    expect(
      resolveToBlock({
        startBlock: 1_000,
        head: 25_575_413,
        finalityConfirmation: 75,
        archiveHeight: 25_600_000,
      }),
    ).toBe(25_575_338)
  })

  test('falls back to the finalized head when no archive is configured', () => {
    // Local Anvil / RPC-only mode has no gateway.
    expect(
      resolveToBlock({
        startBlock: 0,
        head: 1_000,
        finalityConfirmation: 0,
        archiveHeight: null,
      }),
    ).toBe(1_000)
  })

  test('never returns a bound below startBlock', () => {
    // Fresh deploy: archive has not yet reached the contract's deploy block.
    expect(
      resolveToBlock({
        startBlock: 500_000,
        head: 500_050,
        finalityConfirmation: 100,
        archiveHeight: 400_000,
      }),
    ).toBe(500_000)
  })

  test('is idempotent — same inputs give the same bound', () => {
    const args = {
      startBlock: 1,
      head: 1_000_000,
      finalityConfirmation: 75,
      archiveHeight: 999_000,
    }
    expect(resolveToBlock(args)).toBe(resolveToBlock(args))
  })

  test('rejects a negative finalityConfirmation rather than widening the range', () => {
    expect(() =>
      resolveToBlock({
        startBlock: 0,
        head: 1_000,
        finalityConfirmation: -1,
        archiveHeight: null,
      }),
    ).toThrow()
  })

  test('rejects a non-finite head', () => {
    expect(() =>
      resolveToBlock({
        startBlock: 0,
        head: Number.NaN,
        finalityConfirmation: 0,
        archiveHeight: null,
      }),
    ).toThrow()
  })
})
