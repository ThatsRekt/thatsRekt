const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const test = require('node:test')

const { augmentBlock } = require('@subsquid/evm-objects')
const { events } = require('../lib/abi/ThatsRekt.js')
const { getChain } = require('../lib/chains.js')
const { createRegistryHandler } = require('../lib/main.js')
const { buildRegistryPortalDataSource } = require('../lib/processor.js')
const {
  createPortalHttpClient,
  PortalRetryDeadlineError,
} = require('../lib/portal.js')
const {
  createObservedPortalDataSource,
  createPortalIngestionEvents,
} = require('../lib/ingestionEvents.js')
const {
  Address,
  Confirmation,
  Post,
  PostAttacker,
  PostVictim,
  Proposer,
  Whitelister,
} = require('../lib/model')

const BASE_START_BLOCK = 48_658_531
const BASE_MOONWELL_BLOCK = 50_517_211
const BASE_RESTART_BLOCK = 50_527_337
const MOONWELL_TX =
  '0xe10e9396924d0f55da387475672c258e0ffe1aee6f7458ebd97ef22268f1422e'

const CONTRACT = '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A'
const CONFIRMER = '0x0000000000000000000000000000000000001004'

const address = (value) => `0x${value.toString(16).padStart(40, '0')}`
const hash = (value) => `0x${value.toString(16).padStart(64, '0')}`
const word = (value) => BigInt(value).toString(16).padStart(64, '0')
const addressWord = (value) => value.slice(2).padStart(64, '0')

const PRODUCTION_REGISTRY_FIXTURES = Object.freeze([
  Object.freeze({
    chain: 'ethereum',
    dataset: 'ethereum-mainnet',
    height: 19_000_000,
    postId: 101,
    title: 'Ethereum frozen Portal fixture',
    note: 'Frozen Ethereum Portal regression fixture',
    transactionHash: hash(0x101),
    poster: address(0x1101),
    attacker: address(0x1201),
    victim: address(0x1301),
    attackedAt: 1_762_214_401,
    expected: Object.freeze({
      entityCounts: Object.freeze({ addresses: 2, attackers: 1, victims: 1, whitelisters: 1 }),
      attackerScore: 0n,
      attackerAppearances: 1,
      victimActivePostCount: 1,
    }),
  }),
  Object.freeze({
    chain: 'base',
    dataset: 'base-mainnet',
    height: BASE_MOONWELL_BLOCK,
    postId: 5,
    title: 'Moonwell: wrsETH oracle malfunction',
    note: 'Frozen Portal regression fixture',
    transactionHash: MOONWELL_TX,
    poster: address(0x1001),
    attacker: address(0x1002),
    victim: address(0x1003),
    attackedAt: 1_762_214_400,
    expected: Object.freeze({
      entityCounts: Object.freeze({ addresses: 2, attackers: 1, victims: 1, whitelisters: 1 }),
      attackerScore: 0n,
      attackerAppearances: 1,
      victimActivePostCount: 1,
    }),
  }),
  Object.freeze({
    chain: 'arbitrum',
    dataset: 'arbitrum-one',
    height: 457_275_000,
    postId: 301,
    title: 'Arbitrum frozen Portal fixture',
    note: 'Frozen Arbitrum Portal regression fixture',
    transactionHash: hash(0x301),
    poster: address(0x3101),
    attacker: address(0x3201),
    victim: address(0x3301),
    attackedAt: 1_762_214_403,
    expected: Object.freeze({
      entityCounts: Object.freeze({ addresses: 2, attackers: 1, victims: 1, whitelisters: 1 }),
      attackerScore: 0n,
      attackerAppearances: 1,
      victimActivePostCount: 1,
    }),
  }),
  Object.freeze({
    chain: 'optimism',
    dataset: 'optimism-mainnet',
    height: 150_896_000,
    postId: 401,
    title: 'Optimism frozen Portal fixture',
    note: 'Frozen Optimism Portal regression fixture',
    transactionHash: hash(0x401),
    poster: address(0x4101),
    attacker: address(0x4201),
    victim: address(0x4301),
    attackedAt: 1_762_214_404,
    expected: Object.freeze({
      entityCounts: Object.freeze({ addresses: 2, attackers: 1, victims: 1, whitelisters: 1 }),
      attackerScore: 0n,
      attackerAppearances: 1,
      victimActivePostCount: 1,
    }),
  }),
  Object.freeze({
    chain: 'bsc',
    dataset: 'binance-mainnet',
    height: 95_195_000,
    postId: 501,
    title: 'BNB Chain frozen Portal fixture',
    note: 'Frozen BNB Chain Portal regression fixture',
    transactionHash: hash(0x501),
    poster: address(0x5101),
    attacker: address(0x5201),
    victim: address(0x5301),
    attackedAt: 1_762_214_405,
    expected: Object.freeze({
      entityCounts: Object.freeze({ addresses: 2, attackers: 1, victims: 1, whitelisters: 1 }),
      attackerScore: 0n,
      attackerAppearances: 1,
      victimActivePostCount: 1,
    }),
  }),
  Object.freeze({
    chain: 'polygon',
    dataset: 'polygon-mainnet',
    height: 86_136_000,
    postId: 601,
    title: 'Polygon frozen Portal fixture',
    note: 'Frozen Polygon Portal regression fixture',
    transactionHash: hash(0x601),
    poster: address(0x6101),
    attacker: address(0x6201),
    victim: address(0x6301),
    attackedAt: 1_762_214_406,
    expected: Object.freeze({
      entityCounts: Object.freeze({ addresses: 2, attackers: 1, victims: 1, whitelisters: 1 }),
      attackerScore: 0n,
      attackerAppearances: 1,
      victimActivePostCount: 1,
    }),
  }),
])

