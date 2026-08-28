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
const CONTRACT = '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A'
const WHITELISTER = '0x000000000000000000000000000000000000c0de'
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
    if (streamFromBlock !== BLOCK_HEIGHT) {
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
      response.end(`${JSON.stringify(controlledRegistryBlock)}\n`)
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
