const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const test = require('node:test')

const { events } = require('../lib/abi/ThatsRekt.js')
const {
  createIsolatedRegistryFixture,
} = require('./support/isolatedRegistryPostgres.cjs')
const {
  runRegistryPortalFixture,
} = require('./support/runRegistryPortalFixture.cjs')

const BLOCK_HEIGHT = 50_517_211
const BLOCK_HASH = `0x${BLOCK_HEIGHT.toString(16).padStart(64, '0')}`
const PARENT_HASH = `0x${(BLOCK_HEIGHT - 1).toString(16).padStart(64, '0')}`
const BASE_HASH = `0x${(BLOCK_HEIGHT - 2).toString(16).padStart(64, '0')}`
const CONTRACT = '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A'
const WHITELISTER = '0x000000000000000000000000000000000000c0de'
const HOT_ONLY_WHITELISTER = '0x000000000000000000000000000000000000dead'
const TRANSACTION_HASH = `0x${'c0ffee'.padStart(64, '0')}`

const addressWord = (address) => address.slice(2).padStart(64, '0')
const statusWord = (status) => (status ? '1' : '0').padStart(64, '0')

const controlledRegistryBlock = Object.freeze({
  header: {
    number: BLOCK_HEIGHT,
    hash: BLOCK_HASH,
    parentHash: PARENT_HASH,
    timestamp: 1_735_689_600,
  },
  transactions: [],
  logs: [
    {
      transactionIndex: 0,
      address: CONTRACT,
      topics: [
        events.WhitelistUpdated.topic,
        `0x${addressWord(WHITELISTER)}`,
      ],
      data: `0x${statusWord(true)}`,
      transactionHash: TRANSACTION_HASH,
      logIndex: 0,
    },
  ],
})

const controlledRegistryParentBlock = Object.freeze({
  header: {
    number: BLOCK_HEIGHT - 1,
    hash: PARENT_HASH,
    parentHash: BASE_HASH,
    timestamp: controlledRegistryBlock.header.timestamp - 12,
  },
  transactions: [],
  logs: [],
})

const createControlledPortalServer = async () => {
  let mode = 'data'
  let deliveredBlock = false
  const requests = []
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) {
      body += chunk
    }

    const url = new URL(request.url, 'http://127.0.0.1')
    const query = body === '' ? undefined : JSON.parse(body)
    requests.push({
      path: url.pathname,
      query,
    })
    if (url.pathname.endsWith('/finalized-head')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ number: BLOCK_HEIGHT, hash: BLOCK_HASH }))
      return
    }
    if (!url.pathname.endsWith('/finalized-stream')) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('unknown controlled Portal endpoint')
      return
    }

    const streamFromBlock =
      typeof query === 'object' &&
      query !== null &&
      'fromBlock' in query &&
      typeof query.fromBlock === 'number'
        ? query.fromBlock
        : undefined
    const canServeTarget =
      streamFromBlock === BLOCK_HEIGHT || streamFromBlock === BLOCK_HEIGHT - 1
    if (!canServeTarget) {
      const finalizedHeight =
        streamFromBlock !== undefined && streamFromBlock > BLOCK_HEIGHT
          ? BLOCK_HEIGHT
          : BLOCK_HEIGHT - 1
      response.writeHead(204, {
        'x-sqd-finalized-head-number': String(finalizedHeight),
        'x-sqd-finalized-head-hash': finalizedHeight === BLOCK_HEIGHT
          ? BLOCK_HASH
          : PARENT_HASH,
      })
      response.end()
      return
    }

    if (mode === 'retry') {
      response.writeHead(529, {
        'content-type': 'text/plain',
        'retry-after': '10',
      })
      response.end('retry later')
      return
    }
    if (mode === 'malformed') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end('{not-json}\n')
      return
    }
    if (!deliveredBlock) {
      deliveredBlock = true
      response.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'x-sqd-finalized-head-number': String(BLOCK_HEIGHT),
        'x-sqd-finalized-head-hash': BLOCK_HASH,
      })
      const blocks = streamFromBlock === BLOCK_HEIGHT - 1
        ? [controlledRegistryParentBlock, controlledRegistryBlock]
        : [controlledRegistryBlock]
      response.end(`${blocks.map((block) => JSON.stringify(block)).join('\n')}\n`)
      return
    }

    response.writeHead(204, {
      'x-sqd-finalized-head-number': String(BLOCK_HEIGHT),
      'x-sqd-finalized-head-hash': BLOCK_HASH,
    })
    response.end()
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port

  return Object.freeze({
    url: `http://127.0.0.1:${port}`,
    requests,
    setMode(nextMode) {
      mode = nextMode
      deliveredBlock = false
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  })
}