const FROZEN_REGISTRY_HEIGHT_BASELINES = Object.freeze({
  ethereum: 19_000_000,
  base: BASE_MOONWELL_BLOCK,
  arbitrum: 457_275_000,
  optimism: 150_896_000,
  bsc: 95_195_000,
  polygon: 86_136_000,
})

const dynamicString = (value) => {
  const encoded = Buffer.from(value, 'utf8').toString('hex')
  return `${word(Buffer.byteLength(value, 'utf8'))}${encoded.padEnd(Math.ceil(encoded.length / 64) * 64, '0')}`
}

const dynamicAddressArray = (addresses) =>
  `${word(addresses.length)}${addresses.map(addressWord).join('')}`

const postCreatedData = (fixture) => {
  const tails = [
    dynamicString(fixture.title),
    dynamicAddressArray([fixture.attacker]),
    dynamicAddressArray([fixture.victim]),
    dynamicString(fixture.note),
  ]
  let offset = 32 * 5
  const offsets = tails.map((tail) => {
    const current = word(offset)
    offset += tail.length / 2
    return current
  })

  return `0x${[
    word(fixture.attackedAt),
    ...offsets,
    ...tails,
  ].join('')}`
}

const postCreatedLog = (fixture) => ({
  address: CONTRACT,
  topics: [
    events.PostCreated.topic,
    `0x${word(fixture.postId)}`,
    `0x${addressWord(fixture.poster)}`,
  ],
  data: postCreatedData(fixture),
  transactionHash: fixture.transactionHash,
  logIndex: 0,
  block: {
    height: fixture.height,
    timestamp: 1_762_300_000_000 + fixture.postId,
  },
})

const confirmedLog = (fixture) => ({
  address: CONTRACT,
  topics: [
    events.Confirmed.topic,
    `0x${word(fixture.postId)}`,
    `0x${addressWord(CONFIRMER)}`,
  ],
  data: `0x${word(0)}${word(1)}`,
  transactionHash: hash(0xeeee),
  logIndex: 0,
  block: {
    height: BASE_RESTART_BLOCK,
    timestamp: 1_762_400_000_000,
  },
})

const rawPortalBlock = ({ height, logs }) => ({
  header: {
    number: height,
    hash: hash(height),
    parentHash: hash(height - 1),
    timestamp: Math.floor((logs[0]?.block.timestamp ?? 1_762_300_000_000) / 1_000),
  },
  transactions: [],
  logs: logs.map((log) => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    transactionIndex: 0,
  })),
})

class InMemoryRegistryStore {
  #tables = new Map()

