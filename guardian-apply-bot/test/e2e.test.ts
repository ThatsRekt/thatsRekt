/**
 * E2E idempotency tests for the guardian-apply-bot forwarding cycle.
 *
 * These tests run against a REAL PostgreSQL instance (docker postgres:16-alpine)
 * started via `docker run` before the suite. The transactional-claim logic is
 * the core deliverable — it MUST be verified against real PG semantics
 * (`FOR UPDATE SKIP LOCKED` etc.), not mocked.
 *
 * Telegram leg: the `forwardFn` is injected as a counter stub. It returns a
 * deterministic synthetic message_id so we can verify stamp behaviour without
 * a live bot. The stub also lets us simulate forward failures to confirm the
 * row is left un-stamped for retry. The captured Telegram response fixture
 * (`fixtures/sendMessage.json`) validates the response schema used in
 * production.
 *
 * What this suite proves:
 *   P1 — Seed N rows -> run -> N posts + all rows stamped (happy path).
 *   P2 — Run again over same data -> 0 posts (idempotency: nothing re-forwarded).
 *   P3 — Concurrent runs don't double-post (two parallel calls, N rows total).
 *   P4 — A failing forward leaves the row un-stamped; next run retries it.
 *   P5 — A malformed/invalid row does not wedge the batch; valid rows still forward.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import pkg from 'pg'
const { Pool } = pkg
import type { Pool as PoolType } from 'pg'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import {
  claimAndForward,
  ensureGuardianApplicationsTable,
  type ApplicationRow,
} from '../src/db.ts'
import sendMessageFixture from './fixtures/sendMessage.json' assert { type: 'json' }

// ---------------------------------------------------------------------------
// Telegram response fixture validation
// ---------------------------------------------------------------------------
// Validate that our fixture matches the schema the production sender parses.
// This catches contract drift without needing a live bot call.

import { SendMessageResponseSchema } from '../src/telegram.ts'

// ---------------------------------------------------------------------------
// Docker Postgres lifecycle
// ---------------------------------------------------------------------------

const CONTAINER_NAME = `guardian-apply-bot-test-${randomUUID().slice(0, 8)}`
const TEST_DB_PORT = 15432
const TEST_DB_URL = `postgres://postgres:testpassword@127.0.0.1:${TEST_DB_PORT}/thatsrekt_meta`

/**
 * Start a throwaway Postgres container. Blocks until Postgres is ready to
 * accept host connections.
 */
function startPostgres(): void {
  execSync(
    `docker run -d --name ${CONTAINER_NAME} \
      -e POSTGRES_PASSWORD=testpassword \
      -e POSTGRES_DB=thatsrekt_meta \
      -p 127.0.0.1:${TEST_DB_PORT}:5432 \
      postgres:16-alpine`,
    { stdio: 'pipe' },
  )

  // Wait until pg_isready succeeds from INSIDE the container, then do an
  // additional host-level check via psql to confirm the port is open to
  // the host. This double-check avoids a race where pg_isready passes
  // internally but the host port binding hasn't stabilised yet.
  execSync(
    `for i in $(seq 1 60); do \
       docker exec ${CONTAINER_NAME} pg_isready -U postgres > /dev/null 2>&1 && break; \
       sleep 0.3; \
     done && \
     for i in $(seq 1 20); do \
       PGPASSWORD=testpassword psql -h 127.0.0.1 -p ${TEST_DB_PORT} -U postgres -d thatsrekt_meta -c "SELECT 1" > /dev/null 2>&1 && break; \
       sleep 0.3; \
     done`,
    { stdio: 'pipe' },
  )
}

function stopPostgres(): void {
  execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'pipe' })
}

// ---------------------------------------------------------------------------
// Test pool
// ---------------------------------------------------------------------------

let pool: PoolType

beforeAll(async () => {
  startPostgres()
  pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
})

afterAll(async () => {
  await pool.end()
  stopPostgres()
})

// ---------------------------------------------------------------------------
// Per-test cleanup: truncate the table so tests are isolated.
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await ensureGuardianApplicationsTable(pool)
  await pool.query(`TRUNCATE guardian_applications RESTART IDENTITY`)
})

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

async function seedApplications(n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO guardian_applications
         (primary_contact_type, primary_contact_value, justification, extra_contacts)
       VALUES ($1, $2, $3, $4)
       RETURNING id::text`,
      [
        'telegram',
        `@guardian_${i}`,
        `Test justification ${i}: this is a long enough justification string to pass the 50-char check easily.`,
        null,
      ],
    )
    ids.push(rows[0]!.id)
  }
  return ids
}

/** Count rows where forwarded_at IS NOT NULL. */
async function countForwarded(): Promise<number> {
  const { rows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM guardian_applications WHERE forwarded_at IS NOT NULL`,
  )
  return Number.parseInt(rows[0]!.cnt, 10)
}

