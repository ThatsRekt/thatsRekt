import { randomUUID } from 'node:crypto'
import pkg, { type Pool as PgPool } from 'pg'

const { Pool } = pkg

const LOCAL_TEST_POSTGRES = Object.freeze({
  host: '127.0.0.1',
  port: 5433,
  user: 'postgres',
  password: 'postgres',
})

const testDatabaseName = (): string =>
  `thatsrekt_portal_fixture_${randomUUID().replaceAll('-', '')}`

export interface IsolatedPortalTestPool {
  readonly pool: PgPool
  close(): Promise<void>
}

/**
 * Creates a fresh, locally enforced database for Portal integration tests.
 *
 * The target cannot be redirected by environment variables, and the database
 * is intentionally retained after the test run. Leaving the isolated fixture
 * intact is safer than deleting tables or cursors that could be durable state.
 */
export const createIsolatedPortalTestPool = async (): Promise<IsolatedPortalTestPool> => {
  const database = testDatabaseName()
  const adminPool = new Pool({
    ...LOCAL_TEST_POSTGRES,
    database: 'postgres',
    max: 1,
  })

  try {
    await adminPool.query(`CREATE DATABASE ${database}`)
  } finally {
    await adminPool.end()
  }

  const pool = new Pool({
    ...LOCAL_TEST_POSTGRES,
    database,
    max: 2,
  })

  return Object.freeze({
    pool,
    close: async (): Promise<void> => {
      await pool.end()
    },
  })
}
