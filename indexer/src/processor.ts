import 'dotenv/config'
import { createOrmConfig } from '@subsquid/typeorm-config'
import { Processor as BatchProcessor } from '@subsquid/batch-processor'
import { augmentBlock } from '@subsquid/evm-objects'
import {
  DataSourceBuilder,
  type EVMDataSource,
  type FieldSelection,
} from '@subsquid/evm-stream'
import { createLogger, type Logger } from '@subsquid/logger'
import { EvmBatchProcessor } from '@subsquid/evm-processor'
import { type Store, type TypeormDatabase } from '@subsquid/typeorm-store'
import { rollbackBlock } from '@subsquid/typeorm-store/lib/hot'
import { DataSource } from 'typeorm'
import { events } from './abi/ThatsRekt'
import type { ChainConfig } from './chains'
import {
  buildPortalConfig,
  PortalRetryDeadlineError,
  type PortalConfig,
} from './portal'
import {
  createObservedFinalDatabase,
  createObservedPortalDataSource,
  createPortalFreshnessSampler,
  createPortalIngestionEvents,
} from './ingestionEvents'
import { readRegistryPortalDurableProgressAtMs } from './portalProgress'

const requireEnv = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

const SUBSCRIBED_TOPICS = [
  events.PostCreated.topic,
  events.PostRemoved.topic,
  events.PostPurged.topic,
  events.PostNoteAmended.topic,
  events.PostTitleAmended.topic,
  events.AttackersAdded.topic,
  events.VictimsAdded.topic,
  events.Confirmed.topic,
  events.WhitelistUpdated.topic,
  events.Upgraded.topic,
  events.OwnershipTransferred.topic,
] as const

const LOG_FIELDS = {
  block: {
    timestamp: true,
  },
  log: {
    address: true,
    topics: true,
    data: true,
    transactionHash: true,
  },
} as const satisfies FieldSelection

type ConfiguredRpcProcessor = EvmBatchProcessor<typeof LOG_FIELDS>

export type Log = {
  readonly address: string
  readonly topics: string[]
  readonly data: string
  readonly transactionHash: string
  readonly logIndex: number
  readonly block: {
    readonly height: number
    readonly timestamp: number
  }
}

type ProcessorBlock = {
  readonly logs: readonly Log[]
}

export interface ProcessorContext {
  readonly log: Logger
  readonly store: Store
  readonly blocks: readonly ProcessorBlock[]
}

type ProcessorHandler = (context: ProcessorContext) => Promise<void>

export interface BuiltRpcProcessor {
  readonly kind: 'rpc'
  readonly chain: ChainConfig
  readonly contractAddress: string
  readonly processor: ConfiguredRpcProcessor
}

export interface BuiltPortalProcessor {
  readonly kind: 'portal'
  readonly chain: ChainConfig
  readonly contractAddress: string
  readonly dataSource: EVMDataSource<typeof LOG_FIELDS>
  // Test fixtures can provide a directly built source. Production sources always
  // retain this binding so retry events use the same authenticated transport.
  readonly portal?: PortalConfig
}

export type BuiltProcessor = BuiltRpcProcessor | BuiltPortalProcessor

const parseStartBlock = (chain: ChainConfig): number => {
  const value = requireEnv(chain.startBlockEnvVar)
  const startBlock = Number.parseInt(value, 10)
  if (!Number.isInteger(startBlock) || startBlock < 0) {
    throw new Error(
      `Invalid ${chain.startBlockEnvVar}: expected non-negative integer`,
    )
  }
  return startBlock
}

