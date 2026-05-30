/**
 * Wire-level e2e test: submitGuardianApplication via graphql-request to a
 * real Yoga HTTP server backed by a real Docker Postgres.
 *
 * What this proves:
 *   - The GraphQL document used by the frontend lib (field names, input shape,
 *     __typename union fragments) round-trips correctly through the mesh
 *     resolver all the way to a real PG row.
 *   - The result-union parser mirroring frontend/src/lib/guardian.ts correctly
 *     dispatches GuardianApplicationSuccess to { ok: true, applicationId }
 *     and GuardianApplicationError to { ok: false, code, message }.
 *   - The graphql-request-to-mesh seam is exercised with no mock between them.
 *
 * Why a standalone mini-server (not the full mesh/src/server.ts):
 *   The production server blocks startup waiting for live Subsquid upstreams.
 *   The guardian mutation has no chain-data dependency; it only needs Postgres
 *   and Turnstile. We build a minimal Yoga server using the same resolver
 *   function (submitGuardianApplication) and schema (guardianTypeDefs) that
 *   production uses. The resolver receives an injected pool via the deps
 *   parameter so the test controls which PG instance it talks to.
 *
 * Module isolation note:
 *   guardian.test.ts and comments.test.ts both use mock.module('../src/db.ts')
 *   which is process-wide in Bun. When all mesh test files run together in the
 *   same process, the mocked db.ts is shared. This test avoids the mocked
 *   metaPool singleton by:
 *     1. Running the CREATE TABLE DDL via testPool directly (no db.ts import).
 *     2. Injecting testPool into submitGuardianApplication via deps.pool so
 *        the resolver uses the real container pool, not the mock singleton.
 *   This makes the test robust when bun test runs all files in one process.
 *
 * Turnstile:
 *   Uses the Cloudflare documented always-pass test pair (no prod keys):
 *     secret:  1x0000000000000000000000000000000AA
 *     token:   1x00000000000000000000AA
 *   The real siteverify endpoint is called (no HTTP mock).
 *
 * Requires: Docker daemon running.
 * Timeout: 60s (pg container pull + boot is slow on first run).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createYoga, createSchema } from 'graphql-yoga'
import { GraphQLClient } from 'graphql-request'
import pkg from 'pg'
const { Pool } = pkg
import type { Pool as PgPool } from 'pg'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTAINER_NAME = 'thatsrekt-wire-e2e-guardian'
const PG_PORT = 55498 // distinct from guardian.e2e.test.ts (55499)
const PG_USER = 'postgres'
const PG_PASSWORD = 'postgres'
const PG_DB = 'thatsrekt_meta'
const SERVER_PORT = 54350

const META_DB_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}`

// Turnstile always-pass test pair (Cloudflare documented).
const TURNSTILE_PASS_SECRET = '1x0000000000000000000000000000000AA'
const TURNSTILE_PASS_TOKEN = '1x00000000000000000000AA'

const GRAPHQL_ENDPOINT = `http://127.0.0.1:${SERVER_PORT}/graphql`

// ---------------------------------------------------------------------------
// The GraphQL document mirroring frontend/src/lib/guardian.ts exactly.
//
// If field names or the union shape drift between this document and the
// server schema, graphql-request will throw a ClientError and the test fails.
// ---------------------------------------------------------------------------

const SUBMIT_GUARDIAN_APPLICATION_MUTATION = /* GraphQL */ `
  mutation SubmitGuardianApplication($input: SubmitGuardianApplicationInput!) {
    submitGuardianApplication(input: $input) {
      __typename
      ... on GuardianApplicationSuccess {
        applicationId
      }
      ... on GuardianApplicationError {
        code
        message
      }
    }
  }
`

// ---------------------------------------------------------------------------
// Result-union types and parser mirroring frontend/src/lib/guardian.ts
// ---------------------------------------------------------------------------