  #table(Entity) {
    const table = this.#tables.get(Entity)
    if (table) return table
    const created = new Map()
    this.#tables.set(Entity, created)
    return created
  }

  all(Entity) {
    return [...this.#table(Entity).values()]
  }

  async get(Entity, id) {
    return this.#table(Entity).get(id)
  }

  async findOne(Entity, { where }) {
    const criteria = Array.isArray(where) ? where[0] : where
    return typeof criteria?.id === 'string'
      ? this.#table(Entity).get(criteria.id)
      : undefined
  }

  async find(Entity, { where }) {
    const postId = Array.isArray(where) ? where[0]?.post?.id : where?.post?.id
    return postId === undefined
      ? this.all(Entity)
      : this.all(Entity).filter((entity) => entity.post?.id === postId)
  }

  async upsert(entities) {
    for (const entity of Array.isArray(entities) ? entities : [entities]) {
      this.#table(entity.constructor).set(entity.id, entity)
    }
  }

  async insert(entities) {
    for (const entity of Array.isArray(entities) ? entities : [entities]) {
      const table = this.#table(entity.constructor)
      if (table.has(entity.id)) throw new Error(`Duplicate fixture entity: ${entity.id}`)
      table.set(entity.id, entity)
    }
  }
}

class DurableFixtureCheckpoint {
  #height

  constructor({ startBlock }) {
    this.#height = startBlock - 1
  }

  get height() {
    return this.#height
  }

