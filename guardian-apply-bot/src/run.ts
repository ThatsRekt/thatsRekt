/**
 * Core orchestration loop for one bot invocation.
 *
 * Single responsibility: wire DB claim -> format -> Telegram post -> DB stamp.
 * No global state. Accepts injected dependencies so the e2e test can supply
 * a real PG pool and a stubbed forwardFn while keeping the Telegram network
 * call out of the DB-idempotency test.
 */

import { claimAndForward, ensureGuardianApplicationsTable, metaPool } from './db.js'
import { formatApplication } from './format.js'
import { sendMessage } from './telegram.js'
import type { TelegramConfig } from './telegram.js'
import type { ForwardResult } from './db.js'
import type { Pool as PoolType } from 'pg'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run one full forwarding cycle:
 *   1. Ensure schema exists (idempotent DDL).
 *   2. Transactionally claim all rows where `forwarded_at IS NULL`.
 *   3. For each claimed row: format -> post to Telegram -> stamp in DB.
 *   4. Return per-row results.
 *
 * `pool` is injectable so tests can point the service at a test database
 * without touching the real `metaPool` singleton.
 *
 * `forwardFn` is injectable for tests that want to probe the claim/stamp
 * logic with a controlled stand-in for the Telegram call.
 */
export async function runForwardingCycle(params: {
  pool?: PoolType
  telegramConfig: TelegramConfig
  /** Override the forward function (e.g. in tests). Defaults to real sendMessage. */
  forwardFn?: (row: Parameters<typeof formatApplication>[0]) => Promise<string>
}): Promise<ForwardResult[]> {
  const pool = params.pool ?? metaPool
  const { telegramConfig } = params

  const forwardFn =
    params.forwardFn ??
    (async (row) => {
      const text = formatApplication(row)
      return sendMessage({ config: telegramConfig, text })
    })

  await ensureGuardianApplicationsTable(pool)

  return claimAndForward({ pool, forwardFn })
}
