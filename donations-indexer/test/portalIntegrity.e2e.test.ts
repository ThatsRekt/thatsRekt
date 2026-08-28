import { describe, expect, test } from 'bun:test'
import type { FinalDatabase } from '@subsquid/batch-processor'
import type { PoolClient } from 'pg'
import { chainConfigFor } from '../src/chainConfig.ts'
import { createDonationDatabase } from '../src/cursor.ts'
import { ensureDonationTable } from '../src/donationStore.ts'
import {
  createPortalHttpClient,
  DonationsPortalRetryDeadlineError,
  type PortalConfig,
  type PortalRetryObserver,
} from '../src/portal.ts'
import {
  createObservedPortalDataSource,
  createPortalIngestionEvents,
  type PortalIngestionEvent,
} from '../src/ingestionEvents.ts'
import {
  buildDonationPortalPlan,
  indexDonationBlocks,
  type DonationBlock,
  type DonationPortalPlan,
} from '../src/processor.ts'
import { TRANSFER_TOPIC0 } from '../src/tokenAllowlist.ts'
import {
  createIsolatedPortalTestPool,
  type IsolatedPortalTestPool,
} from './support/isolatedPostgres.ts'

const DONEE = '0x59e4dbc95bd312a882bb36b7f3e8298682340679'
const BASE_RESTART_BLOCK = 50_527_337

interface ExpectedDonationRow {
  readonly tokenSymbol: string
  readonly amountNorm: string
  readonly chainId: number
  readonly blockNumber: number
}

interface ProductionDonationFixture {
  readonly slug: string
  readonly chainId: number
  readonly dataset: string
  readonly height: number
  readonly native: {
    readonly symbol: string
    readonly amountRaw: bigint
    readonly amountNorm: string
  }
  readonly erc20: {
    readonly address: string
    readonly symbol: string
    readonly decimals: number
    readonly amountRaw: bigint
    readonly amountNorm: string
  }
  readonly expectedRows: readonly ExpectedDonationRow[]
}

const FROZEN_PORTAL_HEIGHT_BASELINES = Object.freeze({
  ethereum: 19_000_000,
  base: 50_517_211,
  arbitrum: 457_275_000,
  optimism: 150_896_000,
  bsc: 95_195_000,
  polygon: 86_136_000,
})

