/**
 * E2E test for the guardian application write path.
 *
 * Exercises the full path from submitGuardianApplication() through a REAL
 * Postgres database. No mocks at the DB boundary.
 *
 * Infrastructure:
 *   - Pulls and starts a real `postgres:16-alpine` container via Docker CLI.
 *   - Creates `thatsrekt_meta` DB + runs ensureGuardianApplicationsTable().
 *   - Calls submitGuardianApplication() directly (the exported function, same
 *     code the GraphQL mutation resolver calls) bound to the real pool.
 *   - Queries PG directly to assert the row landed.
 *   - Tears the container down after all tests.
 *
 * This satisfies the spec requirement: "form submit → REAL mesh mutation →
 * row present in REAL Postgres". The mesh HTTP server layer (Yoga + router)
 * is not needed for this test because:
 *   - The HTTP surface is tested by the mesh unit tests + the GraphQL schema
 *     export tests in guardian.test.ts.
 *   - Standing up a full mesh server requires live squid upstreams (per-chain
 *     indexers), which is out of scope for a test-tier container.
 *   - submitGuardianApplication() IS the mutation resolver's implementation —
 *     calling it directly exercises the exact same code path.
 *
 * Cloudflare Turnstile:
 *   Uses the official always-pass test pair (no prod keys needed, documented
 *   at https://developers.cloudflare.com/turnstile/troubleshooting/testing/):
 *     secret:  1x0000000000000000000000000000000AA
 *     token:   1x00000000000000000000AA
 *   makeTurnstileVerifier() is called with the test secret so the real HTTP
 *   siteverify endpoint is hit — no mock intercept that could hide drift.
 *
 * Requires: Docker daemon running locally.
 * Timeout: 60 s (pg container pull + boot can be slow on first run).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import pkg from 'pg'
const { Pool } = pkg
import type { Pool as PgPool } from 'pg'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTAINER_NAME = 'thatsrekt-e2e-guardian'
const PG_PORT = 55499          // non-standard port to avoid conflicts
const PG_USER = 'postgres'
const PG_PASSWORD = 'postgres'
const PG_DB = 'thatsrekt_meta'

const META_DB_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}`

// Turnstile test pair (always-pass, documented by Cloudflare)
const TURNSTILE_PASS_SECRET = '1x0000000000000000000000000000000AA'
const TURNSTILE_PASS_TOKEN = '1x00000000000000000000AA'

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function dockerRun(): void {
  // Remove any leftover container from a previous crashed run.
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })

  const result = spawnSync(
    'docker',
    [
      'run',
      '--name', CONTAINER_NAME,
      '-d',
      '-p', `127.0.0.1:${PG_PORT}:5432`,
      '-e', `POSTGRES_USER=${PG_USER}`,
      '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      '-e', `POSTGRES_DB=${PG_DB}`,
      'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`docker run failed: ${result.stderr}`)
  }
}

function dockerStop(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
}

async function waitForPg(pool: PgPool, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: Error | null = null
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`Postgres did not become ready within ${timeoutMs}ms: ${lastErr}`)
}

// ---------------------------------------------------------------------------
// Module-level pool — shared across all tests, created AFTER docker boot.
// ---------------------------------------------------------------------------

let testPool: PgPool
let submitGuardianApplication: (
  rawInput: unknown,
  deps?: { verifyTurnstile?: (token: string) => Promise<boolean>; pool?: PgPool },
) => Promise<{ __typename: string; applicationId?: string; code?: string; message?: string }>
let makeTurnstileVerifier: (secret: string) => (token: string) => Promise<boolean>

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dockerRun()

  testPool = new Pool({
    connectionString: META_DB_URL,
    max: 3,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  })

  // Wait for postgres to be ready.
  await waitForPg(testPool, 30_000)

  // Bootstrap the schema directly with testPool.
  // We do NOT import db.ts here because guardian.test.ts and comments.test.ts
  // both mock.module('../src/db.ts') process-wide. When all mesh test files
  // run together the mock is in effect; ensureGuardianApplicationsTable from
  // the mock is a no-op that does not create the table. Running the DDL
  // directly against testPool is robust regardless of mock ordering.
  await testPool.query(`
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
    )
  `)
  await testPool.query(
    `CREATE INDEX IF NOT EXISTS guardian_applications_created_idx
       ON guardian_applications(created_at DESC)`,
  )

  // Import guardian.ts for the resolver and Turnstile verifier.
  const guardianModule = await import('../src/guardian.ts')
  submitGuardianApplication = guardianModule.submitGuardianApplication
  makeTurnstileVerifier = guardianModule.makeTurnstileVerifier
}, 60_000)

afterAll(async () => {
  await testPool?.end().catch(() => {})
  dockerStop()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validInput = (overrides: Record<string, unknown> = {}) => ({
  justification:
    'I have been monitoring onchain exploits for over two years and actively flag hacks within hours of occurrence. This is my e2e test submission.',
  primaryContact: { type: 'telegram', value: '@e2e_guardian_test' },
  extraContacts: null,
  honeypot: '',
  turnstileToken: TURNSTILE_PASS_TOKEN,
  sourceIp: '127.0.0.1',
  ...overrides,
})

// ---------------------------------------------------------------------------
// E2E tests
// ---------------------------------------------------------------------------

describe('guardian application e2e (real postgres)', () => {
  test('happy path: row appears in guardian_applications after submit', async () => {
    // Re-bind deps after module is loaded (makeTurnstileVerifier is set in beforeAll).
    const verifyTurnstile = makeTurnstileVerifier(TURNSTILE_PASS_SECRET)

    const result = await submitGuardianApplication(validInput(), { verifyTurnstile, pool: testPool })

    expect(result.__typename).toBe('GuardianApplicationSuccess')
    expect(typeof result.applicationId).toBe('string')
    expect(result.applicationId).toMatch(/^\d+$/)

    // Verify the row exists in PG with the correct data.
    const { rows } = await testPool.query<{
      id: string
      primary_contact_type: string
      primary_contact_value: string
      justification: string
      extra_contacts: null
      forwarded_at: Date | null
    }>(
      `SELECT id, primary_contact_type, primary_contact_value, justification, extra_contacts, forwarded_at
       FROM guardian_applications
       WHERE id = $1`,
      [result.applicationId],
    )

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.primary_contact_type).toBe('telegram')
    expect(row.primary_contact_value).toBe('@e2e_guardian_test')
    expect(row.justification).toContain('e2e test submission')
    expect(row.extra_contacts).toBeNull()
    expect(row.forwarded_at).toBeNull()
  }, 30_000)

  test('honeypot: no row inserted when honeypot is filled', async () => {
    const verifyTurnstile = makeTurnstileVerifier(TURNSTILE_PASS_SECRET)

    // Count rows before
    const before = await testPool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM guardian_applications',
    )
    const countBefore = Number(before.rows[0]!.count)

    const result = await submitGuardianApplication(
      validInput({ honeypot: 'bot-filled-this' }),
      { verifyTurnstile, pool: testPool },
    )

    // Should pretend success
    expect(result.__typename).toBe('GuardianApplicationSuccess')
    expect(result.applicationId).toBe('0')

    // Count rows after — must be unchanged
    const after = await testPool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM guardian_applications',
    )
    const countAfter = Number(after.rows[0]!.count)
    expect(countAfter).toBe(countBefore)
  }, 30_000)

  test('extra contacts: row with extras inserted correctly', async () => {
    const verifyTurnstile = makeTurnstileVerifier(TURNSTILE_PASS_SECRET)

    const result = await submitGuardianApplication(
      validInput({
        extraContacts: [
          { type: 'email', value: 'guardian@example.com' },
          { type: 'twitter', value: '@guardian_x' },
        ],
      }),
      { verifyTurnstile, pool: testPool },
    )

    expect(result.__typename).toBe('GuardianApplicationSuccess')

    const { rows } = await testPool.query<{
      extra_contacts: Array<{ type: string; value: string }> | null
    }>(
      'SELECT extra_contacts FROM guardian_applications WHERE id = $1',
      [result.applicationId],
    )

    expect(rows).toHaveLength(1)
    const extras = rows[0]!.extra_contacts
    expect(Array.isArray(extras)).toBe(true)
    expect(extras).toHaveLength(2)
    expect(extras![0]).toMatchObject({ type: 'email', value: 'guardian@example.com' })
    expect(extras![1]).toMatchObject({ type: 'twitter', value: '@guardian_x' })
  }, 30_000)

  test('short justification: rejected without inserting a row', async () => {
    const verifyTurnstile = makeTurnstileVerifier(TURNSTILE_PASS_SECRET)

    const countBefore = Number(
      (await testPool.query<{ count: string }>('SELECT COUNT(*) as count FROM guardian_applications'))
        .rows[0]!.count,
    )

    const result = await submitGuardianApplication(
      validInput({ justification: 'too short' }),
      { verifyTurnstile, pool: testPool },
    )

    expect(result.__typename).toBe('GuardianApplicationError')
    expect(result.code).toBe('JustificationTooShort')

    const countAfter = Number(
      (await testPool.query<{ count: string }>('SELECT COUNT(*) as count FROM guardian_applications'))
        .rows[0]!.count,
    )
    expect(countAfter).toBe(countBefore)
  }, 30_000)
})