  async apply({ handler, context, height }) {
    await handler(context)
    assert.ok(height >= this.#height, 'a durable Registry checkpoint must not rewind')
    this.#height = height
  }
}

const fixtureContext = (store, logs) => ({
  log: { warn() {} },
  store,
  blocks: [{ logs }],
})

const sourceContext = (store, blocks) => ({
  log: { warn() {} },
  store,
  blocks: blocks.map(augmentBlock),
})

const createControlledPortalServer = async ({ block }) => {
  let mode = 'data'
  let retryAfterSeconds = '10'
  let currentBlock = block
  const requests = []
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({
      path: url.pathname,
      query: body === '' ? undefined : JSON.parse(body),
    })

    switch (mode) {
      case 'retry':
        response.writeHead(529, { 'retry-after': retryAfterSeconds, 'content-type': 'text/plain' })
        response.end('retry later')
        return
      case 'malformed':
        response.writeHead(200, { 'content-type': 'application/x-ndjson' })
        response.end('{not-json}\n')
        return
      case 'idle':
        response.writeHead(204, {
          'x-sqd-finalized-head-number': String(currentBlock.header.number),
          'x-sqd-finalized-head-hash': currentBlock.header.hash,
        })
        response.end()
        return
      case 'data':
        if (url.pathname.endsWith('/finalized-head')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            number: currentBlock.header.number,
            hash: currentBlock.header.hash,
          }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/x-ndjson' })
        response.end(`${JSON.stringify(currentBlock)}\n`)
        return
      default:
        response.destroy(new Error(`Unknown controlled Portal mode: ${mode}`))
    }
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setMode(nextMode) {
      mode = nextMode
    },
    setRetryAfterSeconds(value) {
      retryAfterSeconds = String(value)
    },
    setBlock(nextBlock) {
      currentBlock = nextBlock
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

const buildFixtureSource = ({
  server,
  fixture,
  deadlineMs,
  retryScheduleMs,
  retryObserver,
}) => {
  const configured = getChain(fixture.chain)
  assert.equal(configured.source.kind, 'portal')
  assert.equal(configured.source.dataset, fixture.dataset)

  return buildRegistryPortalDataSource({
    portal: {
      url: `${server.url}/${fixture.dataset}`,
      headers: {},
      http: createPortalHttpClient({
        headers: {},
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
        ...(retryScheduleMs === undefined ? {} : { retryScheduleMs }),
        ...(retryObserver === undefined ? {} : { retryObserver }),
      }),
    },
    contractAddress: CONTRACT.toLowerCase(),
    startBlock: fixture.height,
  })
}

const takePortalBatch = async ({ source, from, to, allowEmpty = false }) => {
  const iterator = source.getFinalizedStream({ from, to })[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await iterator.next()
      assert.equal(next.done, false)
      if (allowEmpty || next.value.blocks.length > 0) return next.value
    }
  } finally {
    await iterator.return?.()
  }
}

const applyPortalBatch = async ({ source, store, checkpoint, handler, from, to }) => {
  const batch = await takePortalBatch({ source, from, to })
  if (batch.blocks.length === 0) return batch

  await checkpoint.apply({
    handler,
    context: sourceContext(store, batch.blocks),
    height: batch.blocks.at(-1).header.height,
  })
  return batch
}

const assertFixtureResult = async ({ fixture, store }) => {
  const post = await store.get(Post, String(fixture.postId))
  const proposer = await store.get(Proposer, fixture.poster)
  const attacker = await store.get(Address, fixture.attacker)
  const victim = await store.get(Address, fixture.victim)

  assert.ok(post)
  assert.ok(proposer)
  assert.ok(attacker)
  assert.ok(victim)
  assert.equal(post.title, fixture.title)
  assert.equal(post.note, fixture.note)
  assert.equal(post.createdAtBlock, fixture.height)
  assert.equal(post.createdAtTxHash, fixture.transactionHash)
  assert.equal(post.actionCount, 1)
  assert.equal(post.confirmations, 0)
  assert.equal(post.netScore, 0)
  assert.equal(proposer.postCount, 1)
  assert.equal(proposer.totalConfirmations, 0n)
  assert.equal(attacker.attackerScore, fixture.expected.attackerScore)
  assert.equal(attacker.attackerAppearances, fixture.expected.attackerAppearances)
  assert.equal(victim.isVictim, true)
  assert.equal(victim.victimActivePostCount, fixture.expected.victimActivePostCount)
  assert.equal(store.all(Address).length, fixture.expected.entityCounts.addresses)
  assert.equal(store.all(PostAttacker).length, fixture.expected.entityCounts.attackers)
  assert.equal(store.all(PostVictim).length, fixture.expected.entityCounts.victims)
  assert.equal(store.all(Whitelister).length, fixture.expected.entityCounts.whitelisters)
}

test('freezes comparison heights for every Production Chain', () => {
  assert.deepEqual(FROZEN_REGISTRY_HEIGHT_BASELINES, {
    ethereum: 19_000_000,
    base: BASE_MOONWELL_BLOCK,
    arbitrum: 457_275_000,
    optimism: 150_896_000,
    bsc: 95_195_000,
    polygon: 86_136_000,
  })
})

for (const fixture of PRODUCTION_REGISTRY_FIXTURES) {
  test(`maps the frozen ${fixture.chain} Portal fixture through source and handler`, async () => {
    const server = await createControlledPortalServer({
      block: rawPortalBlock({ height: fixture.height, logs: [postCreatedLog(fixture)] }),
    })
    try {
      const store = new InMemoryRegistryStore()
      const checkpoint = new DurableFixtureCheckpoint({ startBlock: fixture.height })
      const source = buildFixtureSource({ server, fixture })
      const handler = createRegistryHandler({ contractAddress: CONTRACT })

      await applyPortalBatch({
        source,
        store,
        checkpoint,
        handler,
        from: fixture.height,
        to: fixture.height,
      })

      assert.equal(checkpoint.height, fixture.height)
      assert.equal(server.requests[0].path, `/${fixture.dataset}/finalized-stream`)
      assert.deepEqual(server.requests[0].query.logs[0].address, [CONTRACT.toLowerCase()])
      assert.ok(server.requests[0].query.logs[0].topic0.includes(events.PostCreated.topic))
      await assertFixtureResult({ fixture, store })
    } finally {
      await server.close()
    }
  })
}

test('maps Moonwell post 5 once and preserves aggregates across the Base restart', async () => {
  const fixture = PRODUCTION_REGISTRY_FIXTURES.find(({ chain }) => chain === 'base')
  assert.ok(fixture)
  const server = await createControlledPortalServer({
    block: rawPortalBlock({ height: fixture.height, logs: [postCreatedLog(fixture)] }),
  })
  try {
    const store = new InMemoryRegistryStore()
    const checkpoint = new DurableFixtureCheckpoint({ startBlock: BASE_START_BLOCK })
    const handler = createRegistryHandler({ contractAddress: CONTRACT })

    await applyPortalBatch({
      source: buildFixtureSource({ server, fixture }),
      store,
      checkpoint,
      handler,
      from: BASE_MOONWELL_BLOCK,
      to: BASE_MOONWELL_BLOCK,
    })

    server.setBlock(rawPortalBlock({
      height: BASE_RESTART_BLOCK,
      logs: [confirmedLog(fixture)],
    }))
    const restartFixture = { ...fixture, height: BASE_RESTART_BLOCK }
    await applyPortalBatch({
      source: buildFixtureSource({ server, fixture: restartFixture }),
      store,
      checkpoint,
      handler,
      from: BASE_RESTART_BLOCK,
      to: BASE_RESTART_BLOCK,
    })

    const post = await store.get(Post, String(fixture.postId))
    const proposer = await store.get(Proposer, fixture.poster)
    assert.equal(checkpoint.height, BASE_RESTART_BLOCK)
    assert.equal(store.all(Post).length, 1)
    assert.equal(store.all(Confirmation).length, 1)
    assert.equal(post.confirmations, 1)
    assert.equal(post.netScore, 1)
    assert.equal(proposer.totalConfirmations, 1n)
    assert.equal((await store.get(Address, fixture.attacker)).attackerScore, 1n)
    assert.equal(store.all(Whitelister).length, 2)
  } finally {
    await server.close()
  }
})

test('keeps a controlled 529 retry deadline visible before Registry state advances, then resumes', async () => {
  const fixture = PRODUCTION_REGISTRY_FIXTURES[0]
  const server = await createControlledPortalServer({
    block: rawPortalBlock({ height: fixture.height, logs: [postCreatedLog(fixture)] }),
  })
  try {
    const store = new InMemoryRegistryStore()
    const checkpoint = new DurableFixtureCheckpoint({ startBlock: fixture.height })
    const handler = createRegistryHandler({ contractAddress: CONTRACT })
    const source = buildFixtureSource({
      server,
      fixture,
      deadlineMs: 9_999,
      retryScheduleMs: [1],
    })

    server.setMode('retry')
    await assert.rejects(
      applyPortalBatch({
        source,
        store,
        checkpoint,
        handler,
        from: fixture.height,
        to: fixture.height,
      }),
      PortalRetryDeadlineError,
    )
    assert.equal(checkpoint.height, fixture.height - 1)
    assert.equal(store.all(Post).length, 0)
    assert.equal(server.requests.length, 1)

    server.setMode('data')
    await applyPortalBatch({
      source,
      store,
      checkpoint,
      handler,
      from: fixture.height,
      to: fixture.height,
    })
    assert.equal(checkpoint.height, fixture.height)
    await assertFixtureResult({ fixture, store })
  } finally {
    await server.close()
  }
})


test('emits a Registry freshness sample after an actual finalized-head response', async () => {
  const fixture = PRODUCTION_REGISTRY_FIXTURES[0]
  const server = await createControlledPortalServer({
    block: rawPortalBlock({ height: fixture.height, logs: [postCreatedLog(fixture)] }),
  })
  try {
    let nowMs = 0
    const ingestionEvents = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: fixture.chain,
      now: () => nowMs,
      writeEvent: (event) => ingestionEvents.push(event),
    })
    const source = createObservedPortalDataSource({
      source: buildFixtureSource({ server, fixture }),
      ingestion,
      isDeadlineError: (error) => error instanceof PortalRetryDeadlineError,
    })
    ingestion.initializeDurableCursor({
      height: fixture.height - 1,
      durableProgressAtMs: 0,
    })
    ingestion.start()
    ingestionEvents.length = 0
    nowMs = 1_000

    const head = await source.getFinalizedHead()
    ingestion.emitFreshnessSample()

    assert.equal(head.number, fixture.height)
    assert.deepEqual(ingestionEvents, [{
      schema: 'thatsrekt.portal.ingestion.v1',
      family: 'registry',
      chain: fixture.chain,
      event: 'freshness_sample',
      cursor_height: fixture.height - 1,
      portal_head_height: fixture.height,
      portal_lag_seconds: 0,
      seconds_since_durable_progress: 1,
      portal_head_advanced: true,
      retry_count: 0,
    }])
  } finally {
    await server.close()
  }
})
test('runs actual Registry finalized-head retries through the configured deadline', async () => {
  const fixture = PRODUCTION_REGISTRY_FIXTURES[0]
  const server = await createControlledPortalServer({
    block: rawPortalBlock({ height: fixture.height, logs: [postCreatedLog(fixture)] }),
  })
  try {
    const retryEvents = []
    const deadlineEvents = []
    const ingestionEvents = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: fixture.chain,
      writeEvent: (event) => ingestionEvents.push(event),
    })
    const source = createObservedPortalDataSource({
      source: buildFixtureSource({
        server,
        fixture,
        deadlineMs: 70,
        retryScheduleMs: [1],
        retryObserver: {
          onRetry(event) {
            retryEvents.push(event)
            ingestion.emitPortalRetry(event)
          },
          onDeadline(event) {
            deadlineEvents.push(event)
            ingestion.emitPortalDeadline()
          },
        },
      }),
      ingestion,
      isDeadlineError: (error) => error instanceof PortalRetryDeadlineError,
    })
    ingestion.initializeDurableCursor({ height: fixture.height - 1 })
    ingestion.start()
    ingestionEvents.length = 0
    const originalDateNow = Date.now
    let retryClock = 0
    Date.now = () => retryClock++ * 10

    server.setRetryAfterSeconds(0)
    server.setMode('retry')
    try {
      await assert.rejects(source.getFinalizedHead(), PortalRetryDeadlineError)
      assert.equal(retryEvents.length, 7)
      assert.deepEqual(deadlineEvents, [{ retryCount: 8 }])
      assert.equal(server.requests.length, 8)
      assert.equal(server.requests[0].path, `/${fixture.dataset}/finalized-head`)
      assert.deepEqual(
        ingestionEvents.map((event) => event.event),
        [
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_deadline',
        ],
      )
      for (const event of ingestionEvents) {
        assert.equal(event.portal_head_height, -1)
        assert.equal(event.portal_lag_seconds, -1)
        assert.equal(event.seconds_since_durable_progress, -1)
      }
    } finally {
      Date.now = originalDateNow
    }
  } finally {
    await server.close()
  }
})