const PRODUCTION_DONATION_FIXTURES: readonly ProductionDonationFixture[] = Object.freeze([
  Object.freeze({
    slug: 'ethereum',
    chainId: 1,
    dataset: 'ethereum-mainnet',
    height: 19_000_000,
    native: Object.freeze({ symbol: 'ETH', amountRaw: 1_000_000_000_000_000_000n, amountNorm: '1' }),
    erc20: Object.freeze({
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      symbol: 'USDC',
      decimals: 6,
      amountRaw: 50_000_000n,
      amountNorm: '50',
    }),
    expectedRows: Object.freeze([
      Object.freeze({ tokenSymbol: 'ETH', amountNorm: '1', chainId: 1, blockNumber: 19_000_000 }),
      Object.freeze({ tokenSymbol: 'USDC', amountNorm: '50', chainId: 1, blockNumber: 19_000_000 }),
    ]),
  }),
  Object.freeze({
    slug: 'base',
    chainId: 8453,
    dataset: 'base-mainnet',
    height: 50_517_211,
    native: Object.freeze({ symbol: 'ETH', amountRaw: 1_000_000_000_000_000_000n, amountNorm: '1' }),
    erc20: Object.freeze({
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      symbol: 'USDC',
      decimals: 6,
      amountRaw: 50_000_000n,
      amountNorm: '50',
    }),
    expectedRows: Object.freeze([
      Object.freeze({ tokenSymbol: 'ETH', amountNorm: '1', chainId: 8453, blockNumber: 50_517_211 }),
      Object.freeze({ tokenSymbol: 'USDC', amountNorm: '50', chainId: 8453, blockNumber: 50_517_211 }),
    ]),
  }),
  Object.freeze({
    slug: 'arbitrum',
    chainId: 42161,
    dataset: 'arbitrum-one',
    height: 457_275_000,
    native: Object.freeze({ symbol: 'ETH', amountRaw: 1_000_000_000_000_000_000n, amountNorm: '1' }),
    erc20: Object.freeze({
      address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      symbol: 'USDC',
      decimals: 6,
      amountRaw: 50_000_000n,
      amountNorm: '50',
    }),
    expectedRows: Object.freeze([
      Object.freeze({ tokenSymbol: 'ETH', amountNorm: '1', chainId: 42161, blockNumber: 457_275_000 }),
      Object.freeze({ tokenSymbol: 'USDC', amountNorm: '50', chainId: 42161, blockNumber: 457_275_000 }),
    ]),
  }),
  Object.freeze({
    slug: 'optimism',
    chainId: 10,
    dataset: 'optimism-mainnet',
    height: 150_896_000,
    native: Object.freeze({ symbol: 'ETH', amountRaw: 1_000_000_000_000_000_000n, amountNorm: '1' }),
    erc20: Object.freeze({
      address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      symbol: 'USDC',
      decimals: 6,
      amountRaw: 50_000_000n,
      amountNorm: '50',
    }),
    expectedRows: Object.freeze([
      Object.freeze({ tokenSymbol: 'ETH', amountNorm: '1', chainId: 10, blockNumber: 150_896_000 }),
      Object.freeze({ tokenSymbol: 'USDC', amountNorm: '50', chainId: 10, blockNumber: 150_896_000 }),
    ]),
  }),
  Object.freeze({
    slug: 'bsc',
    chainId: 56,
    dataset: 'binance-mainnet',
    height: 95_195_000,
    native: Object.freeze({ symbol: 'BNB', amountRaw: 1_000_000_000_000_000_000n, amountNorm: '1' }),
    erc20: Object.freeze({
      address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      symbol: 'USDC',
      decimals: 18,
      amountRaw: 50_000_000_000_000_000_000n,
      amountNorm: '50',
    }),
    expectedRows: Object.freeze([
      Object.freeze({ tokenSymbol: 'BNB', amountNorm: '1', chainId: 56, blockNumber: 95_195_000 }),
      Object.freeze({ tokenSymbol: 'USDC', amountNorm: '50', chainId: 56, blockNumber: 95_195_000 }),
    ]),
  }),
  Object.freeze({
    slug: 'polygon',
    chainId: 137,
    dataset: 'polygon-mainnet',
    height: 86_136_000,
    native: Object.freeze({ symbol: 'POL', amountRaw: 1_000_000_000_000_000_000n, amountNorm: '1' }),
    erc20: Object.freeze({
      address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      symbol: 'USDC',
      decimals: 6,
      amountRaw: 50_000_000n,
      amountNorm: '50',
    }),
    expectedRows: Object.freeze([
      Object.freeze({ tokenSymbol: 'POL', amountNorm: '1', chainId: 137, blockNumber: 86_136_000 }),
      Object.freeze({ tokenSymbol: 'USDC', amountNorm: '50', chainId: 137, blockNumber: 86_136_000 }),
    ]),
  }),
])

interface PortalRawBlock {
  readonly header: {
    readonly number: number
    readonly hash: string
    readonly parentHash: string
    readonly timestamp: number
  }
  readonly transactions: readonly {
    readonly transactionIndex: number
    readonly to: string
    readonly from: string
    readonly hash: string
    readonly value: string
  }[]
  readonly logs: readonly {
    readonly transactionIndex: number
    readonly address: string
    readonly topics: readonly string[]
    readonly data: string
    readonly transactionHash: string
    readonly logIndex: number
  }[]
}

type PortalMode = 'data' | 'retry' | 'malformed' | 'idle'

interface ControlledPortalServer {
  readonly url: string
  readonly requests: readonly {
    readonly path: string
    readonly query: unknown
  }[]
  setMode(mode: PortalMode): void
  setRetryAfterSeconds(seconds: number): void
  setBlock(dataset: string, block: PortalRawBlock): void
  close(): void
}

interface SourcedDonationBlock extends DonationBlock {
  readonly header: DonationBlock['header'] & { readonly hash: string }
}

interface IsolatedDonationDatabase {
  readonly fixture: IsolatedPortalTestPool
  readonly pool: IsolatedPortalTestPool['pool']
  readonly database: FinalDatabase<PoolClient>
}

const topicFor = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`
const hashFor = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`
const amountHex = (value: bigint): string => `0x${value.toString(16)}`
const donorFor = (chainId: number): string => `0x${(chainId + 50_000).toString(16).padStart(40, '0')}`