/** Count rows where forwarded_at IS NULL. */
async function countPending(): Promise<number> {
  const { rows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM guardian_applications WHERE forwarded_at IS NULL`,
  )
  return Number.parseInt(rows[0]!.cnt, 10)
}

/** Read forwarded_message_id for a given row id. */
async function getMessageId(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ forwarded_message_id: string | null }>(
    `SELECT forwarded_message_id FROM guardian_applications WHERE id = $1`,
    [id],
  )
  return rows[0]?.forwarded_message_id ?? null
}

// ---------------------------------------------------------------------------
// Counter stub for the forward function
// ---------------------------------------------------------------------------

function makeCounterForwardFn(): {
  fn: (row: ApplicationRow) => Promise<string>
  count: () => number
  calledIds: () => string[]
} {
  let calls = 0
  const ids: string[] = []
  return {
    fn: async (row: ApplicationRow) => {
      calls++
      ids.push(row.id)
      // Return a synthetic message_id that encodes the call order.
      return `msg_${calls}_for_${row.id}`
    },
    count: () => calls,
    calledIds: () => [...ids],
  }
}

// ---------------------------------------------------------------------------
// Telegram fixture schema validation
// ---------------------------------------------------------------------------

describe('Telegram response fixture schema', () => {
  test('captured sendMessage fixture matches the production response schema', () => {
    const result = SendMessageResponseSchema.safeParse(sendMessageFixture)
    expect(result.success).toBe(true)
    if (result.success && result.data.ok) {
      expect(typeof result.data.result.message_id).toBe('number')
    }
  })
})

// ---------------------------------------------------------------------------
// P1: Happy path — seed N -> run -> N forwarded + all stamped
// ---------------------------------------------------------------------------

describe('P1 - happy path', () => {
  test('seeds 3 rows, forwards all 3, stamps all 3', async () => {
    const ids = await seedApplications(3)
    const stub = makeCounterForwardFn()

    const results = await claimAndForward({ pool, forwardFn: stub.fn })

    // 3 results, all ok
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.ok)).toBe(true)

    // Forward function called exactly 3 times
    expect(stub.count()).toBe(3)

    // All rows stamped in DB
    expect(await countForwarded()).toBe(3)
    expect(await countPending()).toBe(0)

    // Each row has a message_id recorded
    for (const id of ids) {
      const msgId = await getMessageId(id)
      expect(msgId).not.toBeNull()
      expect(typeof msgId).toBe('string')
    }
  })

  test('returns empty array and calls forwardFn 0 times when table is empty', async () => {
    const stub = makeCounterForwardFn()
    const results = await claimAndForward({ pool, forwardFn: stub.fn })
    expect(results).toHaveLength(0)
    expect(stub.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// P2: Idempotency — second run posts 0 additional messages
// ---------------------------------------------------------------------------

describe('P2 - idempotency', () => {
  test('second run over same data produces 0 additional forwards', async () => {
    await seedApplications(3)
    const stub1 = makeCounterForwardFn()

    // First run: forwards 3
    await claimAndForward({ pool, forwardFn: stub1.fn })
    expect(stub1.count()).toBe(3)
    expect(await countForwarded()).toBe(3)

    // Second run: nothing to claim
    const stub2 = makeCounterForwardFn()
    const secondResults = await claimAndForward({ pool, forwardFn: stub2.fn })
    expect(secondResults).toHaveLength(0)
    expect(stub2.count()).toBe(0)

    // DB state unchanged
    expect(await countForwarded()).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// P3: Concurrent runs — no double-posting
// ---------------------------------------------------------------------------

describe('P3 - concurrent safety', () => {
  test('two parallel calls over 4 rows produce exactly 4 total forwards with no duplicates', async () => {
    const ids = await seedApplications(4)

    // Both stubs share a call-tracking array so we can detect duplicates.
    const calledIds: string[] = []
    let msgCounter = 0

    const sharedForwardFn = async (row: ApplicationRow): Promise<string> => {
      calledIds.push(row.id)
      msgCounter++
      // Simulate non-trivial work so SKIP LOCKED has time to differentiate.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return `msg_${msgCounter}`
    }

    // Launch two concurrent claim-and-forward cycles against the same pool.
    const [results1, results2] = await Promise.all([
      claimAndForward({ pool, forwardFn: sharedForwardFn }),
      claimAndForward({ pool, forwardFn: sharedForwardFn }),
    ])

    const allResults = [...results1, ...results2]
    const successResults = allResults.filter((r) => r.ok)

    // Total successful forwards = exactly 4 (one per row, no duplicates).
    expect(successResults).toHaveLength(4)

    // Each row id appears exactly once in the called list.
    const sortedCalled = [...calledIds].sort()
    const sortedIds = [...ids].sort()
    expect(sortedCalled).toEqual(sortedIds)

    // All rows stamped in DB exactly once.
    expect(await countForwarded()).toBe(4)
    expect(await countPending()).toBe(0)

    // No row was forwarded twice (message_id is unique per row).
    const allRowMessageIds = await Promise.all(ids.map((id) => getMessageId(id)))
    const nonNullIds = allRowMessageIds.filter(Boolean)
    const uniqueIds = new Set(nonNullIds)
    expect(uniqueIds.size).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// P4: Failed forward leaves row un-stamped; next run retries
// ---------------------------------------------------------------------------

describe('P4 - forward failure retry', () => {
  test('failing forward on 1 of 2 rows leaves it un-stamped; succeeds on retry', async () => {
    const ids = await seedApplications(2)
    const [failId, successId] = ids as [string, string]

    let firstRun = true
    const failFirstFn = async (row: ApplicationRow): Promise<string> => {
      if (firstRun && row.id === failId) {
        throw new Error('Telegram API is down')
      }
      return `msg_for_${row.id}`
    }

    // First run: one succeeds, one fails.
    const firstResults = await claimAndForward({ pool, forwardFn: failFirstFn })
    const firstOk = firstResults.filter((r) => r.ok)
    const firstFail = firstResults.filter((r) => !r.ok)
    expect(firstOk).toHaveLength(1)
    expect(firstFail).toHaveLength(1)
    expect(firstFail[0]!.id).toBe(failId)

    // Only the successful row is stamped.
    expect(await countForwarded()).toBe(1)
    expect(await countPending()).toBe(1)
    expect(await getMessageId(successId)).not.toBeNull()
    expect(await getMessageId(failId)).toBeNull()

    // Second run: the failing row is now retried and succeeds.
    firstRun = false
    const secondResults = await claimAndForward({ pool, forwardFn: failFirstFn })
    expect(secondResults.filter((r) => r.ok)).toHaveLength(1)
    expect(secondResults[0]!.id).toBe(failId)

    // Now both rows are stamped.
    expect(await countForwarded()).toBe(2)
    expect(await countPending()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// P5: Malformed row does not wedge the batch
// ---------------------------------------------------------------------------

describe('P5 - malformed row isolation', () => {
  test('a row with a justification over the app cap (>1000 chars) is skipped; valid rows still forward', async () => {
    // Insert one valid row.
    const { rows: validRows } = await pool.query<{ id: string }>(
      `INSERT INTO guardian_applications
         (primary_contact_type, primary_contact_value, justification)
       VALUES ('email', 'alice@example.com', $1)
       RETURNING id::text`,
      ['This is a valid justification that is definitely long enough to pass the 50-character minimum check.'],
    )
    const validId = validRows[0]!.id

    // Insert a row with a 1001-char justification. The DB allows up to 1500
    // chars (CHECK constraint), so this INSERT succeeds. The bot's Zod schema
    // caps justification at 1000 chars (app-level policy: keeps TG messages
    // readable). The bot skips this row and leaves it un-stamped for manual review.
    const longJustification = 'A'.repeat(1001)
    const { rows: rawRows } = await pool.query<{ id: string }>(
      `INSERT INTO guardian_applications
         (primary_contact_type, primary_contact_value, justification)
       VALUES ('telegram', '@another_handle', $1)
       RETURNING id::text`,
      [longJustification],
    )
    const badId = rawRows[0]!.id

    const stub = makeCounterForwardFn()
    const results = await claimAndForward({ pool, forwardFn: stub.fn })

    // 2 results: 1 ok (valid row) + 1 validation failure (over-long justification)
    const okResults = results.filter((r) => r.ok)
    const failResults = results.filter((r) => !r.ok)
    expect(okResults).toHaveLength(1)
    expect(failResults).toHaveLength(1)

    // The valid row is forwarded and stamped; the bad row is not.
    expect(stub.count()).toBe(1)
    expect(okResults[0]!.id).toBe(validId)
    expect(await getMessageId(validId)).not.toBeNull()
    expect(failResults[0]!.id).toBe(badId)
    expect(await getMessageId(badId)).toBeNull()
  })
})
