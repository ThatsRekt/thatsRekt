/**
 * E2E test for donationStore against a real PostgreSQL instance.
 *
 * Requires a running postgres:16-alpine container (or local Postgres) at
 * TEST_DB_URL (defaults to postgres://postgres:postgres@localhost:5432/donations_test).
 *
 * Run with: bun test test/donationStore.e2e.test.ts
 *
 * The test database is created by the test harness via a superuser connection.
 * Start the test DB before running:
 *   docker run --rm -d -p 5432:5432 \
 *     -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 *
 * Key assertions:
 *   1. ensureDonationTable() creates the table (idempotent).
 *   2. upsertDonation() inserts a row.
 *   3. Re-running upsertDonation() with the same id produces no duplicate.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import pkg from 'pg'
const { Pool } = pkg

import { ensureDonationTable, upsertDonation } from '../src/donationStore.ts'
import type { DonationRow } from '../src/donationMapper.ts'

const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  'postgres://postgres:postgres@localhost:5432/donations_test'

const SUPERUSER_URL =
  process.env.TEST_SUPERUSER_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres'

let pool: InstanceType<typeof Pool>

const SAMPLE_ROW: DonationRow = Object.freeze({
  id: '1-0xabc123-native',
  chainId: 1,
  chainSlug: 'ethereum',
  fromAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  tokenAddress: null,
  tokenSymbol: 'ETH',
  tokenDecimals: 18,
  amountRaw: '1000000000000000000',
  amountNorm: '1',
  txHash: '0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1',
  logIndex: null,
  blockNumber: 20_000_000,
  blockTimestamp: new Date('2024-01-15T12:00:00.000Z'),
})

beforeAll(async () => {
  // Create the test database if it doesn't exist.
  const superPool = new Pool({ connectionString: SUPERUSER_URL, max: 1 })
  try {
    await superPool.query(`CREATE DATABASE donations_test`)
  } catch (err: unknown) {
    const errObj = err as { code?: string }
    // 42P04 = duplicate_database — already exists, fine.
    if (errObj.code !== '42P04') throw err
  } finally {
    await superPool.end()
  }

  pool = new Pool({ connectionString: TEST_DB_URL, max: 5 })
  // Drop and recreate the donation table so each test run starts fresh.
  await pool.query(`DROP TABLE IF EXISTS donation`)
  await pool.query(`DROP TABLE IF EXISTS donations_indexer_status`)
  await ensureDonationTable(pool)
})

afterAll(async () => {
  await pool.end()
})

describe('ensureDonationTable', () => {
  test('table exists after ensureDonationTable()', async () => {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_name = 'donation'
       ) AS exists`,
    )
    expect(rows[0]!.exists).toBe(true)
  })

  test('ensureDonationTable() is idempotent — second call does not error', async () => {
    await expect(ensureDonationTable(pool)).resolves.toBeUndefined()
  })
})

describe('upsertDonation', () => {
  test('inserts a row successfully', async () => {
    await upsertDonation(pool, SAMPLE_ROW)
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM donation WHERE id = $1`,
      [SAMPLE_ROW.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(SAMPLE_ROW.id)
  })

  test('idempotent — second upsert with same id produces no duplicate', async () => {
    await upsertDonation(pool, SAMPLE_ROW)
    await upsertDonation(pool, SAMPLE_ROW)
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM donation WHERE id = $1`,
      [SAMPLE_ROW.id],
    )
    expect(rows[0]!.count).toBe('1')
  })

  test('persists all fields correctly', async () => {
    const { rows } = await pool.query(
      `SELECT * FROM donation WHERE id = $1`,
      [SAMPLE_ROW.id],
    )
    const r = rows[0]!
    expect(r.chain_id).toBe(SAMPLE_ROW.chainId)
    expect(r.chain_slug).toBe(SAMPLE_ROW.chainSlug)
    expect(r.from_address).toBe(SAMPLE_ROW.fromAddress)
    expect(r.token_address).toBeNull()
    expect(r.token_symbol).toBe(SAMPLE_ROW.tokenSymbol)
    expect(r.token_decimals).toBe(SAMPLE_ROW.tokenDecimals)
    expect(r.tx_hash).toBe(SAMPLE_ROW.txHash)
    expect(r.log_index).toBeNull()
    expect(r.block_number).toBe(SAMPLE_ROW.blockNumber)
  })

  test('two different donations both persist', async () => {
    const row2: DonationRow = {
      ...SAMPLE_ROW,
      id: '1-0xdef456-native',
      txHash: '0xdef456def456def456def456def456def456def456def456def456def456def4',
      amountRaw: '500000000000000000',
      amountNorm: '0.5',
    }
    await upsertDonation(pool, row2)
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM donation`,
    )
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(2)
  })
})