const isTargetStreamRequest = ({ path, query }) =>
  path.endsWith('/finalized-stream') &&
  typeof query === 'object' &&
  query !== null &&
  'fromBlock' in query &&
  query.fromBlock === BLOCK_HEIGHT

const assertNoDurableProgress = async (pool) => {
  const status = await pool.query(
    'SELECT height, hash FROM squid_processor.status WHERE id = 0',
  )
  assert.deepEqual(status.rows, [{ height: -1, hash: '0x' }])

  for (const table of ['whitelister', 'proposer', 'whitelist_change']) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)
    assert.equal(rows[0].count, 0, `${table} must remain uncommitted`)
  }
}
const seedLegacyHotState = async ({
  pool,
  statusHeight,
  statusHash,
  hotHeight,
  hotHash,
  change,
  hotChangeIndex = 0,
}) => {
  await pool.query(
    `INSERT INTO squid_processor.status (id, height, hash, nonce)
     VALUES (0, $1, $2, 1)`,
    [statusHeight, statusHash],
  )
  await pool.query(
    `CREATE TABLE squid_processor.hot_block (
       height int4 PRIMARY KEY,
       hash text NOT NULL
     );
     CREATE TABLE squid_processor.hot_change_log (
       block_height int4 NOT NULL
         REFERENCES squid_processor.hot_block ON DELETE CASCADE,
       index int4 NOT NULL,
       change jsonb NOT NULL,
       PRIMARY KEY (block_height, index)
     );
     CREATE TABLE squid_processor.template_registry (
       key text NOT NULL,
       value text NOT NULL,
       type boolean NOT NULL,
       block_number int NOT NULL,
       height int NOT NULL,
       PRIMARY KEY (key, value, type, block_number)
     )`,
  )
  await pool.query(
    `INSERT INTO squid_processor.hot_block (height, hash)
     VALUES ($1, $2)`,
    [hotHeight, hotHash],
  )
  await pool.query(
    `INSERT INTO squid_processor.hot_change_log (block_height, index, change)
     VALUES ($1, $2, $3::jsonb)`,
    [hotHeight, hotChangeIndex, JSON.stringify(change)],
  )
}

test('refuses a non-loopback Registry durable fixture target before spawning a processor', () => {
  assert.throws(
    () => runRegistryPortalFixture({
      databaseUrl: 'postgres://postgres:postgres@example.com:5432/production',
      portalUrl: 'http://127.0.0.1:9999',
      startBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    }),
    /Registry fixture refuses a non-isolated PostgreSQL target/,
  )
})