test('keeps malformed Portal data visible before Registry state advances, then resumes', async () => {
  const fixture = PRODUCTION_REGISTRY_FIXTURES[2]
  const server = await createControlledPortalServer({
    block: rawPortalBlock({ height: fixture.height, logs: [postCreatedLog(fixture)] }),
  })
  try {
    const store = new InMemoryRegistryStore()
    const checkpoint = new DurableFixtureCheckpoint({ startBlock: fixture.height })
    const handler = createRegistryHandler({ contractAddress: CONTRACT })
    const ingestionEvents = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: fixture.chain,
      writeEvent: (event) => ingestionEvents.push(event),
    })
    const source = createObservedPortalDataSource({
      source: buildFixtureSource({ server, fixture }),
      ingestion,
      isDeadlineError: (error) => error instanceof PortalRetryDeadlineError,
    })
    ingestion.initializeDurableCursor({ height: fixture.height - 1 })
    ingestion.start()
    ingestionEvents.length = 0
    server.setMode('malformed')
    await assert.rejects(
      applyPortalBatch({
        source,
        store,
        checkpoint,
        handler,
        from: fixture.height,
        to: fixture.height,
      }),
    )
    assert.equal(checkpoint.height, fixture.height - 1)
    assert.equal(store.all(Post).length, 0)

    assert.deepEqual(ingestionEvents.map((event) => event.event), ['fatal'])
    assert.equal(ingestionEvents[0].portal_head_height, -1)
    assert.equal(ingestionEvents[0].portal_lag_seconds, -1)
    server.setMode('data')
    await applyPortalBatch({
      source,
      store,
      checkpoint,
      handler,
      from: fixture.height,
      to: fixture.height,
    })
    assert.equal(checkpoint.height, fixture.height)
    await assertFixtureResult({ fixture, store })
  } finally {
    await server.close()
  }
})

test('leaves the Registry checkpoint untouched for a controlled idle Portal response', async () => {
  const fixture = PRODUCTION_REGISTRY_FIXTURES[4]
  const server = await createControlledPortalServer({
    block: rawPortalBlock({ height: fixture.height, logs: [postCreatedLog(fixture)] }),
  })
  try {
    const store = new InMemoryRegistryStore()
    const checkpoint = new DurableFixtureCheckpoint({ startBlock: fixture.height })
    const source = buildFixtureSource({ server, fixture })

    server.setMode('idle')
    const batch = await takePortalBatch({
      source,
      from: fixture.height,
      to: fixture.height,
      allowEmpty: true,
    })
    assert.deepEqual(batch.blocks, [])
    assert.equal(checkpoint.height, fixture.height - 1)
    assert.equal(store.all(Post).length, 0)
  } finally {
    await server.close()
  }
})
