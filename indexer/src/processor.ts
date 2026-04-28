import 'dotenv/config'
import {
  EvmBatchProcessor,
  EvmBatchProcessorFields,
  BlockHeader as _BlockHeader,
  Log as _Log,
  DataHandlerContext as _DataHandlerContext,
} from '@subsquid/evm-processor'
import { Store } from '@subsquid/typeorm-store'
import { events } from './abi/ThatsRekt'
import type { ChainConfig } from './chains'

/**
 * Build a Subsquid processor configured for a single chain.
 *
 * The chain registry (chains.ts) is the single source of truth for
 * chain-specific config; env vars (named in the registry entry) supply
 * the runtime values — RPC URL, contract address, start block.
 *
 * Adding a new chain: add an entry to chains.ts and supply matching env
 * vars. No changes here are required.
 */

const requireEnv = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

const SUBSCRIBED_TOPICS = [
  events.PostCreated.topic,
  events.PostRemoved.topic,
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
  log: {
    topics: true,
    data: true,
    transactionHash: true,
  },
} as const

// Probe used purely for type derivation. Every built processor has the same
// .setFields() shape (LOG_FIELDS above), so the Fields / Log / ProcessorContext
// types are identical across chains and can be derived from one canonical
// instance. Handlers import these and stay chain-agnostic.
const _typingProbe = new EvmBatchProcessor().setFields(LOG_FIELDS)

export type ConfiguredProcessor = typeof _typingProbe
export type Fields = EvmBatchProcessorFields<ConfiguredProcessor>
export type BlockHeader = _BlockHeader<Fields>
export type Log = _Log<Fields>
export type ProcessorContext = _DataHandlerContext<Store, Fields>

export interface BuiltProcessor {
  readonly chain: ChainConfig
  /** Lowercased proxy address — compare with `lc(log.address)` in handlers. */
  readonly contractAddress: string
  readonly processor: ConfiguredProcessor
}

export const buildProcessor = (chain: ChainConfig): BuiltProcessor => {
  const contractAddress = requireEnv(chain.contractEnvVar).toLowerCase()
  const startBlockRaw = requireEnv(chain.startBlockEnvVar)
  const startBlock = parseInt(startBlockRaw, 10)
  if (Number.isNaN(startBlock) || startBlock < 0) {
    throw new Error(
      `Invalid ${chain.startBlockEnvVar}: "${startBlockRaw}" (expected non-negative integer)`,
    )
  }

  const base = new EvmBatchProcessor()
    .setRpcEndpoint({
      url: requireEnv(chain.rpcEnvVar),
      rateLimit: chain.rpcRateLimit,
    })
    .setFinalityConfirmation(chain.finalityConfirmation)
    .setFields(LOG_FIELDS)
    .setBlockRange({ from: startBlock })
    .addLog({
      address: [contractAddress],
      topic0: [...SUBSCRIBED_TOPICS],
      transaction: false,
    })

  // Subsquid Network archive — present for real chains, null for local
  // Anvil (no archive exists). Without a gateway the processor falls back
  // to RPC-only sync, which is fine at local-fork volumes.
  const processor: ConfiguredProcessor =
    chain.gateway !== null ? base.setGateway(chain.gateway) : base

  return { chain, contractAddress, processor }
}
