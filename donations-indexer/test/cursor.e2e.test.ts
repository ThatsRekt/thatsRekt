import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FinalDatabase } from '@subsquid/batch-processor'
import type { PoolClient } from 'pg'
import {
  CursorConsistencyError,
  classifyZeroRowCursorUpdate,
  createDonationDatabase,
} from '../src/cursor.ts'
import { ensureDonationTable, upsertDonation } from '../src/donationStore.ts'
import type { DonationRow } from '../src/donationMapper.ts'
import {
  createIsolatedPortalTestPool,
  type IsolatedPortalTestPool,
} from './support/isolatedPostgres.ts'

let fixture: IsolatedPortalTestPool
let pool: IsolatedPortalTestPool['pool']
let nextTestChainId = 1_900_000_000

interface CursorTestDatabase {
  readonly chainId: number
  readonly database: FinalDatabase<PoolClient>
}

const allocateTestChainId = (): number => nextTestChainId++

const createCursorTestDatabase = async (): Promise<CursorTestDatabase> => {
  const chainId = allocateTestChainId()
  const database = createDonationDatabase({ pool, chainId })
  await database.connect()
  return Object.freeze({ chainId, database })
}

const rowAt = ({
  chainId,
  blockNumber,
}: {
  readonly chainId: number
  readonly blockNumber: number
}): DonationRow => ({
  id: `${chainId}-0x${blockNumber.toString(16).padStart(64, '0')}-native`,
  chainId,
  chainSlug: 'base',
  fromAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  tokenAddress: null,
  tokenSymbol: 'ETH',
  tokenDecimals: 18,
  amountRaw: '1000000000000000000',
  amountNorm: '1',
  txHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
  logIndex: null,
  blockNumber,
  blockTimestamp: new Date('2025-01-01T00:00:00.000Z'),
})

const infoAt = (height: number, hash: string) => ({
  prevHead: { height: height - 1, hash: `0xprev${height}` },
  nextHead: { height, hash },
  isOnTop: true,
})

const cursor = async (chainId: number): Promise<{ height: number; hash: string }> => {
  const { rows } = await pool.query<{ height: number; hash: string }>(
    `SELECT height, hash FROM donations_indexer_status_v2 WHERE chain_id = $1`,
    [chainId],
  )
  return rows[0]!
}

const donationCount = async (chainId: number): Promise<string> => {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM donation WHERE chain_id = $1`,
    [chainId],
  )
  return rows[0]!.count
}

beforeAll(async () => {
  fixture = await createIsolatedPortalTestPool()
  pool = fixture.pool
  await ensureDonationTable(pool)
})

afterAll(async () => {
  await fixture.close()
})

describe('conditional donation cursor commits', () => {
  test('commits mapped rows and the cursor atomically', async () => {
    const { chainId, database } = await createCursorTestDatabase()

    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt({ chainId, blockNumber: 100 }))
    })

    expect(await cursor(chainId)).toEqual({ height: 100, hash: '0x100' })
    expect(await donationCount(chainId)).toBe('1')
  })


  test('keeps the higher cursor during delayed replays while donations remain idempotent', async () => {
    const { chainId, database } = await createCursorTestDatabase()
    await database.transact(infoAt(200, '0x200'), async (client) => {
      await upsertDonation(client, rowAt({ chainId, blockNumber: 200 }))
    })

    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt({ chainId, blockNumber: 100 }))
    })
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt({ chainId, blockNumber: 100 }))
    })

    expect(await cursor(chainId)).toEqual({ height: 200, hash: '0x200' })
    expect(await donationCount(chainId)).toBe('2')
  })

  test('treats an equal height and hash as an idempotent database commit', async () => {
    const { chainId, database } = await createCursorTestDatabase()
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt({ chainId, blockNumber: 100 }))
    })
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt({ chainId, blockNumber: 100 }))
    })

    expect(await cursor(chainId)).toEqual({ height: 100, hash: '0x100' })
    expect(await donationCount(chainId)).toBe('1')
  })

  test('rolls back a missing conditional cursor row without persisting donations', async () => {
    const chainId = allocateTestChainId()
    const database = createDonationDatabase({ pool, chainId })

    await expect(
      database.transact(infoAt(100, '0x100'), async (client) => {
        await upsertDonation(client, rowAt({ chainId, blockNumber: 100 }))
      }),
    ).rejects.toThrow('Donation cursor row is missing')

    const { rows } = await pool.query(
      `SELECT height, hash FROM donations_indexer_status_v2 WHERE chain_id = $1`,
      [chainId],
    )
    expect(rows).toEqual([])
    expect(await donationCount(chainId)).toBe('0')
  })

  test('rolls back a divergent equal-height hash without overwriting state', async () => {
    const { chainId, database } = await createCursorTestDatabase()
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt({ chainId, blockNumber: 100 }))
    })

    await expect(
      database.transact(infoAt(100, '0xdifferent'), async (client) => {
        await upsertDonation(client, rowAt({ chainId, blockNumber: 101 }))
      }),
    ).rejects.toThrow('Donation cursor hash conflicts at the same height')

    expect(await cursor(chainId)).toEqual({ height: 100, hash: '0x100' })
    expect(await donationCount(chainId)).toBe('1')
  })
})

describe('zero-row conditional update classification', () => {
  test('treats higher stored state as a benign stale replay', () => {
    expect(
      classifyZeroRowCursorUpdate({
        stored: { height: 200, hash: '0x200' },
        next: { height: 100, hash: '0x100' },
      }),
    ).toBe('stale')
  })

  test('treats same height and hash as idempotent', () => {
    expect(
      classifyZeroRowCursorUpdate({
        stored: { height: 100, hash: '0x100' },
        next: { height: 100, hash: '0x100' },
      }),
    ).toBe('idempotent')
  })

  test.each([
    [undefined, { height: 100, hash: '0x100' }],
    [{ height: 100, hash: '0xother' }, { height: 100, hash: '0x100' }],
    [{ height: 99, hash: '0x99' }, { height: 100, hash: '0x100' }],
  ])('fails closed for inconsistent cursor state', (stored, next) => {
    expect(() => classifyZeroRowCursorUpdate({ stored, next })).toThrow(
      CursorConsistencyError,
    )
  })
})