test('persists Registry state only after a real Portal source succeeds through TypeormDatabase', async () => {
  const fixture = await createIsolatedRegistryFixture()
  const server = await createControlledPortalServer()
  try {
    server.setMode('retry')
    const retry = await runRegistryPortalFixture({
      databaseUrl: fixture.databaseUrl,
      portalUrl: server.url,
      startBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    })
    assert.equal(
      retry.timedOut,
      false,
      `timed out after requests: ${server.requests.map(({ path }) => path).join(', ')}`,
    )
    assert.notEqual(retry.exitCode, 0)
    const retryStreamRequests = server.requests.filter(isTargetStreamRequest)
    assert.equal(retryStreamRequests.length, 1)
    assert.equal(retryStreamRequests[0].query.toBlock, BLOCK_HEIGHT)
    await assertNoDurableProgress(fixture.pool)

    server.setMode('malformed')
    const malformed = await runRegistryPortalFixture({
      databaseUrl: fixture.databaseUrl,
      portalUrl: server.url,
      startBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    })
    assert.equal(malformed.timedOut, false)
    assert.notEqual(malformed.exitCode, 0)
    await assertNoDurableProgress(fixture.pool)

    server.setMode('data')
    const resumed = await runRegistryPortalFixture({
      databaseUrl: fixture.databaseUrl,
      portalUrl: server.url,
      startBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    })
    assert.equal(
      resumed.timedOut,
      false,
      `resume timed out after requests: ${server.requests.map(({ path }) => path).join(', ')}`,
    )
    assert.equal(resumed.exitCode, 0)

    const status = await fixture.pool.query(
      'SELECT height, hash FROM squid_processor.status WHERE id = 0',
    )
    assert.deepEqual(status.rows, [{ height: BLOCK_HEIGHT, hash: BLOCK_HASH }])
    const durableProgress = await fixture.pool.query(
      `SELECT cursor_height, cursor_hash, durable_progress_at_ms::text
         FROM squid_processor.portal_ingestion_progress
        WHERE id = 0`,
    )
    assert.equal(durableProgress.rows.length, 1)
    assert.deepEqual(
      {
        cursor_height: durableProgress.rows[0].cursor_height,
        cursor_hash: durableProgress.rows[0].cursor_hash,
      },
      {
        cursor_height: BLOCK_HEIGHT,
        cursor_hash: BLOCK_HASH,
      },
    )
    assert.match(durableProgress.rows[0].durable_progress_at_ms, /^(0|[1-9][0-9]*)$/)
    const whitelister = await fixture.pool.query(
      'SELECT id, is_currently_whitelisted, last_changed_at_block FROM whitelister',
    )
    assert.deepEqual(whitelister.rows, [{
      id: WHITELISTER,
      is_currently_whitelisted: true,
      last_changed_at_block: BLOCK_HEIGHT,
    }])
    const proposer = await fixture.pool.query(
      'SELECT id, post_count, total_confirmations::text AS total_confirmations FROM proposer',
    )
    assert.deepEqual(proposer.rows, [{
      id: WHITELISTER,
      post_count: 0,
      total_confirmations: '0',
    }])
    const changes = await fixture.pool.query(
      'SELECT added, block_number, tx_hash FROM whitelist_change',
    )
    assert.deepEqual(changes.rows, [{
      added: true,
      block_number: BLOCK_HEIGHT,
      tx_hash: TRANSACTION_HASH,
    }])
  } finally {
    await server.close()
    await fixture.close()
  }
})

