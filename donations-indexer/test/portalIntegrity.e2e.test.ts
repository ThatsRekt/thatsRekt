import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pkg from 'pg'
import {
  createDonationDatabase,
  ensureDonationCursorTable,
} from '../src/cursor.ts'
import { ensureDonationTable } from '../src/donationStore.ts'
import { indexDonationBlocks, type DonationBlock } from '../src/processor.ts'
import { TRANSFER_TOPIC0 } from '../src/tokenAllowlist.ts'

const { Pool } = pkg
const CHAIN_ID = 8453
const CHAIN_SLUG = 'base'
const DONEE = '0x59e4dbc95bd312a882bb36b7f3e8298682340679'
const TEST_DB_URL =
  process.env.PORTAL_INTEGRITY_TEST_DB_URL ??
  'postgres://postgres:postgres@localhost:5433/donations_portal_integrity_test'
const SUPERUSER_URL =
  process.env.TEST_SUPERUSER_URL ??
  'postgres://postgres:postgres@localhost:5433/postgres'

export const FROZEN_PORTAL_HEIGHT_BASELINES = Object.freeze({
  ethereum: 19_000_000,
  base: 50_517_211,
  arbitrum: 457_275_000,
  optimism: 150_896_000,
  bsc: 95_195_000,
  polygon: 86_136_000,
})

const topicFor = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`
const donor = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CAPTURED_BASE_PORTAL_BLOCKS: readonly DonationBlock[] = Object.freeze([
  Object.freeze({
    header: Object.freeze({ height: 50_517_211, timestamp: 1_735_689_600_000 }),
    transactions: Object.freeze([
      Object.freeze({
        to: DONEE,
        from: donor,
        hash: `0x${'a'.repeat(64)}`,
        value: 1_000_000_000_000_000_000n,
      }),
    ]),
    logs: Object.freeze([
      Object.freeze({
        address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        topics: Object.freeze([TRANSFER_TOPIC0, topicFor(donor), topicFor(DONEE)]),
        data: '0x2faf080',
        transactionHash: `0x${'b'.repeat(64)}`,
        logIndex: 3,
      }),
    ]),
  }),
])

let pool: InstanceType<typeof Pool>

beforeAll(async () => {
  const superPool = new Pool({ connectionString: SUPERUSER_URL, max: 1 })
  try {
    await superPool.query(`CREATE DATABASE donations_portal_integrity_test`)
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

describe('captured Portal integrity harness', () => {
  test('freezes one baseline height for every Production Chain', () => {
    expect(FROZEN_PORTAL_HEIGHT_BASELINES).toEqual({
      ethereum: 19_000_000,
      base: 50_517_211,
      arbitrum: 457_275_000,
      optimism: 150_896_000,
      bsc: 95_195_000,
      polygon: 86_136_000,
    })
  })

  test('maps captured Base native and ERC20 donations exactly once across restart', async () => {
    const database = createDonationDatabase({ pool, chainId: CHAIN_ID })
    await database.connect()
    await database.transact(
      {
        prevHead: { height: 50_517_210, hash: '0xbase-prev' },
        nextHead: { height: 50_517_211, hash: '0xbase-moonwell' },
        isOnTop: true,
      },
      async (store) =>
        indexDonationBlocks({
          blocks: CAPTURED_BASE_PORTAL_BLOCKS,
          store,
          chainId: CHAIN_ID,
          chainSlug: CHAIN_SLUG,
          donee: DONEE,
        }),
    )
    await database.transact(
      {
        prevHead: { height: 50_517_211, hash: '0xbase-moonwell' },
        nextHead: { height: 50_527_337, hash: '0xbase-restart' },
        isOnTop: true,
      },
      async (store) =>
        indexDonationBlocks({
          blocks: CAPTURED_BASE_PORTAL_BLOCKS,
          store,
          chainId: CHAIN_ID,
          chainSlug: CHAIN_SLUG,
          donee: DONEE,
        }),
    )

    const { rows } = await pool.query<{
      token_symbol: string
      amount_norm: string
      chain_id: number
      block_number: number
    }>(`
      SELECT token_symbol, amount_norm::text AS amount_norm, chain_id, block_number
      FROM donation
      ORDER BY token_symbol
    `)
    expect(rows).toEqual([
      { token_symbol: 'ETH', amount_norm: '1', chain_id: 8453, block_number: 50_517_211 },
      { token_symbol: 'USDC', amount_norm: '50', chain_id: 8453, block_number: 50_517_211 },
    ])

    const { rows: cursorRows } = await pool.query<{ height: number; hash: string }>(
      `SELECT height, hash FROM donations_indexer_status_v2 WHERE chain_id = $1`,
      [CHAIN_ID],
    )
    expect(cursorRows).toEqual([{ height: 50_527_337, hash: '0xbase-restart' }])
  })
})