const portalBlockFor = ({
  fixture,
  height = fixture.height,
  includeTransfers = true,
}: {
  readonly fixture: ProductionDonationFixture
  readonly height?: number
  readonly includeTransfers?: boolean
}): PortalRawBlock => {
  const donor = donorFor(fixture.chainId)
  return {
    header: {
      number: height,
      hash: hashFor(height),
      parentHash: hashFor(height - 1),
      timestamp: 1_735_689_600,
    },
    transactions: includeTransfers
      ? [
          {
            transactionIndex: 0,
            to: DONEE,
            from: donor,
            hash: hashFor(fixture.chainId + 10_000),
            value: amountHex(fixture.native.amountRaw),
          },
        ]
      : [],
    logs: includeTransfers
      ? [
          {
            transactionIndex: 0,
            address: fixture.erc20.address,
            topics: [TRANSFER_TOPIC0, topicFor(donor), topicFor(DONEE)],
            data: amountHex(fixture.erc20.amountRaw),
            transactionHash: hashFor(fixture.chainId + 20_000),
            logIndex: 3,
          },
        ]
      : [],
  }
}

const createControlledPortalServer = (
  fixtures: readonly ProductionDonationFixture[],
): ControlledPortalServer => {
  let mode: PortalMode = 'data'
  let retryAfterSeconds = 10
  const blocks = new Map<string, PortalRawBlock>()
  const requests: {
    path: string
    query: unknown
  }[] = []
  for (const fixture of fixtures) {
    blocks.set(fixture.dataset, portalBlockFor({ fixture }))
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.text()
      const url = new URL(request.url)
      const dataset = url.pathname.split('/').at(-2)
      const block = dataset === undefined ? undefined : blocks.get(dataset)
      const query: unknown = body === '' ? undefined : JSON.parse(body)
      requests.push({ path: url.pathname, query })

      if (block === undefined) {
        return new Response('unknown fixture dataset', { status: 404 })
      }
      if (mode === 'retry') {
        return new Response('retry later', {
          status: 529,
          headers: { 'Retry-After': String(retryAfterSeconds) },
        })
      }
      if (mode === 'malformed') {
        return new Response('{not-json}\n', {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      }
      if (mode === 'idle') {
        return new Response(null, {
          status: 204,
          headers: {
            'x-sqd-finalized-head-number': String(block.header.number),
            'x-sqd-finalized-head-hash': block.header.hash,
          },
        })
      }
      if (url.pathname.endsWith('/finalized-head')) {
        return Response.json({
          number: block.header.number,
          hash: block.header.hash,
        })
      }
      return new Response(`${JSON.stringify(block)}\n`, {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      })
    },
  })

  return Object.freeze({
    url: `http://127.0.0.1:${server.port}`,
    requests,
    setMode(nextMode: PortalMode): void {
      mode = nextMode
    },
    setRetryAfterSeconds(seconds: number): void {
      retryAfterSeconds = seconds
    },
    setBlock(dataset: string, block: PortalRawBlock): void {
      blocks.set(dataset, block)
    },
    close(): void {
      server.stop(true)
    },
  })
}

const createIsolatedDonationDatabase = async ({
  chainId,
}: {
  readonly chainId: number
}): Promise<IsolatedDonationDatabase> => {
  const fixture = await createIsolatedPortalTestPool()
  try {
    const pool = fixture.pool
    await ensureDonationTable(pool)
    const database = createDonationDatabase({ pool, chainId })
    await database.connect()
    return Object.freeze({ fixture, pool, database })
  } catch (error) {
    await fixture.close()
    throw error
  }
}

const portalPlanFor = ({
  fixture,
  server,
  deadlineMs,
  retryScheduleMs,
  retryObserver,
  startBlock = fixture.height,
  toBlock = fixture.height,
}: {
  readonly fixture: ProductionDonationFixture
  readonly server: ControlledPortalServer
  readonly deadlineMs?: number
  readonly retryScheduleMs?: readonly number[]
  readonly retryObserver?: PortalRetryObserver
  readonly startBlock?: number
  readonly toBlock?: number
}): DonationPortalPlan => {
  const chain = chainConfigFor(fixture.slug)
  expect(chain?.portalDataset).toBe(fixture.dataset)
  const portal: PortalConfig = {
    url: `${server.url}/${fixture.dataset}`,
    headers: {},
    http: createPortalHttpClient({
      headers: {},
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(retryScheduleMs === undefined ? {} : { retryScheduleMs }),
      ...(retryObserver === undefined ? {} : { retryObserver }),
    }),
    bindRetryObserver() {},
  }

  return buildDonationPortalPlan({
    portal,
    startBlock,
    toBlock,
    donee: DONEE,
    doneeTopic: topicFor(DONEE),
    erc20TokenAddresses: [fixture.erc20.address],
  })
}