test('reconciles legacy hot-block state before final-only Portal resume', async () => {
  const fixture = await createIsolatedRegistryFixture()
  const server = await createControlledPortalServer()
  try {
    await seedLegacyHotState({
      pool: fixture.pool,
      statusHeight: BLOCK_HEIGHT - 2,
      statusHash: BASE_HASH,
      hotHeight: BLOCK_HEIGHT - 1,
      hotHash: PARENT_HASH,
      change: {
        kind: 'insert',
        table: 'whitelister',
        id: HOT_ONLY_WHITELISTER,
      },
    })
    await fixture.pool.query(
      `INSERT INTO whitelister (id, is_currently_whitelisted)
       VALUES ($1, true)`,
      [HOT_ONLY_WHITELISTER],
    )

    const seededStatus = await fixture.pool.query(
      'SELECT height, hash FROM squid_processor.status WHERE id = 0',
    )
    assert.deepEqual(seededStatus.rows, [{
      height: BLOCK_HEIGHT - 2,
      hash: BASE_HASH,
    }])
    const seededHotBlocks = await fixture.pool.query(
      'SELECT height, hash FROM squid_processor.hot_block',
    )
    assert.deepEqual(seededHotBlocks.rows, [{
      height: BLOCK_HEIGHT - 1,
      hash: PARENT_HASH,
    }])

    const resumed = await runRegistryPortalFixture({
      databaseUrl: fixture.databaseUrl,
      portalUrl: server.url,
      startBlock: BLOCK_HEIGHT - 1,
      endBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    })
    assert.equal(resumed.timedOut, false)
    assert.equal(resumed.exitCode, 0, `${resumed.stdout}\n${resumed.stderr}`)

    const status = await fixture.pool.query(
      'SELECT height, hash FROM squid_processor.status WHERE id = 0',
    )
    assert.deepEqual(status.rows, [{ height: BLOCK_HEIGHT, hash: BLOCK_HASH }])
    const hotBlocks = await fixture.pool.query(
      'SELECT height, hash FROM squid_processor.hot_block',
    )
    const rolledBackHotEntity = await fixture.pool.query(
      'SELECT id FROM whitelister WHERE id = $1',
      [HOT_ONLY_WHITELISTER],
    )
    assert.deepEqual(rolledBackHotEntity.rows, [])
    assert.deepEqual(hotBlocks.rows, [])
    const changes = await fixture.pool.query(
      'SELECT added, block_number, tx_hash FROM whitelist_change',
    )
    assert.deepEqual(changes.rows, [{
      added: true,
      block_number: BLOCK_HEIGHT,
      tx_hash: TRANSACTION_HASH,
    }])

    const restarted = await runRegistryPortalFixture({
      databaseUrl: fixture.databaseUrl,
      portalUrl: server.url,
      startBlock: BLOCK_HEIGHT - 1,
      endBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    })
    assert.equal(restarted.timedOut, false)
    assert.equal(restarted.exitCode, 0)
    const changesAfterRestart = await fixture.pool.query(
      'SELECT added, block_number, tx_hash FROM whitelist_change',
    )
    assert.deepEqual(changesAfterRestart.rows, changes.rows)
  } finally {
    await server.close()
    await fixture.close()
  }
})

test('rejects malformed legacy hot changes without mutating durable state', async () => {
  const fixture = await createIsolatedRegistryFixture()
  const server = await createControlledPortalServer()
  try {
    await seedLegacyHotState({
      pool: fixture.pool,
      statusHeight: BLOCK_HEIGHT - 2,
      statusHash: BASE_HASH,
      hotHeight: BLOCK_HEIGHT - 1,
      hotHash: PARENT_HASH,
      change: {
        kind: 'invalid',
        table: 'whitelister',
        id: HOT_ONLY_WHITELISTER,
      },
    })
    await fixture.pool.query(
      `INSERT INTO whitelister (id, is_currently_whitelisted)
       VALUES ($1, true)`,
      [HOT_ONLY_WHITELISTER],
    )

    const rejected = await runRegistryPortalFixture({
      databaseUrl: fixture.databaseUrl,
      portalUrl: server.url,
      startBlock: BLOCK_HEIGHT - 1,
      endBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    })
    assert.equal(rejected.timedOut, false)
    assert.notEqual(rejected.exitCode, 0)

    const state = await fixture.pool.query(
      `SELECT s.height, s.hash, s.nonce, h.height AS hot_height,
              EXISTS (SELECT FROM whitelister WHERE id = $1) AS hot_entity_exists
         FROM squid_processor.status s
         JOIN squid_processor.hot_block h ON true
        WHERE s.id = 0`,
      [HOT_ONLY_WHITELISTER],
    )
    assert.deepEqual(state.rows, [{
      height: BLOCK_HEIGHT - 2,
      hash: BASE_HASH,
      nonce: 1,
      hot_height: BLOCK_HEIGHT - 1,
      hot_entity_exists: true,
    }])
  } finally {
    await server.close()
    await fixture.close()
  }
})

