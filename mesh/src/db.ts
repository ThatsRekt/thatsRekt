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
 * - `comments_dedupe_idx` — UNIQUE(signer_address, post_id, signed_at)
 *   backstops the dedupe race in `createComment`. Two concurrent
 *   submits with the same signature produce the same triple, so the
 *   second insert hits a 23505 unique_violation and the resolver
 *   translates it to `DuplicateSubmission`. Combined with the ±5min
 *   `signed_at` window, this is the entire replay-protection story —
 *   no read-then-insert window is needed (audit M-2).
 *
 * No `UNIQUE` on signature: edits re-sign the same comment, so the same
 * signature could in principle reappear (and equality comparisons on
 * 132-char hex strings are cheap regardless).
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
  await metaPool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS comments_dedupe_idx
       ON comments(signer_address, post_id, signed_at);`,
  )
}

/**
 * Idempotent schema bootstrap for guardian applications. Safe to run on
 * every Mesh start.
 *
 * Columns:
 * - `id` — surrogate primary key (BIGSERIAL).
 * - `created_at` — insertion timestamp; immutable.
 * - `primary_contact_type` — one of: telegram, email, signal, twitter.
 * - `primary_contact_value` — the validated contact handle / address.
 * - `extra_contacts` — JSONB array of additional {type, value} objects,
 *   or NULL when none provided. Stored as JSONB for flexibility; max 2
 *   entries enforced at the application layer.
 * - `justification` — free-text motivation, 50–1500 chars.
 * - `forwarded_at` — nullable timestamp set when the downstream bot picks
 *   up this row and posts it to the operator channel.
 * - `forwarded_message_id` — nullable Telegram message id of the bot
 *   notification, for threading replies.
 * - `source_ip_hash` — SHA-256 of source IP truncated to 16 hex chars.
 *   Stored for abuse forensics only; not reversible to the original IP.
 */
export async function ensureGuardianApplicationsTable(): Promise<void> {
  await metaPool.query(`
    CREATE TABLE IF NOT EXISTS guardian_applications (
      id                    BIGSERIAL PRIMARY KEY,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      primary_contact_type  VARCHAR(16) NOT NULL
                              CHECK (primary_contact_type IN ('telegram', 'email', 'signal', 'twitter')),
      primary_contact_value VARCHAR(128) NOT NULL CHECK (length(primary_contact_value) >= 1),
      extra_contacts        JSONB,
      justification         TEXT NOT NULL CHECK (length(justification) BETWEEN 50 AND 1500),
      forwarded_at          TIMESTAMPTZ,
      forwarded_message_id  TEXT,
      source_ip_hash        VARCHAR(16)
    );
  `)
  await metaPool.query(
    `CREATE INDEX IF NOT EXISTS guardian_applications_created_idx
       ON guardian_applications(created_at DESC);`,
  )
}