type GuardianApplicationErrorCode =
  | 'JustificationTooShort'
  | 'JustificationTooLong'
  | 'InvalidContact'
  | 'TooManyContacts'
  | 'TurnstileFailed'
  | 'InternalError'

type GuardianApplicationResult =
  | { readonly ok: true; readonly applicationId: string }
  | { readonly ok: false; readonly code: GuardianApplicationErrorCode; readonly message: string }

interface GuardianApplicationSuccessRaw {
  __typename: 'GuardianApplicationSuccess'
  applicationId: string
}

interface GuardianApplicationErrorRaw {
  __typename: 'GuardianApplicationError'
  code: GuardianApplicationErrorCode
  message: string
}

type GuardianApplicationResultRaw =
  | GuardianApplicationSuccessRaw
  | GuardianApplicationErrorRaw

/** Mirrors the union dispatch in frontend/src/lib/guardian.ts. */
function parseGuardianResult(raw: GuardianApplicationResultRaw): GuardianApplicationResult {
  if (raw.__typename === 'GuardianApplicationSuccess') {
    return { ok: true, applicationId: raw.applicationId }
  }
  return { ok: false, code: raw.code, message: raw.message }
}

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function dockerRun(): void {
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

/**
 * Run the guardian_applications DDL directly against the given pool.
 * Mirrors the SQL in db.ts ensureGuardianApplicationsTable but avoids
 * importing db.ts (which may be mocked when all test files run together).
 */
async function ensureTableDirect(pool: PgPool): Promise<void> {
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
    )
  `)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS guardian_applications_created_idx
       ON guardian_applications(created_at DESC)`,
  )
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let testPool: PgPool
let httpServer: Server
let gqlClient: GraphQLClient

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Boot the Docker PG container.
  dockerRun()

  testPool = new Pool({
    connectionString: META_DB_URL,
    max: 3,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  })
  await waitForPg(testPool, 30_000)

  // 2. Create the table directly using testPool.
  //    We do NOT import db.ts here because guardian.test.ts and
  //    comments.test.ts both mock.module('../src/db.ts') process-wide.
  //    When all mesh test files run together the mock is in effect;
  //    using testPool directly sidesteps the module mock entirely.
  await ensureTableDirect(testPool)

  // 3. Import guardian module for resolver function, schema SDL, and
  //    the makeTurnstileVerifier factory.
  //    guardian.ts imports db.ts at the top level, so guardian.ts may also
  //    be influenced by the db.ts mock. However, by injecting testPool via
  //    deps.pool (added in GuardianDeps), the INSERT path uses our real
  //    container pool, not the module-level metaPool singleton.
  const { guardianTypeDefs, makeTurnstileVerifier, submitGuardianApplication } =
    await import('../src/guardian.js')

  // Turnstile verifier using the Cloudflare always-pass test secret.
  const verifyTurnstile = makeTurnstileVerifier(TURNSTILE_PASS_SECRET)

  // 4. Build a minimal Yoga server with only the guardian mutation.
  //    guardianTypeDefs uses `extend type Mutation`; prepend a base type.
  const standaloneTypeDefs = /* GraphQL */ `
    type Query { _noop: Boolean }
    type Mutation { _noop: Boolean }
  ` + guardianTypeDefs

  const schema = createSchema({
    typeDefs: standaloneTypeDefs,
    resolvers: {
      Mutation: {
        // Custom resolver: wraps submitGuardianApplication with injected
        // testPool and always-pass Turnstile verifier. This exercises the
        // real validation + insert path without depending on the mocked
        // module-level metaPool singleton.
        submitGuardianApplication: (
          _root: unknown,
          args: {
            input: {
              justification: string
              primaryContact: { type: string; value: string }
              extraContacts?: Array<{ type: string; value: string }> | null
              honeypot: string
              turnstileToken: string
            }
          },
        ) =>
          submitGuardianApplication(
            { ...args.input, extraContacts: args.input.extraContacts ?? null },
            { verifyTurnstile, pool: testPool },
          ),
      },
      GuardianApplicationResult: {
        __resolveType: (obj: { __typename: string }) => obj.__typename,
      },
    },
  })

  const yoga = createYoga({ schema, landingPage: false })
  httpServer = createServer(yoga)

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(SERVER_PORT, '127.0.0.1', () => resolve())
    httpServer.on('error', reject)
  })

  // 5. Wire the graphql-request client. Same constructor the frontend lib uses.
  gqlClient = new GraphQLClient(GRAPHQL_ENDPOINT)
}, 60_000)

