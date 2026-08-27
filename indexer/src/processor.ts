import 'dotenv/config'
import { run as runBatchProcessor } from '@subsquid/batch-processor'
import { augmentBlock } from '@subsquid/evm-objects'
import {
  DataSourceBuilder,
  type EVMDataSource,
  type FieldSelection,
} from '@subsquid/evm-stream'
import { createLogger, type Logger } from '@subsquid/logger'
import { EvmBatchProcessor } from '@subsquid/evm-processor'
import { type Store, type TypeormDatabase } from '@subsquid/typeorm-store'
import { events } from './abi/ThatsRekt'
import type { ChainConfig } from './chains'
import { buildPortalConfig, type PortalConfig } from './portal'

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
}: {
  readonly portal: PortalConfig
  readonly contractAddress: string
  readonly startBlock: number
}): EVMDataSource<typeof LOG_FIELDS> =>
  new DataSourceBuilder()
    .setPortal({
      url: portal.url,
      http: portal.http,
    })
    .setFields(LOG_FIELDS)
    .setBlockRange({ from: startBlock })
    .includeAllBlocks({ from: startBlock })
    .addLog({
      where: {
        address: [contractAddress],
        topic0: [...SUBSCRIBED_TOPICS],
      },
    })
    .build()

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
  runBatchProcessor(built.dataSource, database, async (context) =>
    handler({
      log: logger,
      store: context.store,
      blocks: context.blocks.map(augmentBlock),
    }),
  )
}
