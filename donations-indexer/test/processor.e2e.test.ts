import { expect, test } from 'bun:test'
import pkg, { type Pool as PgPool } from 'pg'

import { acquireIndexerLock, type IndexerLock } from '../src/indexerLock.ts'

const { Pool } = pkg

const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  'postgres://postgres:postgres@localhost:5432/donations_test'

const indexerEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  DOTENV_CONFIG_PATH: '/dev/null',
  CHAIN_SLUG: 'ethereum',
  DONATIONS_DB_URL: TEST_DB_URL,
  MAX_RUNTIME_SECONDS: '1500',
  PORTAL_URL: 'https://portal.example',
  RPC_ETHEREUM_HTTP: 'http://127.0.0.1:1',
})

const runIndexer = async (environment: NodeJS.ProcessEnv): Promise<{
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}> => {
  const child = Bun.spawn({
    cmd: ['node', 'lib/main.js'],
    cwd: process.cwd(),
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  return { exitCode, stdout, stderr }
}

const publicRelations = async (pool: PgPool): Promise<readonly string[]> => {
  const result = await pool.query<{ readonly name: string }>(
    `SELECT tablename AS name
     FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename`,
  )
  return result.rows.map(({ name }) => name)
}

const relationExists = async (pool: PgPool, relation: string): Promise<boolean> => {
  const result = await pool.query<{ readonly exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [relation],
  )
  return result.rows[0]?.exists === true
}

const indexerRows = async (
  pool: PgPool,
): Promise<{
  readonly cursor: readonly Record<string, unknown>[]
  readonly donations: readonly Record<string, unknown>[]
}> => {
  const cursor =
    (await relationExists(pool, 'public.donations_indexer_status_v2'))
      ? (
          await pool.query<Record<string, unknown>>(
            `SELECT chain_id, height, hash, durable_progress_at_ms
             FROM donations_indexer_status_v2
             WHERE chain_id = 1`,
          )
        ).rows
      : []
  const donations =
    (await relationExists(pool, 'public.donation'))
      ? (
          await pool.query<Record<string, unknown>>(
            `SELECT id, chain_id, chain_slug, from_address, token_address, token_symbol,
                    token_decimals, amount_raw, amount_norm, tx_hash, log_index, block_number,
                    block_timestamp
             FROM donation
             WHERE chain_id = 1
             ORDER BY id`,
          )
        ).rows
      : []

  return { cursor, donations }
}

test('duplicate process exits cleanly without mutating PostgreSQL', async () => {
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 2 })
  let lock: IndexerLock | null = null

  try {
    lock = await acquireIndexerLock(pool, 1)
    expect(lock).not.toBeNull()
    if (lock === null) throw new Error('expected test process to acquire the Ethereum lock')

    const before = {
      relations: await publicRelations(pool),
      rows: await indexerRows(pool),
    }
    const child = await runIndexer(indexerEnvironment())
    const after = {
      relations: await publicRelations(pool),
      rows: await indexerRows(pool),
    }

    expect(child.exitCode).toBe(0)
    expect(child.stdout.trim()).toBe(
      '[donations-indexer] duplicate run skipped: chain=ethereum already owns singleton lock',
    )
    expect(child.stderr).toBe('')
    expect(after).toEqual(before)
  } finally {
    await lock?.release()
    await pool.end()
  }
})

test('missing or malformed runtime limits fail before indexer infrastructure starts', async () => {
  for (const [runtimeLimit, expectedError] of [
    [undefined, 'Missing required env var: MAX_RUNTIME_SECONDS'],
    ['0', 'Invalid MAX_RUNTIME_SECONDS: expected a positive integer'],
    ['-1', 'Invalid MAX_RUNTIME_SECONDS: expected a positive integer'],
    ['not-a-number', 'Invalid MAX_RUNTIME_SECONDS: expected a positive integer'],
  ] as const) {
    const environment = indexerEnvironment()
    environment.DONATIONS_DB_URL = 'postgres://postgres:postgres@127.0.0.1:1/unreachable'
    if (runtimeLimit === undefined) {
      delete environment.MAX_RUNTIME_SECONDS
    } else {
      environment.MAX_RUNTIME_SECONDS = runtimeLimit
    }

    const child = await runIndexer(environment)

    expect(child.exitCode).toBe(1)
    expect(`${child.stdout}${child.stderr}`).toContain(expectedError)
  }
})

test('runtime deadline exits cleanly after acquiring the singleton lock', async () => {
  const environment = indexerEnvironment()
  environment.MAX_RUNTIME_SECONDS = '1'
  environment.DONEE_OVERRIDE = '0x59e4db1c95bd312a882bb36b7f3e8298682340679'
  environment.PORTAL_URL = 'https://127.0.0.1:1'

  const child = await runIndexer(environment)
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  let lock: IndexerLock | null = null

  try {
    expect(`${child.stdout}${child.stderr}`).toContain('Donations indexer maximum runtime reached')
    expect(child.exitCode).toBe(0)
    lock = await acquireIndexerLock(pool, 1)
    expect(lock).not.toBeNull()
  } finally {
    await lock?.release()
    await pool.end()
  }
}, 10_000)
