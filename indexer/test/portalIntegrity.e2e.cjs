const assert = require('node:assert/strict')
const test = require('node:test')

const { events } = require('../lib/abi/ThatsRekt.js')
const { createRegistryHandler } = require('../lib/main.js')
const {
  REGISTRY_PORTAL_RETRY_DEADLINE_MS,
  assertRetryWithinDeadline,
  retryDelayMs,
} = require('../lib/portal.js')
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

const FROZEN_REGISTRY_HEIGHT_BASELINES = Object.freeze({
  ethereum: 19_000_000,
  base: BASE_RESTART_BLOCK,
  arbitrum: 457_275_000,
  optimism: 150_896_000,
  bsc: 95_195_000,
  polygon: 86_136_000,
})

const CONTRACT = '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A'
const POSTER = '0x0000000000000000000000000000000000001001'
const ATTACKER = '0x0000000000000000000000000000000000001002'
const VICTIM = '0x0000000000000000000000000000000000001003'
const CONFIRMER = '0x0000000000000000000000000000000000001004'

const word = (value) => BigInt(value).toString(16).padStart(64, '0')
const addressWord = (address) => address.slice(2).padStart(64, '0')

const dynamicString = (value) => {
  const encoded = Buffer.from(value, 'utf8').toString('hex')
  return `${word(Buffer.byteLength(value, 'utf8'))}${encoded.padEnd(Math.ceil(encoded.length / 64) * 64, '0')}`
}

const dynamicAddressArray = (addresses) =>
  `${word(addresses.length)}${addresses.map(addressWord).join('')}`

const postCreatedData = () => {
  const tails = [
    dynamicString('Moonwell: wrsETH oracle malfunction'),
    dynamicAddressArray([ATTACKER]),
    dynamicAddressArray([VICTIM]),
    dynamicString('Frozen Portal regression fixture'),
  ]
  let offset = 32 * 5
  const offsets = tails.map((tail) => {
    const current = word(offset)
    offset += tail.length / 2
    return current
  })

  return `0x${[
    word(1_762_214_400),
    ...offsets,
    ...tails,
  ].join('')}`
}

const postCreatedLog = () => ({
  address: CONTRACT,
  topics: [
    events.PostCreated.topic,
    `0x${word(5)}`,
    `0x${addressWord(POSTER)}`,
  ],
  data: postCreatedData(),
  transactionHash: MOONWELL_TX,
  logIndex: 0,
  block: {
    height: BASE_MOONWELL_BLOCK,
    timestamp: 1_762_300_000_000,
  },
})

const confirmedLog = () => ({
  address: CONTRACT,
  topics: [
    events.Confirmed.topic,
    `0x${word(5)}`,
    `0x${addressWord(CONFIRMER)}`,
  ],
  data: `0x${word(0)}${word(1)}`,
  transactionHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  logIndex: 0,
  block: {
    height: BASE_RESTART_BLOCK,
    timestamp: 1_762_400_000_000,
  },
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

test('freezes comparison heights for every Production Chain', () => {
  assert.deepEqual(
    Object.keys(FROZEN_REGISTRY_HEIGHT_BASELINES).sort(),
    ['arbitrum', 'base', 'bsc', 'ethereum', 'optimism', 'polygon'],
  )
  assert.equal(FROZEN_REGISTRY_HEIGHT_BASELINES.base, BASE_RESTART_BLOCK)
})
test('keeps the Registry checkpoint unchanged when a 529 retry reaches its deadline', () => {
  const checkpoint = new DurableFixtureCheckpoint({ startBlock: BASE_START_BLOCK })
  const retryAfterMs = retryDelayMs('10')

  assert.equal(retryAfterMs, 10_000)
  assert.throws(() =>
    assertRetryWithinDeadline({
      startedAtMs: 0,
      nowMs: REGISTRY_PORTAL_RETRY_DEADLINE_MS - 5_000,
      retryAfterMs,
      deadlineMs: REGISTRY_PORTAL_RETRY_DEADLINE_MS,
    }),
  )
  assert.equal(checkpoint.height, BASE_START_BLOCK - 1)
})


test('keeps malformed Portal data visible before durable state advances', async () => {
  const store = new InMemoryRegistryStore()
  const checkpoint = new DurableFixtureCheckpoint({ startBlock: BASE_START_BLOCK })
  const handler = createRegistryHandler({ contractAddress: CONTRACT })
  const malformedLog = {
    ...postCreatedLog(),
    topics: [events.PostCreated.topic],
    data: '0x',
  }

  await assert.rejects(
    checkpoint.apply({
      handler,
      context: fixtureContext(store, [malformedLog]),
      height: BASE_MOONWELL_BLOCK,
    }),
  )

  assert.equal(checkpoint.height, BASE_START_BLOCK - 1)
  assert.equal(store.all(Post).length, 0)
  assert.equal(store.all(Proposer).length, 0)
})

test('maps Moonwell post 5 once and preserves aggregates across the Base restart', async () => {
  const store = new InMemoryRegistryStore()
  const checkpoint = new DurableFixtureCheckpoint({ startBlock: BASE_START_BLOCK })
  const handler = createRegistryHandler({ contractAddress: CONTRACT })

  await checkpoint.apply({
    handler,
    context: fixtureContext(store, [postCreatedLog()]),
    height: BASE_MOONWELL_BLOCK,
  })

  const post = await store.get(Post, '5')
  const proposer = await store.get(Proposer, POSTER)
  assert.equal(post.title, 'Moonwell: wrsETH oracle malfunction')
  assert.equal(post.createdAtBlock, BASE_MOONWELL_BLOCK)
  assert.equal(post.createdAtTxHash, MOONWELL_TX)
  assert.equal(post.actionCount, 1)
  assert.equal(proposer.postCount, 1)
  assert.equal(store.all(Address).length, 2)
  assert.equal(store.all(PostAttacker).length, 1)
  assert.equal(store.all(PostVictim).length, 1)

  await checkpoint.apply({
    handler,
    context: fixtureContext(store, [confirmedLog()]),
    height: BASE_RESTART_BLOCK,
  })

  assert.equal(checkpoint.height, BASE_RESTART_BLOCK)
  assert.equal(store.all(Post).length, 1)
  assert.equal(store.all(Confirmation).length, 1)
  assert.equal(post.confirmations, 1)
  assert.equal(post.netScore, 1)
  assert.equal(proposer.totalConfirmations, 1n)
  assert.equal((await store.get(Address, ATTACKER)).attackerScore, 1n)
  assert.equal(store.all(Whitelister).length, 2)
})