const readPortalBlocks = async ({
  plan,
  allowEmpty = false,
}: {
  readonly plan: DonationPortalPlan
  readonly allowEmpty?: boolean
}): Promise<readonly SourcedDonationBlock[]> => {
  const iterator = plan.source.getFinalizedStream({
    from: plan.range.from,
    to: plan.range.to,
  })[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) throw new Error('Controlled Portal source ended before yielding a batch')
      if (allowEmpty || next.value.blocks.length > 0) return next.value.blocks
    }
  } finally {
    await iterator.return?.()
  }
}

const runPortalFixture = async ({
  fixture,
  plan,
  database,
}: {
  readonly fixture: ProductionDonationFixture
  readonly plan: DonationPortalPlan
  readonly database: FinalDatabase<PoolClient>
}): Promise<void> => {
  const blocks = await readPortalBlocks({ plan })
  const lastBlock = blocks.at(-1)
  if (lastBlock === undefined) throw new Error('Controlled Portal fixture returned no blocks')

  await database.transact(
    {
      prevHead: { height: plan.range.from - 1, hash: hashFor(plan.range.from - 1) },
      nextHead: { height: lastBlock.header.height, hash: lastBlock.header.hash },
      isOnTop: true,
    },
    async (store) =>
      indexDonationBlocks({
        blocks,
        store,
        chainId: fixture.chainId,
        chainSlug: fixture.slug,
        donee: DONEE,
      }),
  )
}

const readCursor = async ({
  pool,
  chainId,
}: {
  readonly pool: IsolatedPortalTestPool['pool']
  readonly chainId: number
}): Promise<{ height: number; hash: string }> => {
  const { rows } = await pool.query<{ height: number; hash: string }>(
    `SELECT height, hash FROM donations_indexer_status_v2 WHERE chain_id = $1`,
    [chainId],
  )
  return rows[0]!
}

const readRows = async ({
  pool,
  chainId,
}: {
  readonly pool: IsolatedPortalTestPool['pool']
  readonly chainId: number
}): Promise<readonly ExpectedDonationRow[]> => {
  const { rows } = await pool.query<{
    token_symbol: string
    amount_norm: string
    chain_id: number
    block_number: number
  }>(`
    SELECT token_symbol, amount_norm::text AS amount_norm, chain_id, block_number
    FROM donation
    WHERE chain_id = $1
    ORDER BY token_symbol
  `, [chainId])
  return rows.map((row) => ({
    tokenSymbol: row.token_symbol,
    amountNorm: row.amount_norm,
    chainId: row.chain_id,
    blockNumber: row.block_number,
  }))
}

const assertNoDurableProgress = async ({
  pool,
  fixture,
}: {
  readonly pool: IsolatedPortalTestPool['pool']
  readonly fixture: ProductionDonationFixture
}): Promise<void> => {
  expect(await readCursor({ pool, chainId: fixture.chainId })).toEqual({ height: -1, hash: '' })
  expect(await readRows({ pool, chainId: fixture.chainId })).toEqual([])
}

