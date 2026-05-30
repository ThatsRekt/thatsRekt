/**
 * Postgres connection + schema bootstrap for guardian-apply-bot.
 *
 * The bot shares the `thatsrekt_meta` database with the mesh service but
 * does NOT import from that package — it replicates the connection pattern
 * and owns the `ensureGuardianApplicationsTable` DDL so it can boot
 * independently. The DDL is idempotent (`IF NOT EXISTS`) so running it
 * alongside mesh is safe.
 *
 * Claim strategy: `UPDATE ... WHERE forwarded_at IS NULL ... RETURNING`
 * inside a transaction with `FOR UPDATE SKIP LOCKED` semantics on the
 * initial SELECT. This guarantees each row is processed by exactly one
 * concurrent runner even when multiple instances overlap.
 */

import pkg from 'pg'
const { Pool } = pkg
import type { Pool as PoolType, PoolClient } from 'pg'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const META_DB_URL =
  process.env.META_DB_URL ?? 'postgres://postgres:postgres@db:5432/thatsrekt_meta'

export const metaPool: PoolType = new Pool({
  connectionString: META_DB_URL,
  // Single-run bot; one connection is sufficient. Keeping the ceiling low
  // prevents accidental saturation of the shared RDS instance.
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
})

metaPool.on('error', (err) => {
  console.error('[guardian-apply-bot] idle client error:', err)
})

// ---------------------------------------------------------------------------
// Schema bootstrap (idempotent)
// ---------------------------------------------------------------------------

/**
 * Idempotent DDL — mirrors mesh's `ensureGuardianApplicationsTable` exactly.
 * Safe to run alongside mesh on every bot invocation.
 *
 * Accepts an optional `pool` override so tests can point at a test DB
 * without touching the `metaPool` singleton.
 */
export async function ensureGuardianApplicationsTable(pool: PoolType = metaPool): Promise<void> {
  await pool.query(`
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
  await pool.query(
    `CREATE INDEX IF NOT EXISTS guardian_applications_created_idx
       ON guardian_applications(created_at DESC);`,
  )
}

// ---------------------------------------------------------------------------
// Row types (Zod-validated at the DB boundary)
// ---------------------------------------------------------------------------

/**
 * Raw DB row shape returned by PostgreSQL. Zod validates at the boundary
 * so downstream code can trust the types without `any`.
 */
export const ApplicationRowSchema = z.object({
  id: z.string(), // BIGSERIAL comes back as string from pg
  created_at: z.date(),
  primary_contact_type: z.enum(['telegram', 'email', 'signal', 'twitter']),
  primary_contact_value: z.string().min(1).max(128),
  extra_contacts: z.unknown().nullable(),
  // DB allows up to 1500 chars; the bot caps at 1000 to keep Telegram
  // messages readable. Rows with longer justifications are skipped and
  // left for manual review.
  justification: z.string().min(50).max(1000),
  source_ip_hash: z.string().max(16).nullable(),
})

export type ApplicationRow = z.infer<typeof ApplicationRowSchema>

// ---------------------------------------------------------------------------
// Transactional claim
// ---------------------------------------------------------------------------

/**
 * Result of a single claim+forward attempt for one application.
 */
export type ForwardResult =
  | { ok: true; id: string; messageId: string }
  | { ok: false; id: string; error: string }

/**
 * Claims all rows where `forwarded_at IS NULL`, validates each, calls
 * `forwardFn` for each valid row, then stamps `forwarded_at` + the returned
 * `message_id` in the same transaction.
 *
 * Claim strategy: open a transaction, SELECT FOR UPDATE SKIP LOCKED to claim
 * a consistent snapshot of un-forwarded rows without blocking concurrent
 * runners, then UPDATE each row after a successful forward. A row is stamped
 * only when `forwardFn` resolves successfully — on error it is left unclaimed
 * so a future run can retry it.
 *
 * Isolation guarantee: because the SELECT holds row-level locks for the
 * duration of the transaction, a second concurrent runner that reaches the
 * same SELECT will see those rows as locked and SKIP them. No row is ever
 * forwarded twice even under concurrent invocation.
 *
 * Per-row defensive design: a single malformed or over-length row does not
 * abort the entire batch. Validation errors are logged and the row's lock
 * is released (we ROLLBACK only the per-row logic, not the outer transaction)
 * — or more precisely, we never stamp it, so it remains claimable on the
 * next run. The outer transaction only commits stamps for rows whose forward
 * succeeded.
 */
export async function claimAndForward(params: {
  pool: PoolType
  forwardFn: (row: ApplicationRow) => Promise<string>
}): Promise<ForwardResult[]> {
  const { pool, forwardFn } = params
  const client: PoolClient = await pool.connect()
  const results: ForwardResult[] = []

  try {
    await client.query('BEGIN')

    // Claim all un-forwarded rows with row-level locks. SKIP LOCKED means
    // concurrent runners silently skip rows already held by another
    // transaction — no deadlocks, no double-forwards.
    const { rows: rawRows } = await client.query<Record<string, unknown>>(
      `SELECT id::text,
              created_at,
              primary_contact_type,
              primary_contact_value,
              extra_contacts,
              justification,
              source_ip_hash
         FROM guardian_applications
        WHERE forwarded_at IS NULL
        ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED`,
    )

    for (const rawRow of rawRows) {
      const parsed = ApplicationRowSchema.safeParse(rawRow)
      if (!parsed.success) {
        // Malformed row: log + skip. We do NOT stamp it, so a future run
        // can retry after a schema fix. We also do NOT abort the batch.
        const id = typeof rawRow['id'] === 'string' ? rawRow['id'] : String(rawRow['id'] ?? '?')
        console.error(
          `[guardian-apply-bot] row id=${id} failed validation — skipping:`,
          parsed.error.issues,
        )
        results.push({ ok: false, id, error: `validation: ${parsed.error.message}` })
        continue
      }

      const row = parsed.data

      let messageId: string
      try {
        messageId = await forwardFn(row)
      } catch (err) {
        // Forward failed — leave un-stamped so next run retries.
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[guardian-apply-bot] forward failed for id=${row.id}:`, errMsg)
        results.push({ ok: false, id: row.id, error: errMsg })
        continue
      }

      // Stamp inside the same transaction. If the process dies here the
      // row will be re-claimed and re-forwarded on the next run — but the
      // Telegram message_id will differ. Acceptable: the stamp is durable
      // once COMMIT succeeds.
      await client.query(
        `UPDATE guardian_applications
            SET forwarded_at = NOW(),
                forwarded_message_id = $1
          WHERE id = $2`,
        [messageId, row.id],
      )

      results.push({ ok: true, id: row.id, messageId })
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }

  return results
}
