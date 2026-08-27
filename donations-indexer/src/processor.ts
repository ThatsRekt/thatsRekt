import {
  DataSourceBuilder,
  type EVMDataSource,
  type FieldSelection,
} from '@subsquid/evm-stream'
import type { PoolClient } from 'pg'
import { upsertDonation } from './donationStore.js'
import { mapErc20Transfer, mapNativeTransfer } from './donationMapper.js'
import type { PortalConfig } from './portal.js'
import { TRANSFER_TOPIC0 } from './tokenAllowlist.js'
const DONATION_FIELDS = {
  block: {
    timestamp: true,
  },
  transaction: {
    to: true,
    from: true,
    value: true,
    hash: true,
  },
  log: {
    address: true,
    topics: true,
    data: true,
    transactionHash: true,
  },
} as const satisfies FieldSelection

export interface TransferFilter {
  readonly address: string
  readonly topic0: string
  readonly topic2: string
}

export interface DonationPortalPlan {
  readonly historySource: 'portal'
  readonly range: {
    readonly from: number
    readonly to: number
  }
  readonly transactionRecipient: string
  readonly transferFilters: readonly TransferFilter[]
  readonly source: EVMDataSource<typeof DONATION_FIELDS>
}

export const buildDonationPortalPlan = ({
  portal,
  startBlock,
  toBlock,
  donee,
  doneeTopic,
  erc20TokenAddresses,
}: {
  readonly portal: PortalConfig
  readonly startBlock: number
  readonly toBlock: number
  readonly donee: string
  readonly doneeTopic: string
  readonly erc20TokenAddresses: readonly string[]
}): DonationPortalPlan => {
  if (!Number.isInteger(startBlock) || !Number.isInteger(toBlock)) {
    throw new Error('Portal block range must contain integer heights')
  }
  if (toBlock < startBlock) {
    throw new Error('Portal range end must not precede start')
  }

  const range = Object.freeze({ from: startBlock, to: toBlock })
  const transferFilters = Object.freeze(
    erc20TokenAddresses.map((address) =>
      Object.freeze({
        address,
        topic0: TRANSFER_TOPIC0,
        topic2: doneeTopic,
      }),
    ),
  )
  let builder = new DataSourceBuilder()
    .setPortal({ url: portal.url, http: portal.http })
    .setFields(DONATION_FIELDS)
    .setBlockRange(range)
    .includeAllBlocks(range)
    .addTransaction({ where: { to: [donee] } })

  for (const filter of transferFilters) {
    builder = builder.addLog({
      where: {
        address: [filter.address],
        topic0: [filter.topic0],
        topic2: [filter.topic2],
      },
    })
  }

  return Object.freeze({
    historySource: 'portal',
    range,
    transactionRecipient: donee,
    transferFilters,
    source: builder.build(),
  })
}

export interface DonationBlock {
  readonly header: {
    readonly height: number
    readonly timestamp: number
  }
  readonly transactions: readonly {
    readonly to?: string
    readonly from: string
    readonly hash: string
    readonly value?: bigint
  }[]
  readonly logs: readonly {
    readonly address: string
    readonly topics: readonly string[]
    readonly data: string
    readonly transactionHash: string
    readonly logIndex: number
  }[]
}

export const indexDonationBlocks = async ({
  blocks,
  store,
  chainId,
  chainSlug,
  donee,
}: {
  readonly blocks: readonly DonationBlock[]
  readonly store: PoolClient
  readonly chainId: number
  readonly chainSlug: string
  readonly donee: string
}): Promise<void> => {
  for (const block of blocks) {
    for (const transaction of block.transactions) {
      if (!transaction.to || transaction.to.toLowerCase() !== donee) continue
      if (!transaction.value || transaction.value === 0n) continue

      const row = mapNativeTransfer({
        chainId,
        chainSlug,
        fromAddress: transaction.from,
        txHash: transaction.hash,
        blockNumber: block.header.height,
        blockTimestampMs: block.header.timestamp,
        value: transaction.value,
      })
      if (row !== null) await upsertDonation(store, row)
    }

    for (const log of block.logs) {
      if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0) {
        continue
      }
      const toAddress = `0x${(log.topics[2] ?? '').slice(-40)}`
      if (toAddress.toLowerCase() !== donee) continue

      const amount = log.data && log.data !== '0x' ? BigInt(log.data) : 0n
      const row = mapErc20Transfer({
        chainId,
        chainSlug,
        tokenAddress: log.address,
        fromAddress: `0x${(log.topics[1] ?? '').slice(-40)}`,
        toAddress,
        amount,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: block.header.height,
        blockTimestampMs: block.header.timestamp,
      })
      if (row !== null) await upsertDonation(store, row)
    }
  }
}
