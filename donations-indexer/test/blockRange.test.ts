import { describe, expect, test } from 'bun:test'
import { resolveToBlock } from '../src/blockRange'

describe('resolveToBlock', () => {
  test('uses only the finalized RPC head as the Portal range bound', () => {
    expect(
      resolveToBlock({
        startBlock: 45_301_000,
        head: 50_527_500,
        finalityConfirmation: 50,
      }),
    ).toBe(50_527_450)
  })

  test('reports no range until the configured start block is finalized', () => {
    expect(
      resolveToBlock({
        startBlock: 500_000,
        head: 500_050,
        finalityConfirmation: 100,
      }),
    ).toBeUndefined()
  })

  test('is deterministic for an unchanged head', () => {
    const args = {
      startBlock: 1,
      head: 1_000_000,
      finalityConfirmation: 75,
    }
    expect(resolveToBlock(args)).toBe(resolveToBlock(args))
  })

  test('rejects a negative finality confirmation', () => {
    expect(() =>
      resolveToBlock({
        startBlock: 0,
        head: 1_000,
        finalityConfirmation: -1,
      }),
    ).toThrow()
  })
})