const buildRpcProcessor = ({
  chain,
  contractAddress,
  startBlock,
}: {
  readonly chain: ChainConfig
  readonly contractAddress: string
  readonly startBlock: number
}): BuiltRpcProcessor => {
  if (chain.source.kind !== 'rpc') {
    throw new Error('Portal chain cannot be built as RPC-only')
  }

  const processor = new EvmBatchProcessor()
    .setRpcEndpoint({
      url: requireEnv(chain.source.rpcEnvVar),
      rateLimit: chain.source.rpcRateLimit,
    })
    .setFinalityConfirmation(chain.finalityConfirmation)
    .setFields(LOG_FIELDS)
    .setBlockRange({ from: startBlock })
    .addLog({
      address: [contractAddress],
      topic0: [...SUBSCRIBED_TOPICS],
      transaction: false,
    })

  return {
    kind: 'rpc',
    chain,
    contractAddress,
    processor,
  }
}

export const buildRegistryPortalDataSource = ({
  portal,
  contractAddress,
  startBlock,
  endBlock,
}: {
  readonly portal: PortalConfig
  readonly contractAddress: string
  readonly startBlock: number
  readonly endBlock?: number
}): EVMDataSource<typeof LOG_FIELDS> => {
  if (!Number.isInteger(startBlock) || startBlock < 0) {
    throw new Error('Portal block range must start at a non-negative integer')
  }
  if (
    endBlock !== undefined &&
    (!Number.isInteger(endBlock) || endBlock < startBlock)
  ) {
    throw new Error('Portal block range end must be an integer at or after the start')
  }

  const range = endBlock === undefined
    ? { from: startBlock }
    : { from: startBlock, to: endBlock }

  return new DataSourceBuilder()
    .setPortal({
      url: portal.url,
      http: portal.http,
    })
    .setFields(LOG_FIELDS)
    .setBlockRange(range)
    .includeAllBlocks(range)
    .addLog({
      where: {
        address: [contractAddress],
        topic0: [...SUBSCRIBED_TOPICS],
      },
    })
    .build()
}

const buildPortalProcessor = ({
  chain,
  contractAddress,
  startBlock,
}: {
  readonly chain: ChainConfig
  readonly contractAddress: string
  readonly startBlock: number
}): BuiltPortalProcessor => {
  if (chain.source.kind !== 'portal') {
    throw new Error('RPC-only chain cannot be built as a Portal source')
  }

  const portal = buildPortalConfig({
    source: chain.source,
    environment: process.env,
  })
  const dataSource = buildRegistryPortalDataSource({
    portal,
    contractAddress,
    startBlock,
  })

  return {
    kind: 'portal',
    chain,
    contractAddress,
    dataSource,
    portal,
  }
}

export const buildProcessor = (chain: ChainConfig): BuiltProcessor => {
  const contractAddress = requireEnv(chain.contractEnvVar).toLowerCase()
  const startBlock = parseStartBlock(chain)

  return chain.source.kind === 'portal'
    ? buildPortalProcessor({ chain, contractAddress, startBlock })
    : buildRpcProcessor({ chain, contractAddress, startBlock })
}

const asLogObject = (error: unknown): object =>
  typeof error === 'object' && error !== null ? error : { error }

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertValidLegacyHotChange = (change: unknown): void => {
  if (!isObjectRecord(change)) {
    throw new Error('Registry hot-change record is not an object')
  }
  if (
    change.kind !== 'insert' &&
    change.kind !== 'update' &&
    change.kind !== 'delete'
  ) {
    throw new Error('Registry hot-change kind is invalid')
  }
  if (typeof change.table !== 'string' || change.table.length === 0) {
    throw new Error('Registry hot-change table is invalid')
  }
  if (typeof change.id !== 'string' || change.id.length === 0) {
    throw new Error('Registry hot-change entity id is invalid')
  }
  if (
    'schema' in change &&
    (typeof change.schema !== 'string' || change.schema.length === 0)
  ) {
    throw new Error('Registry hot-change schema is invalid')
  }
  if (
    (change.kind === 'update' || change.kind === 'delete') &&
    !isObjectRecord(change.fields)
  ) {
    throw new Error('Registry hot-change fields are invalid')
  }
}

