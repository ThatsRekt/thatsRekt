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
  initializeDurableCursor(input: { readonly height: number }): void
  start(): void
  observePortalHead(input: { readonly height: number }): void
  recordDurableCursor(input: { readonly height: number }): void
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
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Portal ingestion clock must be a non-negative finite number')
    }
    return value
  }
  let cursorHeight = -1
  let durableProgressObservedAtMs = timestamp()
  let portalHead: { readonly height: number; readonly observedAtMs: number } | undefined
  let portalHeadAdvanced = false
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
    if (portalHead === undefined) return false
    const nowMs = timestamp()
    writeEvent(Object.freeze({
      schema: PORTAL_INGESTION_SCHEMA,
      family,
      chain,
      event,
      cursor_height: cursorHeight,
      portal_head_height: portalHead.height,
      // Portal supplies a height/hash but no head timestamp. This is the measured
      // age of the latest successful Portal-head observation.
      portal_lag_seconds: elapsedSeconds(nowMs, portalHead.observedAtMs),
      // A restored cursor has no stored commit time. Its timer begins at the
      // current process's durable-state observation and resets after each commit.
      seconds_since_durable_progress: elapsedSeconds(nowMs, durableProgressObservedAtMs),
      portal_head_advanced: portalHeadAdvanced,
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
    initializeDurableCursor({ height }): void {
      assertInteger({ value: height, name: 'Portal durable cursor height', minimum: -1 })
      cursorHeight = height
      durableProgressObservedAtMs = timestamp()
    },
    start(): void {
      if (lifecycleStarted) return
      lifecycleStarted = true
      pendingLifecycle = cursorHeight < 0 ? 'startup' : 'restart'
      flushLifecycle()
    },
    observePortalHead({ height }): void {
      assertInteger({ value: height, name: 'Portal head height', minimum: 0 })
      const previousHeight = portalHead?.height
      portalHead = { height, observedAtMs: timestamp() }
      portalHeadAdvanced = previousHeight !== undefined && height > previousHeight
      terminalFailureEmitted = false
      flushLifecycle()
    },
    recordDurableCursor({ height }): void {
      assertInteger({ value: height, name: 'Portal durable cursor height', minimum: 0 })
      cursorHeight = height
      durableProgressObservedAtMs = timestamp()
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
  afterCommit,
}: {
  readonly database: ObservableFinalDatabase<Store>
  readonly ingestion: IngestionEvents
  readonly afterCommit: (input: { readonly nextHead: FinalTxInfo['nextHead'] }) => void
}): FinalDatabase<Store> => {
  if (database.supportsHotBlocks) {
    throw new Error('Portal ingestion requires a final-only database')
  }
  return {
    supportsHotBlocks: false,
    async connect(): Promise<FinalDatabaseState> {
      try {
        const state = await database.connect()
        ingestion.initializeDurableCursor({ height: state.height })
        ingestion.start()
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
      } catch (error) {
        ingestion.emitFatal()
        throw error
      }
      afterCommit({ nextHead: info.nextHead })
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
