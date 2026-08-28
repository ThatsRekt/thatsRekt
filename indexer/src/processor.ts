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
    } catch {
      ingestion.emitFatal()
      ingestion.emitRunOutcome({ outcome: 'failed' })
      logger.fatal({}, 'Registry Portal ingestion failed')
      exitCode = 1
    } finally {
      freshnessSampler.stop()
      try {
        if (durableProgressDataSource.isInitialized) {
          await durableProgressDataSource.destroy()
        }
      } catch {
        ingestion.emitFatal()
        ingestion.emitRunOutcome({ outcome: 'failed' })
        logger.error({}, 'Registry durable-progress database shutdown failed')
        exitCode = 1
      }
      try {
        await database.disconnect()
      } catch {
        ingestion.emitFatal()
        ingestion.emitRunOutcome({ outcome: 'failed' })
        logger.error({}, 'Registry Portal database shutdown failed')
        exitCode = 1
      }
    }
    process.exit(exitCode)
  }

  void runPortalProcessor()
}
