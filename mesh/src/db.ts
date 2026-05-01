/**
 * Postgres connection pool for the off-chain `thatsrekt_meta` database.
 *
 * Mesh owns the lifecycle of the `comments` table — there's no separate
 * migration tooling. On boot, `ensureCommentsTable()` runs idempotent
 * `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` statements
 * so a fresh deploy boots cleanly without manual intervention.
 *
 * The database itself (`thatsrekt_meta`) is created by the deploy.sh
 * bootstrap step that replays `CREATE DATABASE` lines from
 * `damm-cloud/thatsrekt/public/init.sql` against the live cluster. Mesh
 * just needs to be able to connect with `META_DB_URL`.
 */
import pkg from 'pg'
const { Pool } = pkg
import type { Pool as PoolType } from 'pg'

// Internal compose URL by default; matches the postgres `db` service in
// `damm-cloud/thatsrekt/public/docker-compose.yml`. The local-stack
// override should set META_DB_URL to whatever the dev compose exposes.
const META_DB_URL =
  process.env.META_DB_URL ?? 'postgres://postgres:postgres@db:5432/thatsrekt_meta'

export const metaPool: PoolType = new Pool({
  connectionString: META_DB_URL,
  // Conservative: comments are a low-traffic write path. 10 is plenty for
  // bursts and well below RDS's per-instance connection ceiling.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

// Surface pool errors instead of letting them go unhandled. A connection
// drop here is recoverable — pg will reconnect on the next checkout.
metaPool.on('error', (err) => {
  console.error('[meta-db] idle client error:', err)
})

/**
 * Idempotent schema bootstrap. Safe to run on every Mesh start.
 *
 * - `comments` — single off-chain table holding all guardian comments.
 * - `comments_post_idx` — speeds up `WHERE post_id = $1 ORDER BY created_at DESC`.
 * - `comments_signer_idx` — speeds up rate-limit lookups + per-author
 *   audit queries.
 *
 * No `UNIQUE` on signature: edits re-sign the same comment, so the same
 * signature could in principle reappear (and equality comparisons on
 * 132-char hex strings are cheap regardless). Replay protection is
 * provided by the time-window check + the dedupe predicate at insert.
 */
export async function ensureCommentsTable(): Promise<void> {
  await metaPool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id BIGSERIAL PRIMARY KEY,
      post_id VARCHAR(64) NOT NULL,
      chain_slug VARCHAR(32) NOT NULL,
      signer_address VARCHAR(42) NOT NULL,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
      signature VARCHAR(132) NOT NULL,
      signed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_edited_at TIMESTAMPTZ,
      message_hash VARCHAR(66) NOT NULL
    );
  `)
  await metaPool.query(
    `CREATE INDEX IF NOT EXISTS comments_post_idx ON comments(post_id, created_at DESC);`,
  )
  await metaPool.query(
    `CREATE INDEX IF NOT EXISTS comments_signer_idx ON comments(signer_address);`,
  )
}
