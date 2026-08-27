const { spawn } = require('node:child_process')
const path = require('node:path')

const INDEXER_ROOT = path.resolve(__dirname, '../..')
const TEST_DATABASE_PREFIX = 'thatsrekt_registry_fixture_'

const requireFixtureValue = (key) => {
  const value = process.env[key]
  if (value === undefined || value === '') {
    throw new Error(`Missing required Registry fixture value: ${key}`)
  }
  return value
}

const assertFixtureDatabaseUrl = (databaseUrl) => {
  const parsed = new URL(databaseUrl)
  const database = decodeURIComponent(parsed.pathname.slice(1))
  if (
    parsed.protocol !== 'postgres:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5433' ||
    parsed.username !== 'postgres' ||
    parsed.password !== 'postgres' ||
    !new RegExp(`^${TEST_DATABASE_PREFIX}[0-9a-f]{32}$`).test(database)
  ) {
    throw new Error('Registry fixture refuses a non-isolated PostgreSQL target')
  }
}

const assertFixturePortalUrl = (portalUrl) => {
  const parsed = new URL(portalUrl)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') {
    throw new Error('Registry fixture refuses a non-loopback Portal endpoint')
  }
}

const runRegistryPortalFixture = ({
  databaseUrl,
  portalUrl,
  startBlock,
  contractAddress,
}) => {
  assertFixtureDatabaseUrl(databaseUrl)
  assertFixturePortalUrl(portalUrl)

  // Deliberately do not spread process.env: the child must not inherit a database target.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--child'], {
      cwd: INDEXER_ROOT,
      env: {
        DB_URL: databaseUrl,
        DB_SSL: 'false',
        PROCESSOR_PROMETHEUS_PORT: '',
        PROMETHEUS_PORT: '',
        REGISTRY_FIXTURE_DB_URL: databaseUrl,
        REGISTRY_FIXTURE_PORTAL_URL: portalUrl,
        REGISTRY_FIXTURE_START_BLOCK: String(startBlock),
        REGISTRY_FIXTURE_CONTRACT_ADDRESS: contractAddress,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.resume()
    child.stderr.resume()

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 15_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (exitCode) => {
      clearTimeout(timeout)
      resolve(Object.freeze({ exitCode, timedOut }))
    })
  })
}

const startChildProcessor = () => {
  const databaseUrl = requireFixtureValue('REGISTRY_FIXTURE_DB_URL')
  const portalUrl = requireFixtureValue('REGISTRY_FIXTURE_PORTAL_URL')
  const startBlock = Number.parseInt(requireFixtureValue('REGISTRY_FIXTURE_START_BLOCK'), 10)
  const contractAddress = requireFixtureValue('REGISTRY_FIXTURE_CONTRACT_ADDRESS').toLowerCase()
  assertFixtureDatabaseUrl(databaseUrl)
  assertFixturePortalUrl(portalUrl)
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) {
    throw new Error('Registry fixture start block must be a non-negative integer')
  }

  // TypeormDatabase consumes DB_URL, so set it only after the fixture URI is validated.
  process.env.DB_URL = databaseUrl
  process.env.DB_SSL = 'false'
  process.env.PROCESSOR_PROMETHEUS_PORT = ''
  process.env.PROMETHEUS_PORT = ''

  const { TypeormDatabase } = require('@subsquid/typeorm-store')
  const { getChain } = require('../../lib/chains.js')
  const { createRegistryHandler } = require('../../lib/main.js')
  const {
    buildRegistryPortalDataSource,
    runProcessor,
  } = require('../../lib/processor.js')
  const { createPortalHttpClient } = require('../../lib/portal.js')

  const chain = getChain('base')
  const built = Object.freeze({
    kind: 'portal',
    chain,
    contractAddress,
    dataSource: buildRegistryPortalDataSource({
      portal: {
        url: `${portalUrl}/base-mainnet`,
        headers: {},
        http: createPortalHttpClient({
          headers: {},
          deadlineMs: 9_999,
          retryScheduleMs: [1],
        }),
      },
      contractAddress,
      startBlock,
      endBlock: startBlock,
    }),
  })

  runProcessor({
    built,
    database: new TypeormDatabase({
      supportHotBlocks: false,
      projectDir: INDEXER_ROOT,
    }),
    handler: createRegistryHandler({ contractAddress }),
  })
}

if (require.main === module) {
  try {
    startChildProcessor()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Registry fixture failure'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  runRegistryPortalFixture,
}
