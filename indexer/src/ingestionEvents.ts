import type {
  DatabaseTransactResult,
  FinalDatabase,
  FinalDatabaseState,
  FinalTxInfo,
} from '@subsquid/batch-processor'

export const PORTAL_INGESTION_SCHEMA = 'thatsrekt.portal.ingestion.v1' as const

type PortalFamily = 'registry' | 'donations'
type PortalEventName =
  | 'freshness_sample'
  | 'cursor_advanced'
  | 'cursor_classification'
  | 'portal_retry'
  | 'portal_deadline'
  | 'fatal'
  | 'startup'
  | 'restart'
  | 'run_outcome'
type CursorClassification = 'advanced' | 'idempotent' | 'stale'
type RunOutcome = 'success' | 'failed' | 'idle'

export interface PortalIngestionEvent {
  readonly schema: typeof PORTAL_INGESTION_SCHEMA
  readonly family: PortalFamily
  readonly chain: string
  readonly event: PortalEventName
  readonly cursor_height: number
  readonly portal_head_height: number
  readonly portal_lag_seconds: number
  readonly seconds_since_durable_progress: number
  readonly portal_head_advanced: boolean
  readonly retry_count: number
  readonly retry_after_seconds?: number
  readonly outcome?: RunOutcome
  readonly classification?: CursorClassification
}

interface IngestionEvents {
  initializeDurableCursor(input: {
    readonly height: number
    readonly durableProgressAtMs?: number
  }): void
  start(): void
  observePortalHead(input: { readonly height: number }): void
  recordDurableCursor(input: {
    readonly height: number
    readonly durableProgressAtMs?: number
  }): void
  emitCursorAdvanced(): boolean
  emitCursorClassification(input: { readonly classification: CursorClassification }): boolean
  emitFreshnessSample(): boolean
  emitPortalRetry(input: {
    readonly retryAfterSeconds: number
    readonly retryCount: number
  }): boolean
  emitPortalDeadline(): boolean
  emitFatal(): boolean
  emitRunOutcome(input: { readonly outcome: RunOutcome }): boolean
}

interface ObservableFinalDatabase<Store> {
  readonly supportsHotBlocks?: boolean
  connect(): Promise<FinalDatabaseState>
  transact(
    info: FinalTxInfo,
    callback: (store: Store) => Promise<DatabaseTransactResult | void>,
  ): Promise<void>
}

interface PortalRef {
  readonly number: number
  readonly hash: string
}

interface PortalSource<Block> {
  getHead(): Promise<PortalRef>
  getFinalizedHead(): Promise<PortalRef>
  getFinalizedStream(input: {
    readonly from: number
    readonly to?: number
    readonly parentHash?: string
  }): AsyncIterable<{ readonly blocks: Block[]; readonly finalizedHead?: PortalRef }>
  getStream(input: {
    readonly from: number
    readonly to?: number
    readonly parentHash?: string
  }): AsyncIterable<{ readonly blocks: Block[]; readonly finalizedHead?: PortalRef }>
  getBlocksCountInRange?: (range: { readonly from: number; readonly to: number }) => number
}

