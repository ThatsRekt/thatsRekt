import 'dotenv/config'
import { Processor as BatchProcessor } from '@subsquid/batch-processor'
import { createLogger } from '@subsquid/logger'
import pkg from 'pg'
import { resolveToBlock } from './blockRange.js'
import { chainConfigFor } from './chainConfig.js'
import { createDonationDatabase } from './cursor.js'
import {
  createObservedFinalDatabase,
  createObservedPortalDataSource,
  createPortalIngestionEvents,
} from './ingestionEvents.js'
import { resolveCurrentDonee } from './doneeResolver.js'
import { ensureDonationTable } from './donationStore.js'
import {
  buildPortalConfig,
  DonationsPortalRetryDeadlineError,
} from './portal.js'
import { buildDonationPortalPlan, indexDonationBlocks } from './processor.js'
import { erc20Addresses } from './tokenAllowlist.js'

const { Pool } = pkg
const logger = createLogger('thatsrekt:donations-portal')

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

const parseNonNegativeInteger = ({
  value,
  variableName,
}: {
  readonly value: string
  readonly variableName: string
}): number => {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${variableName}: expected a non-negative integer`)
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${variableName}: integer is outside the safe range`)
  }
  return parsed
}

const addressToTopic = (address: string): string =>
  `0x${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`

const fetchHeadHeight = async (rpcUrl: string): Promise<number> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    }),
  })
  if (!response.ok) {
    throw new Error(`eth_blockNumber HTTP ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as {
    readonly result?: string
    readonly error?: { readonly message: string }
  }
  if (payload.error) throw new Error(`eth_blockNumber RPC error: ${payload.error.message}`)
  if (typeof payload.result !== 'string' || !/^0x[0-9a-f]+$/i.test(payload.result)) {
    throw new Error('eth_blockNumber: unexpected result')
  }

  const height = Number.parseInt(payload.result, 16)
  if (!Number.isSafeInteger(height)) {
    throw new Error('eth_blockNumber: height is outside the safe range')
  }
  return height
}

const main = async (): Promise<void> => {
  const selectedSlug = requireEnv('CHAIN_SLUG')
  const chain = chainConfigFor(selectedSlug)
  if (chain === null) {
    throw new Error(
      `Unsupported CHAIN_SLUG="${selectedSlug}". Supported: ethereum, base, arbitrum, optimism, bsc, polygon`,
    )
  }

  const ingestion = createPortalIngestionEvents({
    family: 'donations',
    chain: chain.slug,
    writeEvent: (event) => logger.info(event, 'Portal ingestion event'),
  })
  const rpcUrl = requireEnv(chain.headRpcEnvKey)
  const databaseUrl = requireEnv('DONATIONS_DB_URL')
  const portal = buildPortalConfig({
    dataset: chain.portalDataset,
    environment: process.env,
  })
  portal.bindRetryObserver({
    onRetry: ({ retryAfterSeconds, retryCount }) => {
      ingestion.emitPortalRetry({ retryAfterSeconds, retryCount })
    },
    onDeadline: () => {
      ingestion.emitPortalDeadline()
    },
  })
  const startBlock = parseNonNegativeInteger({
    value: process.env[chain.startBlockEnvKey] ?? String(chain.defaultStartBlock),
    variableName: chain.startBlockEnvKey,
  })
  const finalityConfirmation = parseNonNegativeInteger({
    value: process.env.FINALITY_CONFIRMATION ?? String(chain.finalityConfirmation),
    variableName: 'FINALITY_CONFIRMATION',
  })

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  pool.on('error', () => {
    ingestion.emitFatal()
    logger.error({}, 'Donations database idle client error')
  })

  try {
    const doneeSeed = '0x59E4DBc95BD312A882Bb36b7f3E8298682340679'
    const donee = (
      process.env.DONEE_OVERRIDE ??
      (await resolveCurrentDonee({
        rpcUrl: process.env.ENS_RPC_URL ?? '',
        fallback: doneeSeed,
      }))
    ).toLowerCase()
    const database = createDonationDatabase({ pool, chainId: chain.chainId })
    const observedDatabase = createObservedFinalDatabase({
      database,
      ingestion,
      readDurableProgressAtMs: () => database.durableProgressAtMs,
      afterCommit: () => {
        const committed = database.lastCommittedCursor
        if (committed === undefined) {
          throw new Error('Donation database committed without a cursor observation')
        }
        if (committed.classification === 'advanced') {
          if (committed.durableProgressAtMs === undefined) {
            throw new Error('Advanced donation cursor commit has no durable progress time')
          }
          ingestion.recordDurableCursor({
            height: committed.cursor.height,
            durableProgressAtMs: committed.durableProgressAtMs,
          })
          ingestion.emitCursorAdvanced()
          ingestion.emitFreshnessSample()
        }
        ingestion.emitCursorClassification({
          classification: committed.classification,
        })
      },
    })
    await observedDatabase.connect()

    // An idle run still samples a real Portal head; it never substitutes the
    // RPC planning head for the Portal source's own observation.
    const headProbe = buildDonationPortalPlan({
      portal,
      startBlock,
      toBlock: startBlock,
      donee,
      doneeTopic: addressToTopic(donee),
      erc20TokenAddresses: erc20Addresses(chain.chainId),
    })
    const observedHeadProbe = createObservedPortalDataSource({
      source: headProbe.source,
      ingestion,
      isDeadlineError: (error) =>
        error instanceof DonationsPortalRetryDeadlineError,
    })
    await observedHeadProbe.getFinalizedHead()
    ingestion.emitFreshnessSample()

    const head = await fetchHeadHeight(rpcUrl)
    const toBlock = resolveToBlock({
      startBlock,
      head,
      finalityConfirmation,
    })
    if (toBlock === undefined) {
      ingestion.emitRunOutcome({ outcome: 'idle' })
      return
    }

    const plan = buildDonationPortalPlan({
      portal,
      startBlock,
      toBlock,
      donee,
      doneeTopic: addressToTopic(donee),
      erc20TokenAddresses: erc20Addresses(chain.chainId),
    })
    const observedSource = createObservedPortalDataSource({
      source: plan.source,
      ingestion,
      isDeadlineError: (error) =>
        error instanceof DonationsPortalRetryDeadlineError,
    })

    await ensureDonationTable(pool)
    logger.info(
      {
        chain: chain.slug,
        chainId: chain.chainId,
        dataset: chain.portalDataset,
        from: plan.range.from,
        to: plan.range.to,
      },
      'Starting finalized Donations Portal ingestion',
    )

    await new BatchProcessor(
      observedSource,
      observedDatabase,
      async (context) =>
        indexDonationBlocks({
          blocks: context.blocks,
          store: context.store,
          chainId: chain.chainId,
          chainSlug: chain.slug,
          donee,
        }),
    ).run()
    ingestion.emitRunOutcome({ outcome: 'success' })
  } catch {
    ingestion.emitFatal()
    ingestion.emitRunOutcome({ outcome: 'failed' })
    logger.fatal({}, 'Donations Portal ingestion failed')
    process.exitCode = 1
  } finally {
    try {
      await pool.end()
    } catch {
      ingestion.emitFatal()
      ingestion.emitRunOutcome({ outcome: 'failed' })
      logger.error({}, 'Donations database shutdown failed')
      process.exitCode = 1
    }
  }
}

void main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(() => {
    logger.fatal({}, 'Donations Portal ingestion failed before initialization')
    process.exit(1)
  })
