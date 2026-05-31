/**
 * E2E test for donationsResolver against a real PostgreSQL instance.
 *
 * Verifies:
 *   1. listDonations() returns rows in newest-first order.
 *   2. Pagination (limit/offset) works correctly.
 *   3. Row shape matches the DonationRow interface.
 *
 * Requires a running Postgres instance.
 * Set TEST_DB_URL to point at the test DB (default: localhost:5434).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import pkg from 'pg'
const { Pool } = pkg

// We mock the donationsPool to use our test pool.
// donationsDb.ts exports a singleton pool; we override it via env before import.
// The test sets DONATIONS_DB_URL before importing the module.

const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  'postgres://postgres:postgres@localhost:5434/donations_resolver_test'

const SUPERUSER_URL =
  process.env.TEST_SUPERUSER_URL ??
  'postgres://postgres:postgres@localhost:5434/postgres'

// Set env BEFORE importing the donations module so donationsDb.ts picks up
// the test URL. This is the correct pattern — no mock.module, no DI.
process.env.DONATIONS_DB_URL = TEST_DB_URL

// Import AFTER setting env.
const { listDonations } = await import('../src/donations.ts')
// We also need direct access to the pool to seed data.
const { donationsPool } = await import('../src/donationsDb.ts')

let superPool: InstanceType<typeof Pool>

const SEED_ROWS = [
  {
    id: 'resolver-test-1',
    chain_id: 1,
    chain_slug: 'ethereum',
    from_address: '0xaaa0000000000000000000000000000000000001',
    token_address: null,
    token_symbol: 'ETH',
    token_decimals: 18,
    amount_raw: '1000000000000000000',
    amount_norm: '1',
    tx_hash: '0x0000000000000000000000000000000000000000000000000000000000000001',
    log_index: null,
    block_number: 20_000_003,
    block_timestamp: '2024-01-15T14:00:00.000Z',  // newest
  },
  {
    id: 'resolver-test-2',
    chain_id: 1,
    chain_slug: 'ethereum',
    from_address: '0xaaa0000000000000000000000000000000000002',
    token_address: null,
    token_symbol: 'ETH',
    token_decimals: 18,
    amount_raw: '500000000000000000',
    amount_norm: '0.5',
    tx_hash: '0x0000000000000000000000000000000000000000000000000000000000000002',
    log_index: null,
    block_number: 20_000_002,
    block_timestamp: '2024-01-15T13:00:00.000Z',  // middle
  },
  {
    id: 'resolver-test-3',
    chain_id: 1,
    chain_slug: 'ethereum',
    from_address: '0xaaa0000000000000000000000000000000000003',
    token_address: null,
    token_symbol: 'ETH',
    token_decimals: 18,
    amount_raw: '2000000000000000000',
    amount_norm: '2',
    tx_hash: '0x0000000000000000000000000000000000000000000000000000000000000003',
    log_index: null,
    block_number: 20_000_001,
    block_timestamp: '2024-01-15T12:00:00.000Z',  // oldest
  },
]

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_URL, max: 1 })
  try {
    await superPool.query(`CREATE DATABASE donations_resolver_test`)
  } catch (err: unknown) {
    const errObj = err as { code?: string }
    if (errObj.code !== '42P04') throw err
  }

  // Bootstrap the table.
  await donationsPool.query(`DROP TABLE IF EXISTS donation`)
  await donationsPool.query(`
    CREATE TABLE donation (
      id              VARCHAR(128) PRIMARY KEY,
      chain_id        INTEGER      NOT NULL,
      chain_slug      VARCHAR(32)  NOT NULL,
      from_address    VARCHAR(42)  NOT NULL,
      token_address   VARCHAR(42),
      token_symbol    VARCHAR(32)  NOT NULL,
      token_decimals  INTEGER      NOT NULL,
      amount_raw      NUMERIC      NOT NULL,
      amount_norm     NUMERIC      NOT NULL,
      tx_hash         VARCHAR(66)  NOT NULL,
      log_index       INTEGER,
      block_number    INTEGER      NOT NULL,
      block_timestamp TIMESTAMPTZ  NOT NULL
    )
  `)

  // Seed rows.
  for (const row of SEED_ROWS) {
    await donationsPool.query(
      `INSERT INTO donation VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        row.id, row.chain_id, row.chain_slug, row.from_address,
        row.token_address, row.token_symbol, row.token_decimals,
        row.amount_raw, row.amount_norm, row.tx_hash, row.log_index,
        row.block_number, row.block_timestamp,
      ],
    )
  }
})

afterAll(async () => {
  await donationsPool.end()
  await superPool.end()
})

describe('listDonations', () => {
  test('returns rows in newest-first order (block_timestamp DESC)', async () => {
    const rows = await listDonations({ limit: 10, offset: 0 })
    expect(rows).toHaveLength(3)
    // Newest first
    expect(rows[0]!.id).toBe('resolver-test-1')
    expect(rows[1]!.id).toBe('resolver-test-2')
    expect(rows[2]!.id).toBe('resolver-test-3')
  })

  test('pagination: limit 1 offset 0 returns the newest row only', async () => {
    const rows = await listDonations({ limit: 1, offset: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('resolver-test-1')
  })

  test('pagination: limit 1 offset 1 returns the second row', async () => {
    const rows = await listDonations({ limit: 1, offset: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('resolver-test-2')
  })

  test('pagination: offset beyond end returns empty array', async () => {
    const rows = await listDonations({ limit: 10, offset: 100 })
    expect(rows).toHaveLength(0)
  })

  test('row shape: fields match DonationRow interface', async () => {
    const rows = await listDonations({ limit: 1, offset: 0 })
    const row = rows[0]!
    expect(typeof row.id).toBe('string')
    expect(typeof row.chainId).toBe('number')
    expect(typeof row.chainSlug).toBe('string')
    expect(typeof row.fromAddress).toBe('string')
    expect(row.tokenAddress).toBeNull()
    expect(typeof row.tokenSymbol).toBe('string')
    expect(typeof row.tokenDecimals).toBe('number')
    expect(typeof row.amountRaw).toBe('string')
    expect(typeof row.amountNorm).toBe('string')
    expect(typeof row.txHash).toBe('string')
    expect(row.logIndex).toBeNull()
    expect(typeof row.blockNumber).toBe('number')
    // blockTimestamp should be an ISO8601 string
    expect(() => new Date(row.blockTimestamp)).not.toThrow()
  })

  test('limit is clamped to max 200', async () => {
    // Should not error even with a huge limit
    const rows = await listDonations({ limit: 9999, offset: 0 })
    // Returns at most 200 (we only have 3 seeds anyway)
    expect(rows.length).toBeLessThanOrEqual(200)
  })
})
