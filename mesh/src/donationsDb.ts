/**
 * Postgres connection pool for the `thatsrekt_donations` database.
 *
 * Mirrors the pattern in db.ts (metaPool for thatsrekt_meta).
 * The donations DB is managed by the donations-indexer processor; mesh
 * only needs read access via DONATIONS_DB_URL. We do not touch the schema
 * here — we only SELECT. The `donation` table is created by the processor's
 * ensureDonationTable() on first start.
 */
import pkg from 'pg'
const { Pool } = pkg
import type { Pool as PoolType } from 'pg'

const DONATIONS_DB_URL =
  process.env.DONATIONS_DB_URL ?? 'postgres://postgres:postgres@db:5432/thatsrekt_donations'

export const donationsPool: PoolType = new Pool({
  connectionString: DONATIONS_DB_URL,
  // Low traffic read path; conservative pool size.
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

donationsPool.on('error', (err) => {
  console.error('[donations-db] idle client error:', err)
})