test('rejects hot blocks at or below the durable cursor without rollback', async () => {
  const fixture = await createIsolatedRegistryFixture()
  const server = await createControlledPortalServer()
  try {
    await seedLegacyHotState({
      pool: fixture.pool,
      statusHeight: BLOCK_HEIGHT - 1,
      statusHash: PARENT_HASH,
      hotHeight: BLOCK_HEIGHT - 1,
      hotHash: PARENT_HASH,
      change: {
        kind: 'insert',
        table: 'whitelister',
        id: HOT_ONLY_WHITELISTER,
      },
    })
    await fixture.pool.query(
      `INSERT INTO whitelister (id, is_currently_whitelisted)
       VALUES ($1, true)`,
      [HOT_ONLY_WHITELISTER],
    )

    const rejected = await runRegistryPortalFixture({
      databaseUrl: fixture.databaseUrl,
      portalUrl: server.url,
      startBlock: BLOCK_HEIGHT - 1,
      endBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    })
    assert.equal(rejected.timedOut, false)
    assert.notEqual(rejected.exitCode, 0)

    const state = await fixture.pool.query(
      `SELECT s.height, s.hash, s.nonce, h.height AS hot_height,
              EXISTS (SELECT FROM whitelister WHERE id = $1) AS hot_entity_exists
         FROM squid_processor.status s
         JOIN squid_processor.hot_block h ON true
        WHERE s.id = 0`,
      [HOT_ONLY_WHITELISTER],
    )
    assert.deepEqual(state.rows, [{
      height: BLOCK_HEIGHT - 1,
      hash: PARENT_HASH,
      nonce: 1,
      hot_height: BLOCK_HEIGHT - 1,
      hot_entity_exists: true,
    }])
  } finally {
    await server.close()
    await fixture.close()
  }
})

test('rejects gapped legacy hot-change indexes without rollback', async () => {
  const fixture = await createIsolatedRegistryFixture()
  const server = await createControlledPortalServer()
  try {
    await seedLegacyHotState({
      pool: fixture.pool,
      statusHeight: BLOCK_HEIGHT - 2,
      statusHash: BASE_HASH,
      hotHeight: BLOCK_HEIGHT - 1,
      hotHash: PARENT_HASH,
      hotChangeIndex: 1,
      change: {
        kind: 'insert',
        table: 'whitelister',
        id: HOT_ONLY_WHITELISTER,
      },
    })
    await fixture.pool.query(
      `INSERT INTO whitelister (id, is_currently_whitelisted)
       VALUES ($1, true)`,
      [HOT_ONLY_WHITELISTER],
    )

    const rejected = await runRegistryPortalFixture({
      databaseUrl: fixture.databaseUrl,
      portalUrl: server.url,
      startBlock: BLOCK_HEIGHT - 1,
      endBlock: BLOCK_HEIGHT,
      contractAddress: CONTRACT,
    })
    assert.equal(rejected.timedOut, false)
    assert.notEqual(rejected.exitCode, 0)

    const state = await fixture.pool.query(
      `SELECT s.height, s.hash, s.nonce, h.height AS hot_height,
              EXISTS (SELECT FROM whitelister WHERE id = $1) AS hot_entity_exists
         FROM squid_processor.status s
         JOIN squid_processor.hot_block h ON true
        WHERE s.id = 0`,
      [HOT_ONLY_WHITELISTER],
    )
    assert.deepEqual(state.rows, [{
      height: BLOCK_HEIGHT - 2,
      hash: BASE_HASH,
      nonce: 1,
      hot_height: BLOCK_HEIGHT - 1,
      hot_entity_exists: true,
    }])
  } finally {
    await server.close()
    await fixture.close()
  }
})
