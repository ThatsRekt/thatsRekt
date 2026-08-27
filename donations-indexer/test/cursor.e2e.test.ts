import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pkg from 'pg'
import {
  CursorConsistencyError,
  classifyZeroRowCursorUpdate,
  createDonationDatabase,
  ensureDonationCursorTable,
} from '../src/cursor.ts'
import { ensureDonationTable, upsertDonation } from '../src/donationStore.ts'
import type { DonationRow } from '../src/donationMapper.ts'
import { DonationsPortalRetryDeadlineError } from '../src/portal.ts'

const { Pool } = pkg
const CHAIN_ID = 8453
const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  'postgres://postgres:postgres@localhost:5433/donations_test'
const SUPERUSER_URL =
  process.env.TEST_SUPERUSER_URL ??
  'postgres://postgres:postgres@localhost:5433/postgres'

let pool: InstanceType<typeof Pool>

const rowAt = (blockNumber: number): DonationRow => ({
  id: `${CHAIN_ID}-0x${blockNumber.toString(16).padStart(64, '0')}-native`,
  chainId: CHAIN_ID,
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

const cursor = async (): Promise<{ height: number; hash: string }> => {
  const { rows } = await pool.query<{ height: number; hash: string }>(
    `SELECT height, hash FROM donations_indexer_status_v2 WHERE chain_id = $1`,
    [CHAIN_ID],
  )
  return rows[0]!
}

beforeAll(async () => {
  const superPool = new Pool({ connectionString: SUPERUSER_URL, max: 1 })
  try {
    await superPool.query(`CREATE DATABASE donations_test`)
  } catch (error: unknown) {
    const candidate = error as { code?: string }
    if (candidate.code !== '42P04') throw error
  } finally {
    await superPool.end()
  }

  pool = new Pool({ connectionString: TEST_DB_URL, max: 2 })
  await ensureDonationTable(pool)
  await ensureDonationCursorTable(pool, CHAIN_ID)
})

beforeEach(async () => {
  await pool.query(`DELETE FROM donation`)
  await pool.query(`DELETE FROM donations_indexer_status_v2 WHERE chain_id = $1`, [CHAIN_ID])
})

afterAll(async () => {
  await pool.end()
})

describe('conditional donation cursor commits', () => {
  test('commits mapped rows and the cursor atomically', async () => {
    const database = createDonationDatabase({ pool, chainId: CHAIN_ID })
    await database.connect()

    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt(100))
    })

    expect(await cursor()).toEqual({ height: 100, hash: '0x100' })
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM donation`,
    )
    expect(rows[0]!.count).toBe('1')
  })

  test('rolls back mapped writes and leaves the cursor unchanged on mapping failure', async () => {
    const database = createDonationDatabase({ pool, chainId: CHAIN_ID })
    await database.connect()

    await expect(
      database.transact(infoAt(100, '0x100'), async (client) => {
        await upsertDonation(client, rowAt(100))
        throw new Error('controlled mapping interruption')
      }),
    ).rejects.toThrow('controlled mapping interruption')

    expect(await cursor()).toEqual({ height: -1, hash: '' })
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM donation`,
    )
    expect(rows[0]!.count).toBe('0')
  })

  test('keeps a controlled Portal retry interruption visible and resumable', async () => {
    const database = createDonationDatabase({ pool, chainId: CHAIN_ID })
    await database.connect()

    await expect(
      database.transact(infoAt(100, '0x100'), async (client) => {
        await upsertDonation(client, rowAt(100))
        throw new DonationsPortalRetryDeadlineError()
      }),
    ).rejects.toThrow('Portal retry deadline exceeded after 20 minutes')

    expect(await cursor()).toEqual({ height: -1, hash: '' })
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt(100))
    })
    expect(await cursor()).toEqual({ height: 100, hash: '0x100' })
  })

  test('keeps the higher cursor during delayed replays while donations remain idempotent', async () => {
    const database = createDonationDatabase({ pool, chainId: CHAIN_ID })
    await database.connect()
    await database.transact(infoAt(200, '0x200'), async (client) => {
      await upsertDonation(client, rowAt(200))
    })

    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt(100))
    })
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt(100))
    })

    expect(await cursor()).toEqual({ height: 200, hash: '0x200' })
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM donation`,
    )
    expect(rows[0]!.count).toBe('2')
  })

  test('treats an equal height and hash as an idempotent database commit', async () => {
    const database = createDonationDatabase({ pool, chainId: CHAIN_ID })
    await database.connect()
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt(100))
    })
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt(100))
    })

    expect(await cursor()).toEqual({ height: 100, hash: '0x100' })
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM donation`,
    )
    expect(rows[0]!.count).toBe('1')
  })

  test('rolls back a missing conditional cursor row without persisting donations', async () => {
    const database = createDonationDatabase({ pool, chainId: CHAIN_ID })
    await database.connect()

    await expect(
      database.transact(infoAt(100, '0x100'), async (client) => {
        await upsertDonation(client, rowAt(100))
        await client.query(
          `DELETE FROM donations_indexer_status_v2 WHERE chain_id = $1`,
          [CHAIN_ID],
        )
      }),
    ).rejects.toThrow('Donation cursor row is missing')

    expect(await cursor()).toEqual({ height: -1, hash: '' })
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM donation`,
    )
    expect(rows[0]!.count).toBe('0')
  })

  test('rolls back a divergent equal-height hash without overwriting state', async () => {
    const database = createDonationDatabase({ pool, chainId: CHAIN_ID })
    await database.connect()
    await database.transact(infoAt(100, '0x100'), async (client) => {
      await upsertDonation(client, rowAt(100))
    })

    await expect(
      database.transact(infoAt(100, '0xdifferent'), async (client) => {
        await upsertDonation(client, rowAt(101))
      }),
    ).rejects.toThrow('Donation cursor hash conflicts at the same height')

    expect(await cursor()).toEqual({ height: 100, hash: '0x100' })
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM donation`,
    )
    expect(rows[0]!.count).toBe('1')
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