const reconcileLegacyHotBlocks = async (): Promise<number> => {
  const dataSource = new DataSource(createOrmConfig())
  try {
    await dataSource.initialize()
    return await dataSource.transaction('SERIALIZABLE', async (manager) => {
      const relations = await manager.query<Array<{ relation: string | null }>>(
        `SELECT to_regclass('squid_processor.hot_block')::text AS relation`,
      )
      if (relations.length !== 1) {
        throw new Error('Registry hot-block catalog query returned an invalid result')
      }
      const relation = relations[0]?.relation
      if (relation === null) return 0
      if (relation !== 'squid_processor.hot_block') {
        throw new Error('Registry hot-block catalog relation is invalid')
      }

      const hotBlocks = await manager.query<Array<{ height: number }>>(
        `SELECT height
           FROM squid_processor.hot_block
          ORDER BY height DESC`,
      )
      if (hotBlocks.length === 0) return 0

      const status = await manager.query<
        Array<{ id: number; height: number; nonce: number }>
      >(
        `SELECT id, height, nonce
           FROM squid_processor.status
          WHERE id = 0
          FOR UPDATE`,
      )
      if (
        status.length !== 1 ||
        !Number.isSafeInteger(status[0]?.height) ||
        status[0].height < -1 ||
        !Number.isSafeInteger(status[0]?.nonce)
      ) {
        throw new Error('Registry durable status row is missing or invalid')
      }

      // RPC ingestion leaves reversible unfinalized entity changes in hot_block.
      // Portal ingestion is final-only, so atomically restore the durable status
      // state before replaying those blocks from Portal.
      const hotBlockHeights = new Set<number>()
      for (const hotBlock of hotBlocks) {
        if (
          !Number.isSafeInteger(hotBlock.height) ||
          hotBlock.height <= status[0].height
        ) {
          throw new Error(
            'Registry hot-block height is invalid for the durable cursor',
          )
        }
        hotBlockHeights.add(hotBlock.height)
      }

      const hotChanges = await manager.query<
        Array<{ block_height: number; index: number; change: unknown }>
      >(
        `SELECT block_height, index, change
           FROM squid_processor.hot_change_log
          ORDER BY block_height DESC, index DESC`,
      )
      const hotChangeIndexes = new Map<number, number[]>()
      for (const hotChange of hotChanges) {
        if (
          !Number.isSafeInteger(hotChange.block_height) ||
          !hotBlockHeights.has(hotChange.block_height) ||
          !Number.isSafeInteger(hotChange.index) ||
          hotChange.index < 0
        ) {
          throw new Error('Registry hot-change position is invalid')
        }
        assertValidLegacyHotChange(hotChange.change)
        const blockIndexes = hotChangeIndexes.get(hotChange.block_height) ?? []
        blockIndexes.push(hotChange.index)
        hotChangeIndexes.set(hotChange.block_height, blockIndexes)
      }
      for (const blockIndexes of hotChangeIndexes.values()) {
        blockIndexes.sort((left, right) => left - right)
        if (blockIndexes.some((index, position) => index !== position)) {
          throw new Error('Registry hot-change indexes are not contiguous')
        }
      }

      for (const hotBlock of hotBlocks) {
        await rollbackBlock('squid_processor', manager, hotBlock.height)
      }
      await manager.query(
        `UPDATE squid_processor.status
            SET nonce = nonce + 1
          WHERE id = 0`,
      )
      const updatedStatus = await manager.query<Array<{ nonce: number }>>(
        `SELECT nonce
           FROM squid_processor.status
          WHERE id = 0`,
      )
      if (
        updatedStatus.length !== 1 ||
        updatedStatus[0]?.nonce !== status[0].nonce + 1
      ) {
        throw new Error('Registry durable status nonce was not incremented')
      }
      return hotBlocks.length
    })
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy()
  }
}