afterAll(async () => {
  await testPool?.end().catch(() => {})
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
  dockerStop()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validInput = (overrides: Record<string, unknown> = {}) => ({
  justification:
    'I have been monitoring onchain exploits for over two years and actively flag hacks within hours of occurrence. Wire e2e submission.',
  primaryContact: { type: 'telegram', value: '@wire_e2e_guardian' },
  extraContacts: null,
  honeypot: '',
  turnstileToken: TURNSTILE_PASS_TOKEN,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('guardian wire e2e (graphql-request to real Yoga to real Postgres)', () => {
  test('happy path: row appears in PG and result parses to ok: true', async () => {
    const data = await gqlClient.request<{
      submitGuardianApplication: GuardianApplicationResultRaw
    }>(SUBMIT_GUARDIAN_APPLICATION_MUTATION, { input: validInput() })

    const result = parseGuardianResult(data.submitGuardianApplication)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected ok: true')
    expect(result.applicationId).toMatch(/^\d+$/)

    // Row must exist in real Postgres.
    const { rows } = await testPool.query<{
      primary_contact_type: string
      primary_contact_value: string
      justification: string
    }>(
      `SELECT primary_contact_type, primary_contact_value, justification
       FROM guardian_applications WHERE id = $1`,
      [result.applicationId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.primary_contact_type).toBe('telegram')
    expect(rows[0]!.primary_contact_value).toBe('@wire_e2e_guardian')
    expect(rows[0]!.justification).toContain('Wire e2e submission')
  }, 30_000)

  test('validation error: short justification maps to ok: false with JustificationTooShort code', async () => {
    const data = await gqlClient.request<{
      submitGuardianApplication: GuardianApplicationResultRaw
    }>(SUBMIT_GUARDIAN_APPLICATION_MUTATION, {
      input: validInput({ justification: 'too short' }),
    })

    const result = parseGuardianResult(data.submitGuardianApplication)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected ok: false')
    expect(result.code).toBe('JustificationTooShort')
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
  }, 30_000)

  test('Turnstile gate: empty token maps to ok: false with TurnstileFailed code', async () => {
    const data = await gqlClient.request<{
      submitGuardianApplication: GuardianApplicationResultRaw
    }>(SUBMIT_GUARDIAN_APPLICATION_MUTATION, {
      input: validInput({ turnstileToken: '' }),
    })

    const result = parseGuardianResult(data.submitGuardianApplication)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected ok: false')
    expect(result.code).toBe('TurnstileFailed')
  }, 30_000)

  test('extra contacts: extras land correctly in PG JSONB column', async () => {
    const data = await gqlClient.request<{
      submitGuardianApplication: GuardianApplicationResultRaw
    }>(SUBMIT_GUARDIAN_APPLICATION_MUTATION, {
      input: validInput({
        extraContacts: [
          { type: 'email', value: 'wire@example.com' },
          { type: 'twitter', value: '@wire_guard_x' },
        ],
      }),
    })

    const result = parseGuardianResult(data.submitGuardianApplication)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected ok: true')

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
    expect(extras![0]).toMatchObject({ type: 'email', value: 'wire@example.com' })
    expect(extras![1]).toMatchObject({ type: 'twitter', value: '@wire_guard_x' })
  }, 30_000)
})
