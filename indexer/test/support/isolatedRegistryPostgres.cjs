const { randomUUID } = require('node:crypto')
const path = require('node:path')

const { Pool } = require('pg')
const { DataSource } = require('typeorm')
const { SnakeNamingStrategy } = require('@subsquid/typeorm-config/lib/namingStrategy.js')

const INDEXER_ROOT = path.resolve(__dirname, '../..')
const TEST_DATABASE_PREFIX = 'thatsrekt_registry_fixture_'
const LOCAL_TEST_POSTGRES = Object.freeze({
  host: '127.0.0.1',
  port: 5433,
  user: 'postgres',
  password: 'postgres',
})

const testDatabaseName = () =>
  `${TEST_DATABASE_PREFIX}${randomUUID().replaceAll('-', '')}`

const assertFixtureDatabaseName = (database) => {
  if (!new RegExp(`^${TEST_DATABASE_PREFIX}[0-9a-f]{32}$`).test(database)) {
    throw new Error('Registry fixture database name is not safely generated')
  }
}

const migrateFixtureDatabase = async (database) => {
  const dataSource = new DataSource({
    type: 'postgres',
    host: LOCAL_TEST_POSTGRES.host,
    port: LOCAL_TEST_POSTGRES.port,
    username: LOCAL_TEST_POSTGRES.user,
    password: LOCAL_TEST_POSTGRES.password,
    database,
    ssl: false,
    namingStrategy: new SnakeNamingStrategy(),
    entities: [require.resolve(path.join(INDEXER_ROOT, 'lib/model'))],
    migrations: [path.join(INDEXER_ROOT, 'db/migrations/*.js')],
  })
  try {
    await dataSource.initialize()
    await dataSource.runMigrations()
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy()
  }
}

const createIsolatedRegistryFixture = async () => {
  const database = testDatabaseName()
  assertFixtureDatabaseName(database)

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

  await migrateFixtureDatabase(database)

  const pool = new Pool({
    ...LOCAL_TEST_POSTGRES,
    database,
    max: 2,
  })
  return Object.freeze({
    pool,
    databaseUrl: `postgres://postgres:postgres@127.0.0.1:5433/${database}`,
    async close() {
      await pool.end()
    },
  })
}

module.exports = {
  createIsolatedRegistryFixture,
}
