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

/**
 * Configured to index a single chain in v0.1. Multi-chain comes later (Phase 6
 * of the plan) — at that point each chain will have its own processor instance
 * or a shared one with chainId-aware data sources.
 *
 * Required env vars (see .env.example):
 *   - RPC_SEPOLIA_HTTP    — chain RPC endpoint
 *   - CONTRACT_ADDRESS    — the proxy address (canonical, identical across chains)
 *   - START_BLOCK         — first block to index (typically deploy block)
 */
const requireEnv = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

const contractAddress = requireEnv('CONTRACT_ADDRESS').toLowerCase()
const startBlock = parseInt(requireEnv('START_BLOCK'), 10)
if (Number.isNaN(startBlock) || startBlock < 0) {
  throw new Error(`Invalid START_BLOCK: ${process.env.START_BLOCK}`)
}

export const CONTRACT_ADDRESS = contractAddress

export const processor = new EvmBatchProcessor()
  // Subsquid Network gateway for fast historical sync. Sepolia network endpoint.
  // Override with another chain's gateway when deploying to other networks.
  .setGateway('https://v2.archive.subsquid.io/network/ethereum-sepolia')
  .setRpcEndpoint({
    url: requireEnv('RPC_SEPOLIA_HTTP'),
    rateLimit: 10,
  })
  .setFinalityConfirmation(75)
  .setFields({
    log: {
      topics: true,
      data: true,
      transactionHash: true,
    },
  })
  .setBlockRange({ from: startBlock })
  .addLog({
    address: [contractAddress],
    topic0: [
      events.PostCreated.topic,
      events.PostRemoved.topic,
      events.PostNoteAmended.topic,
      events.AttackersAdded.topic,
      events.VictimsAdded.topic,
      events.Voted.topic,
      events.WhitelistUpdated.topic,
      events.Upgraded.topic,
      events.OwnershipTransferred.topic,
    ],
    transaction: false,
  })

export type Fields = EvmBatchProcessorFields<typeof processor>
export type BlockHeader = _BlockHeader<Fields>
export type Log = _Log<Fields>
export type ProcessorContext = _DataHandlerContext<Store, Fields>