describe('deterministic Donations Portal integrity harness', () => {
  test('freezes one baseline height for every Production Chain', () => {
    expect(FROZEN_PORTAL_HEIGHT_BASELINES).toEqual({
      ethereum: 19_000_000,
      base: 50_517_211,
      arbitrum: 457_275_000,
      optimism: 150_896_000,
      bsc: 95_195_000,
      polygon: 86_136_000,
    })
  })

  for (const fixture of PRODUCTION_DONATION_FIXTURES) {
    test(`maps frozen ${fixture.slug} native and ERC20 Portal output exactly`, async () => {
      const server = createControlledPortalServer([fixture])
      const isolated = await createIsolatedDonationDatabase({ chainId: fixture.chainId })
      try {
        const plan = portalPlanFor({ fixture, server })
        await runPortalFixture({ fixture, plan, database: isolated.database })

        expect(server.requests[0]?.path).toBe(`/${fixture.dataset}/finalized-stream`)
        expect(server.requests[0]?.query).toEqual(expect.objectContaining({
          type: 'evm',
          fromBlock: fixture.height,
          toBlock: fixture.height,
        }))
        expect(JSON.stringify(server.requests[0]?.query)).toContain(fixture.erc20.address)
        expect(JSON.stringify(server.requests[0]?.query)).toContain(DONEE)
        expect(await readRows({ pool: isolated.pool, chainId: fixture.chainId })).toEqual(
          fixture.expectedRows,
        )
        expect(await readCursor({ pool: isolated.pool, chainId: fixture.chainId })).toEqual({
          height: fixture.height,
          hash: hashFor(fixture.height),
        })
      } finally {
        server.close()
        await isolated.fixture.close()
      }
    })
  }

  test('maps captured Base native and ERC20 donations exactly once across restart', async () => {
    const fixture = PRODUCTION_DONATION_FIXTURES.find(({ slug }) => slug === 'base')
    if (fixture === undefined) throw new Error('Base frozen fixture is required')

    const server = createControlledPortalServer([fixture])
    const isolated = await createIsolatedDonationDatabase({ chainId: fixture.chainId })
    try {
      await runPortalFixture({
        fixture,
        plan: portalPlanFor({ fixture, server }),
        database: isolated.database,
      })

      server.setBlock(
        fixture.dataset,
        portalBlockFor({ fixture, height: BASE_RESTART_BLOCK, includeTransfers: false }),
      )
      await runPortalFixture({
        fixture,
        plan: portalPlanFor({
          fixture,
          server,
          startBlock: BASE_RESTART_BLOCK,
          toBlock: BASE_RESTART_BLOCK,
        }),
        database: isolated.database,
      })

      server.setBlock(fixture.dataset, portalBlockFor({ fixture }))
      await runPortalFixture({
        fixture,
        plan: portalPlanFor({ fixture, server }),
        database: isolated.database,
      })

      expect(await readRows({ pool: isolated.pool, chainId: fixture.chainId })).toEqual(
        fixture.expectedRows,
      )
      expect(await readCursor({ pool: isolated.pool, chainId: fixture.chainId })).toEqual({
        height: BASE_RESTART_BLOCK,
        hash: hashFor(BASE_RESTART_BLOCK),
      })
    } finally {
      server.close()
      await isolated.fixture.close()
    }
  })

  test('keeps a controlled 529 Retry-After deadline visible before Donations state advances, then resumes', async () => {
    const fixture = PRODUCTION_DONATION_FIXTURES[0]!
    const server = createControlledPortalServer([fixture])
    const isolated = await createIsolatedDonationDatabase({ chainId: fixture.chainId })
    try {
      const plan = portalPlanFor({
        fixture,
        server,
        deadlineMs: 9_999,
        retryScheduleMs: [1],
      })
      server.setMode('retry')
      await expect(runPortalFixture({ fixture, plan, database: isolated.database })).rejects.toThrow(
        'Portal retry deadline exceeded after 20 minutes',
      )
      await assertNoDurableProgress({ pool: isolated.pool, fixture })
      expect(server.requests).toHaveLength(1)

      server.setMode('data')
      await runPortalFixture({ fixture, plan, database: isolated.database })
      expect(await readRows({ pool: isolated.pool, chainId: fixture.chainId })).toEqual(
        fixture.expectedRows,
      )
    } finally {
      server.close()
      await isolated.fixture.close()
    }
  })


  test('emits a Donations freshness sample after an actual finalized-head response', async () => {
    const fixture = PRODUCTION_DONATION_FIXTURES[0]!
    const server = createControlledPortalServer([fixture])
    try {
      let nowMs = 0
      const ingestionEvents: PortalIngestionEvent[] = []
      const ingestion = createPortalIngestionEvents({
        family: 'donations',
        chain: fixture.slug,
        now: () => nowMs,
        writeEvent: (event) => ingestionEvents.push(event),
      })
      const plan = portalPlanFor({ fixture, server })
      const source = createObservedPortalDataSource({
        source: plan.source,
        ingestion,
        isDeadlineError: (error) => error instanceof DonationsPortalRetryDeadlineError,
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

      expect(head.number).toBe(fixture.height)
      expect(ingestionEvents).toEqual([{
        schema: 'thatsrekt.portal.ingestion.v1',
        family: 'donations',
        chain: fixture.slug,
        event: 'freshness_sample',
        cursor_height: fixture.height - 1,
        portal_head_height: fixture.height,
        portal_lag_seconds: 0,
        seconds_since_durable_progress: 1,
        portal_head_advanced: true,
        retry_count: 0,
      }])
    } finally {
      server.close()
    }
  })
  test('runs actual Donations finalized-head retries through the configured deadline', async () => {
    const fixture = PRODUCTION_DONATION_FIXTURES[0]!
    const server = createControlledPortalServer([fixture])
    try {
      const retryEvents: { readonly retryAfterSeconds: number; readonly retryCount: number }[] = []
      const deadlineEvents: { readonly retryCount: number }[] = []
      const ingestionEvents: PortalIngestionEvent[] = []
      const ingestion = createPortalIngestionEvents({
        family: 'donations',
        chain: fixture.slug,
        writeEvent: (event) => ingestionEvents.push(event),
      })
      const plan = portalPlanFor({
        fixture,
        server,
        deadlineMs: 70,
        retryScheduleMs: [1],
        retryObserver: {
          onRetry(event): void {
            retryEvents.push(event)
            ingestion.emitPortalRetry(event)
          },
          onDeadline(event): void {
            deadlineEvents.push(event)
            ingestion.emitPortalDeadline()
          },
        },
      })
      const source = createObservedPortalDataSource({
        source: plan.source,
        ingestion,
        isDeadlineError: (error) => error instanceof DonationsPortalRetryDeadlineError,
      })
      ingestion.initializeDurableCursor({ height: fixture.height - 1 })
      ingestion.start()
      ingestionEvents.length = 0
      const originalDateNow = Date.now
      let retryClock = 0
      Date.now = (): number => retryClock++ * 10

      server.setRetryAfterSeconds(0)
      server.setMode('retry')
      try {
        await expect(source.getFinalizedHead()).rejects.toThrow(
          DonationsPortalRetryDeadlineError,
        )
        expect(retryEvents).toHaveLength(7)
        expect(deadlineEvents).toEqual([{ retryCount: 8 }])
        expect(server.requests).toHaveLength(8)
        expect(server.requests[0]?.path).toBe(`/${fixture.dataset}/finalized-head`)
        expect(ingestionEvents.map((event) => event.event)).toEqual([
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_retry',
          'portal_deadline',
        ])
        for (const event of ingestionEvents) {
          expect(event.portal_head_height).toBe(-1)
          expect(event.portal_lag_seconds).toBe(-1)
          expect(event.seconds_since_durable_progress).toBe(-1)
        }
      } finally {
        Date.now = originalDateNow
      }
    } finally {
      server.close()
    }
  })

  test('keeps malformed Portal data visible before Donations state advances, then resumes', async () => {
    const fixture = PRODUCTION_DONATION_FIXTURES[2]!
    const server = createControlledPortalServer([fixture])
    const isolated = await createIsolatedDonationDatabase({ chainId: fixture.chainId })
    try {
      const plan = portalPlanFor({ fixture, server })
      const ingestionEvents: PortalIngestionEvent[] = []
      const ingestion = createPortalIngestionEvents({
        family: 'donations',
        chain: fixture.slug,
        writeEvent: (event) => ingestionEvents.push(event),
      })
      const observedPlan: DonationPortalPlan = {
        ...plan,
        source: createObservedPortalDataSource({
          source: plan.source,
          ingestion,
          isDeadlineError: (error) => error instanceof DonationsPortalRetryDeadlineError,
        }),
      }
      ingestion.initializeDurableCursor({ height: fixture.height - 1 })
      ingestion.start()
      ingestionEvents.length = 0
      server.setMode('malformed')
      await expect(
        runPortalFixture({ fixture, plan: observedPlan, database: isolated.database }),
      ).rejects.toThrow()
      await assertNoDurableProgress({ pool: isolated.pool, fixture })
      expect(ingestionEvents.map((event) => event.event)).toEqual(['fatal'])
      expect(ingestionEvents[0]?.portal_head_height).toBe(-1)
      expect(ingestionEvents[0]?.portal_lag_seconds).toBe(-1)

      server.setMode('data')
      await runPortalFixture({ fixture, plan: observedPlan, database: isolated.database })
      expect(await readRows({ pool: isolated.pool, chainId: fixture.chainId })).toEqual(
        fixture.expectedRows,
      )
    } finally {
      server.close()
      await isolated.fixture.close()
    }
  })

  test('leaves Donations state untouched for a controlled idle Portal response', async () => {
    const fixture = PRODUCTION_DONATION_FIXTURES[4]!
    const server = createControlledPortalServer([fixture])
    const isolated = await createIsolatedDonationDatabase({ chainId: fixture.chainId })
    try {
      const plan = portalPlanFor({ fixture, server })
      server.setMode('idle')
      expect(await readPortalBlocks({ plan, allowEmpty: true })).toEqual([])
      await assertNoDurableProgress({ pool: isolated.pool, fixture })
    } finally {
      server.close()
      await isolated.fixture.close()
    }
  })
})
