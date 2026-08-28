import { describe, expect, test } from 'bun:test'
import {
  PORTAL_INGESTION_SCHEMA,
  createObservedFinalDatabase,
  createObservedPortalDataSource,
  createPortalFreshnessSampler,
  createPortalIngestionEvents,
  type PortalIngestionEvent,
} from '../src/ingestionEvents'

describe('Registry Portal ingestion event contract', () => {
  test('uses the stable, closed schema with numeric freshness metrics', async () => {
    let nowMs = 1_000
    const events: PortalIngestionEvent[] = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: 'base',
      now: () => nowMs,
      writeEvent: (event) => events.push(event),
    })
    const source = createObservedPortalDataSource({
      source: {
        async getHead() {
          return { number: 105, hash: '0xhead' }
        },
        async getFinalizedHead() {
          return { number: 101, hash: '0xfinalized' }
        },
        async *getFinalizedStream() {},
        async *getStream() {},
      },
      ingestion,
      isDeadlineError: () => false,
    })

    ingestion.initializeDurableCursor({ height: 99, durableProgressAtMs: 1_000 })
    ingestion.start()
    await source.getFinalizedHead()
    nowMs = 7_500
    ingestion.emitPortalRetry({ retryAfterSeconds: 10, retryCount: 1 })

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      schema: PORTAL_INGESTION_SCHEMA,
      family: 'registry',
      chain: 'base',
      event: 'restart',
      cursor_height: 99,
      portal_head_height: -1,
      portal_lag_seconds: -1,
      seconds_since_durable_progress: 0,
      portal_head_advanced: false,
      retry_count: 0,
    })
    expect(events[1]).toEqual({
      schema: PORTAL_INGESTION_SCHEMA,
      family: 'registry',
      chain: 'base',
      event: 'portal_retry',
      cursor_height: 99,
      portal_head_height: 101,
      portal_lag_seconds: 6,
      seconds_since_durable_progress: 6,
      portal_head_advanced: true,
      retry_count: 1,
      retry_after_seconds: 10,
    })
    for (const event of events) {
      expect(typeof event.portal_head_height).toBe('number')
      expect(typeof event.portal_lag_seconds).toBe('number')
      expect(typeof event.seconds_since_durable_progress).toBe('number')
      expect(typeof event.retry_count).toBe('number')
    }
  })

  test('emits durable progress only after the transaction resolves', async () => {
    const events: PortalIngestionEvent[] = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: 'base',
      now: () => 10_000,
      writeEvent: (event) => events.push(event),
    })
    const order: string[] = []
    const database = {
      supportsHotBlocks: false as const,
      async connect() {
        return { height: 4, hash: '0x04' }
      },
      async transact(
        _info: {
          readonly prevHead: { readonly height: number; readonly hash: string }
          readonly nextHead: { readonly height: number; readonly hash: string }
          readonly isOnTop: boolean
        },
        callback: (store: undefined) => Promise<void>,
      ) {
        await callback(undefined)
        order.push('durable-commit')
      },
    }
    const observed = createObservedFinalDatabase({
      database,
      ingestion,
      afterCommit: ({ nextHead }) => {
        order.push('event-emission')
        ingestion.recordDurableCursor({ height: nextHead.height })
        ingestion.emitCursorAdvanced()
        ingestion.emitCursorClassification({ classification: 'advanced' })
        ingestion.emitFreshnessSample()
      },
    })

    await observed.connect()
    ingestion.observePortalHead({ height: 10 })
    await observed.transact(
      {
        prevHead: { height: 4, hash: '0x04' },
        nextHead: { height: 5, hash: '0x05' },
        isOnTop: false,
      },
      async () => {
        order.push('mapping')
      },
    )

    expect(order).toEqual(['mapping', 'durable-commit', 'event-emission'])
    expect(events.map((event) => event.event)).toEqual([
      'restart',
      'cursor_advanced',
      'cursor_classification',
      'freshness_sample',
    ])
    expect(events.slice(1).every((event) => event.cursor_height === 5)).toBe(true)
  })


  test('emits a terminal failure before the first successful Portal head', async () => {
    let nowMs = 10_000
    const events: PortalIngestionEvent[] = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: 'base',
      now: () => nowMs,
      writeEvent: (event) => events.push(event),
    })
    const source = createObservedPortalDataSource({
      source: {
        async getHead() {
          throw new Error('controlled Portal failure')
        },
        async getFinalizedHead() {
          throw new Error('controlled Portal failure')
        },
        async *getFinalizedStream() {},
        async *getStream() {},
      },
      ingestion,
      isDeadlineError: () => false,
    })

    ingestion.initializeDurableCursor({ height: 12 })
    ingestion.start()
    events.length = 0
    nowMs = 11_000

    await expect(source.getFinalizedHead()).rejects.toThrow('controlled Portal failure')

    expect(events).toEqual([{
      schema: PORTAL_INGESTION_SCHEMA,
      family: 'registry',
      chain: 'base',
      event: 'fatal',
      cursor_height: 12,
      portal_head_height: -1,
      portal_lag_seconds: -1,
      seconds_since_durable_progress: -1,
      portal_head_advanced: false,
      retry_count: 0,
    }])
  })

  test('uses durable progress persisted before restart and preserves a stalled head age', () => {
    let nowMs = 10_000
    const events: PortalIngestionEvent[] = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: 'base',
      now: () => nowMs,
      writeEvent: (event) => events.push(event),
    })

    ingestion.initializeDurableCursor({
      height: 40,
      durableProgressAtMs: 1_000,
    })
    ingestion.start()
    events.length = 0
    nowMs = 20_000
    ingestion.observePortalHead({ height: 50 })
    nowMs = 100_000
    ingestion.observePortalHead({ height: 50 })
    nowMs = 1_901_000
    ingestion.emitFreshnessSample()

    expect(events).toEqual([{
      schema: PORTAL_INGESTION_SCHEMA,
      family: 'registry',
      chain: 'base',
      event: 'freshness_sample',
      cursor_height: 40,
      portal_head_height: 50,
      portal_lag_seconds: 1_881,
      seconds_since_durable_progress: 1_900,
      portal_head_advanced: true,
      retry_count: 0,
    }])
  })


  test('loads persisted Registry durable progress after database connection', async () => {
    const events: PortalIngestionEvent[] = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: 'base',
      now: () => 1_901_000,
      writeEvent: (event) => events.push(event),
    })
    const observed = createObservedFinalDatabase({
      database: {
        supportsHotBlocks: false,
        async connect() {
          return { height: 40, hash: '0x40' }
        },
        async transact() {},
      },
      ingestion,
      readDurableProgressAtMs: () => 1_000,
      afterCommit: () => undefined,
    })

    await observed.connect()
    events.length = 0
    ingestion.observePortalHead({ height: 50 })
    ingestion.emitFreshnessSample()

    expect(events).toEqual([{
      schema: PORTAL_INGESTION_SCHEMA,
      family: 'registry',
      chain: 'base',
      event: 'freshness_sample',
      cursor_height: 40,
      portal_head_height: 50,
      portal_lag_seconds: 0,
      seconds_since_durable_progress: 1_900,
      portal_head_advanced: true,
      retry_count: 0,
    }])
  })
  test('emits a freshness sample only after an observed Portal head succeeds', async () => {
    let nowMs = 0
    let shouldFail = false
    const events: PortalIngestionEvent[] = []
    const ingestion = createPortalIngestionEvents({
      family: 'registry',
      chain: 'base',
      now: () => nowMs,
      writeEvent: (event) => events.push(event),
    })
    const source = createObservedPortalDataSource({
      source: {
        async getHead() {
          return { number: 10, hash: '0x10' }
        },
        async getFinalizedHead() {
          if (shouldFail) throw new Error('controlled Portal failure')
          return { number: 10, hash: '0x10' }
        },
        async *getFinalizedStream() {},
        async *getStream() {},
      },
      ingestion,
      isDeadlineError: () => false,
    })
    const sampler = createPortalFreshnessSampler({
      source,
      ingestion,
      intervalMs: 1_000,
    })

    ingestion.initializeDurableCursor({ height: 5, durableProgressAtMs: 0 })
    ingestion.start()
    events.length = 0
    nowMs = 1_000

    await expect(sampler.sample()).resolves.toBe(true)
    expect(events).toEqual([{
      schema: PORTAL_INGESTION_SCHEMA,
      family: 'registry',
      chain: 'base',
      event: 'freshness_sample',
      cursor_height: 5,
      portal_head_height: 10,
      portal_lag_seconds: 0,
      seconds_since_durable_progress: 1,
      portal_head_advanced: true,
      retry_count: 0,
    }])

    events.length = 0
    shouldFail = true
    await expect(sampler.sample()).resolves.toBe(false)
    expect(events.map((event) => event.event)).toEqual(['fatal'])
  })
  test('classifies retry, deadline, and fatal without serializing secret-like values', () => {
    const privatePortalUrl = 'https://private.portal.example.test/base?key=portal-secret'
    const apiKey = 'portal-api-key'
    const makeIngestion = (): {
      readonly ingestion: ReturnType<typeof createPortalIngestionEvents>
      readonly events: PortalIngestionEvent[]
    } => {
      const events: PortalIngestionEvent[] = []
      const ingestion = createPortalIngestionEvents({
        family: 'registry',
        chain: 'base',
        now: () => 20_000,
        writeEvent: (event) => events.push(event),
      })
      ingestion.initializeDurableCursor({ height: 12 })
      ingestion.start()
      ingestion.observePortalHead({ height: 14 })
      events.length = 0
      return { ingestion, events }
    }
    const retry = makeIngestion()
    const deadline = makeIngestion()
    const fatal = makeIngestion()

    retry.ingestion.emitPortalRetry({ retryAfterSeconds: 10, retryCount: 2 })
    deadline.ingestion.emitPortalDeadline()
    fatal.ingestion.emitFatal()
    const emitted = [
      retry.events[0],
      deadline.events[0],
      fatal.events[0],
    ].filter((event): event is PortalIngestionEvent => event !== undefined)

    expect(emitted.map((event) => event.event)).toEqual([
      'portal_retry',
      'portal_deadline',
      'fatal',
    ])
    expect(JSON.stringify(emitted)).not.toContain(privatePortalUrl)
    expect(JSON.stringify(emitted)).not.toContain(apiKey)
    expect(Object.keys(emitted[0] ?? {})).toEqual([
      'schema',
      'family',
      'chain',
      'event',
      'cursor_height',
      'portal_head_height',
      'portal_lag_seconds',
      'seconds_since_durable_progress',
      'portal_head_advanced',
      'retry_count',
      'retry_after_seconds',
    ])
  })
})