export const runProcessor = ({
  built,
  database,
  handler,
}: {
  readonly built: BuiltProcessor
  readonly database: TypeormDatabase
  readonly handler: ProcessorHandler
}): void => {
  if (built.kind === 'rpc') {
    built.processor.run(database, handler)
    return
  }

  const logger = createLogger('thatsrekt:registry-portal')
  const ingestion = createPortalIngestionEvents({
    family: 'registry',
    chain: built.chain.slug,
    writeEvent: (event) => logger.info(event, 'Portal ingestion event'),
  })
  built.portal?.bindRetryObserver({
    onRetry: ({ retryAfterSeconds, retryCount }) => {
      ingestion.emitPortalRetry({ retryAfterSeconds, retryCount })
    },
    onDeadline: () => {
      ingestion.emitPortalDeadline()
    },
  })
  const durableProgressDataSource = new DataSource(createOrmConfig())
  const observedSource = createObservedPortalDataSource({
    source: built.dataSource,
    ingestion,
    isDeadlineError: (error) => error instanceof PortalRetryDeadlineError,
  })
  const freshnessSampler = createPortalFreshnessSampler({
    source: observedSource,
    ingestion,
  })
  const readDurableProgressAtMs = async ({
    height,
    hash,
  }: {
    readonly height: number
    readonly hash: string
  }): Promise<number | undefined> => {
    if (!durableProgressDataSource.isInitialized) {
      await durableProgressDataSource.initialize()
    }
    return readRegistryPortalDurableProgressAtMs({
      dataSource: durableProgressDataSource,
      cursor: { height, hash },
    })
  }
  const observedDatabase = createObservedFinalDatabase({
    database,
    ingestion,
    readDurableProgressAtMs: ({ state }) =>
      readDurableProgressAtMs({ height: state.height, hash: state.hash }),
    afterConnect: () => {
      freshnessSampler.start()
    },
    afterCommit: async ({ nextHead }) => {
      const durableProgressAtMs = await readDurableProgressAtMs({
        height: nextHead.height,
        hash: nextHead.hash,
      })
      if (durableProgressAtMs === undefined) {
        throw new Error('Registry durable cursor commit has no durable progress time')
      }
      ingestion.recordDurableCursor({
        height: nextHead.height,
        durableProgressAtMs,
      })
      ingestion.emitCursorAdvanced()
      ingestion.emitCursorClassification({ classification: 'advanced' })
      ingestion.emitFreshnessSample()
    },
  })

  const runPortalProcessor = async (): Promise<void> => {
    let exitCode = 0
    try {
      const reconciledHotBlocks = await reconcileLegacyHotBlocks()
      if (reconciledHotBlocks > 0) {
        logger.info(
          { reconciled_hot_blocks: reconciledHotBlocks },
          'Reconciled legacy Registry hot-block state',
        )
      }
      await new BatchProcessor(
        observedSource,
        observedDatabase,
        async (context) =>
          handler({
            log: logger,
            store: context.store,
            blocks: context.blocks.map(augmentBlock),
          }),
      ).run()
      ingestion.emitRunOutcome({ outcome: 'success' })
    } catch (error) {
      ingestion.emitFatal()
      ingestion.emitRunOutcome({ outcome: 'failed' })
      logger.fatal(asLogObject(error), 'Registry Portal ingestion failed')
      exitCode = 1
    } finally {
      freshnessSampler.stop()
      try {
        if (durableProgressDataSource.isInitialized) {
          await durableProgressDataSource.destroy()
        }
      } catch (error) {
        ingestion.emitFatal()
        ingestion.emitRunOutcome({ outcome: 'failed' })
        logger.error(asLogObject(error), 'Registry durable-progress database shutdown failed')
        exitCode = 1
      }
      try {
        await database.disconnect()
      } catch (error) {
        ingestion.emitFatal()
        ingestion.emitRunOutcome({ outcome: 'failed' })
        logger.error(asLogObject(error), 'Registry Portal database shutdown failed')
        exitCode = 1
      }
    }
    process.exit(exitCode)
  }

  void runPortalProcessor()
}