const assertInteger = ({
  value,
  name,
  minimum,
}: {
  readonly value: number
  readonly name: string
  readonly minimum: number
}): void => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer at or above ${minimum}`)
  }
}

const elapsedSeconds = (nowMs: number, observedAtMs: number): number =>
  Math.floor(Math.max(0, nowMs - observedAtMs) / 1_000)

export const createPortalIngestionEvents = ({
  family,
  chain,
  now = Date.now,
  writeEvent,
}: {
  readonly family: PortalFamily
  readonly chain: string
  readonly now?: () => number
  readonly writeEvent: (event: PortalIngestionEvent) => void
}): IngestionEvents => {
  if (chain.trim() === '') throw new Error('Portal ingestion chain must not be blank')

  const timestamp = (): number => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Portal ingestion clock must be a non-negative safe integer')
    }
    return value
  }
  const durableProgressAt = (value: number | undefined): number | undefined => {
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Portal durable progress time must be a non-negative safe integer')
    }
    return value
  }
  let cursorHeight = -1
  let durableProgressAtMs: number | undefined
  let portalHead: { readonly height: number; readonly advancedAtMs: number } | undefined
  let pendingLifecycle: 'startup' | 'restart' | undefined
  let lifecycleStarted = false
  let retryCount = 0
  let terminalFailureEmitted = false

  const emit = ({
    event,
    retryAfterSeconds,
    outcome,
    classification,
  }: {
    readonly event: PortalEventName
    readonly retryAfterSeconds?: number
    readonly outcome?: RunOutcome
    readonly classification?: CursorClassification
  }): boolean => {
    const nowMs = timestamp()
    writeEvent(Object.freeze({
      schema: PORTAL_INGESTION_SCHEMA,
      family,
      chain,
      event,
      cursor_height: cursorHeight,
      portal_head_height: portalHead?.height ?? -1,
      // Portal does not provide timestamps. This is the age of the most recent
      // observed advance, so repeated polls of a stalled head do not hide lag.
      portal_lag_seconds: portalHead === undefined
        ? -1
        : elapsedSeconds(nowMs, portalHead.advancedAtMs),
      // A missing durable timestamp is represented explicitly rather than
      // restarted from process boot, which would mask a pre-existing stall.
      seconds_since_durable_progress: durableProgressAtMs === undefined
        ? -1
        : elapsedSeconds(nowMs, durableProgressAtMs),
      // The head is considered advanced while it remains ahead of the durable
      // cursor, allowing periodic samples to sustain the no-progress signal.
      portal_head_advanced: portalHead !== undefined && portalHead.height > cursorHeight,
      retry_count: retryCount,
      ...(retryAfterSeconds === undefined
        ? {}
        : { retry_after_seconds: retryAfterSeconds }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(classification === undefined ? {} : { classification }),
    } satisfies PortalIngestionEvent))
    return true
  }
  const flushLifecycle = (): void => {
    if (pendingLifecycle !== undefined && emit({ event: pendingLifecycle })) {
      pendingLifecycle = undefined
    }
  }
  const emitTerminalFailure = (event: 'portal_deadline' | 'fatal'): boolean => {
    if (terminalFailureEmitted) return false
    const emitted = emit({ event })
    if (emitted) terminalFailureEmitted = true
    return emitted
  }

  const events: IngestionEvents = {
    initializeDurableCursor({ height, durableProgressAtMs: storedProgressAtMs }): void {
      assertInteger({ value: height, name: 'Portal durable cursor height', minimum: -1 })
      cursorHeight = height
      durableProgressAtMs = durableProgressAt(storedProgressAtMs)
    },
    start(): void {
      if (lifecycleStarted) return
      lifecycleStarted = true
      pendingLifecycle = cursorHeight < 0 ? 'startup' : 'restart'
      flushLifecycle()
    },
    observePortalHead({ height }): void {
      assertInteger({ value: height, name: 'Portal head height', minimum: 0 })
      const observedAtMs = timestamp()
      portalHead = {
        height,
        advancedAtMs:
          portalHead === undefined || height > portalHead.height
            ? observedAtMs
            : portalHead.advancedAtMs,
      }
      terminalFailureEmitted = false
      flushLifecycle()
    },
    recordDurableCursor({ height, durableProgressAtMs: committedProgressAtMs }): void {
      assertInteger({ value: height, name: 'Portal durable cursor height', minimum: 0 })
      if (height <= cursorHeight) {
        throw new Error('Portal durable cursor must advance before recording progress')
      }
      cursorHeight = height
      durableProgressAtMs = durableProgressAt(committedProgressAtMs) ?? timestamp()
      retryCount = 0
      terminalFailureEmitted = false
    },
    emitCursorAdvanced: (): boolean => emit({ event: 'cursor_advanced' }),
    emitCursorClassification: ({ classification }): boolean =>
      emit({ event: 'cursor_classification', classification }),
    emitFreshnessSample: (): boolean => emit({ event: 'freshness_sample' }),
    emitPortalRetry: ({ retryAfterSeconds, retryCount: nextRetryCount }): boolean => {
      if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
        throw new Error('Portal retry delay seconds must be a non-negative finite number')
      }
      assertInteger({ value: nextRetryCount, name: 'Portal retry count', minimum: 1 })
      retryCount = nextRetryCount
      return emit({ event: 'portal_retry', retryAfterSeconds })
    },
    emitPortalDeadline: (): boolean => emitTerminalFailure('portal_deadline'),
    emitFatal: (): boolean => emitTerminalFailure('fatal'),
    emitRunOutcome: ({ outcome }): boolean => emit({ event: 'run_outcome', outcome }),
  }
  return Object.freeze(events)
}

export const createObservedFinalDatabase = <Store>({
  database,
  ingestion,
  readDurableProgressAtMs,
  afterConnect,
  afterCommit,
}: {
  readonly database: ObservableFinalDatabase<Store>
  readonly ingestion: IngestionEvents
  readonly readDurableProgressAtMs?: (input: {
    readonly state: FinalDatabaseState
  }) => number | undefined | Promise<number | undefined>
  readonly afterConnect?: (
    input: { readonly state: FinalDatabaseState },
  ) => void | Promise<void>
  readonly afterCommit: (
    input: { readonly nextHead: FinalTxInfo['nextHead'] },
  ) => void | Promise<void>
}): FinalDatabase<Store> => {
  if (database.supportsHotBlocks) {
    throw new Error('Portal ingestion requires a final-only database')
  }
  return {
    supportsHotBlocks: false,
    async connect(): Promise<FinalDatabaseState> {
      try {
        const state = await database.connect()
        const durableProgressAtMs = await readDurableProgressAtMs?.({ state })
        ingestion.initializeDurableCursor({
          height: state.height,
          durableProgressAtMs,
        })
        ingestion.start()
        await afterConnect?.({ state })
        return state
      } catch (error) {
        ingestion.emitFatal()
        throw error
      }
    },
    async transact(
      info: FinalTxInfo,
      callback: (store: Store) => Promise<DatabaseTransactResult | void>,
    ): Promise<void> {
      try {
        await database.transact(info, callback)
        await afterCommit({ nextHead: info.nextHead })
      } catch (error) {
        ingestion.emitFatal()
        throw error
      }
    },
  }
}

export const createObservedPortalDataSource = <Block>({
  source,
  ingestion,
  isDeadlineError,
}: {
  readonly source: PortalSource<Block>
  readonly ingestion: IngestionEvents
  readonly isDeadlineError: (error: unknown) => boolean
}): PortalSource<Block> => {
  const reportFailure = (error: unknown): void => {
    if (isDeadlineError(error)) ingestion.emitPortalDeadline()
    else ingestion.emitFatal()
  }
  const observeHead = (head: PortalRef): PortalRef => {
    ingestion.observePortalHead({ height: head.number })
    return head
  }
  const observeStream = async function* (
    stream: AsyncIterable<{ readonly blocks: Block[]; readonly finalizedHead?: PortalRef }>,
  ): AsyncIterable<{ readonly blocks: Block[]; readonly finalizedHead?: PortalRef }> {
    try {
      for await (const batch of stream) {
        if (batch.finalizedHead !== undefined) observeHead(batch.finalizedHead)
        yield batch
      }
    } catch (error) {
      reportFailure(error)
      throw error
    }
  }

  return {
    async getHead(): Promise<PortalRef> {
      try {
        return observeHead(await source.getHead())
      } catch (error) {
        reportFailure(error)
        throw error
      }
    },
    async getFinalizedHead(): Promise<PortalRef> {
      try {
        return observeHead(await source.getFinalizedHead())
      } catch (error) {
        reportFailure(error)
        throw error
      }
    },
    getFinalizedStream: (input) => observeStream(source.getFinalizedStream(input)),
    getStream: (input) => observeStream(source.getStream(input)),
    getBlocksCountInRange: source.getBlocksCountInRange?.bind(source),
  }
}

export const PORTAL_FRESHNESS_SAMPLE_INTERVAL_MS = 5 * 60_000

export interface PortalFreshnessSampler {
  sample(): Promise<boolean>
  start(): void
  stop(): void
}

export const createPortalFreshnessSampler = <Block>({
  source,
  ingestion,
  intervalMs = PORTAL_FRESHNESS_SAMPLE_INTERVAL_MS,
}: {
  readonly source: PortalSource<Block>
  readonly ingestion: IngestionEvents
  readonly intervalMs?: number
}): PortalFreshnessSampler => {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('Portal freshness sample interval must be a positive safe integer')
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let sampling = false
  const sample = async (): Promise<boolean> => {
    if (sampling) return false
    sampling = true
    try {
      await source.getFinalizedHead()
      return ingestion.emitFreshnessSample()
    } catch {
      // The observed source emits a secret-safe deadline or fatal event itself.
      // A failed probe must not emit a misleading freshness sample.
      return false
    } finally {
      sampling = false
    }
  }

  return Object.freeze({
    sample,
    start(): void {
      if (timer !== undefined) return
      void sample()
      timer = setInterval(() => {
        void sample()
      }, intervalMs)
      timer.unref()
    },
    stop(): void {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  })
}
