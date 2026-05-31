/**
 * Donations indexer — processor entry point.
 *
 * Watches native-value transactions AND allowlisted ERC20 Transfer logs
 * whose recipient is the thatsrekt.eth donation Safe on the selected chain.
 * Writes rows to the `donation` table in `thatsrekt_donations` DB.
 *
 * Processor-only: no squid-graphql-server is started here.
 * The mesh reads directly via a second pg pool (DONATIONS_DB_URL).
 *
 * Chain selection: set CHAIN_SLUG env var to one of:
 *   ethereum | base | arbitrum | optimism | bsc | polygon
 * One process = one chain. Deploy one task per chain (slice #210).
 *
 * Slice #205: Ethereum + native ETH only.
 * Slice #207: ERC20 Transfer log subscriptions added.
 * Slice #209: Multi-chain parameterization. Per-chain cursor isolation.
 *             Base, Arbitrum, Optimism, BSC, Polygon added.
 */

import 'dotenv/config'
import { EvmBatchProcessor } from '@subsquid/evm-processor'
import type {
  HotDatabase,
  HotDatabaseState,
  HotTxInfo,
  FinalTxInfo,
  HashAndHeight,
} from '@subsquid/util-internal-processor-tools'
import pkg from 'pg'
import { ensureDonationTable, upsertDonation } from './donationStore.js'
import { mapNativeTransfer, mapErc20Transfer } from './donationMapper.js'
import { erc20Addresses, TRANSFER_TOPIC0 } from './tokenAllowlist.js'
import { chainConfigFor } from './chainConfig.js'

const { Pool } = pkg

// ---------------------------------------------------------------------------
// Env validation — fail fast before touching any infrastructure.
// ---------------------------------------------------------------------------

const requireEnv = (key: string): string => {
  const v = process.env[key]
  if (!v) throw new Error(`Missing required env var: ${key}`)
  return v
}

// ---------------------------------------------------------------------------
// Chain selection.
//
// CHAIN_SLUG selects the target chain from the registry in chainConfig.ts.
// All other chain-specific parameters (RPC URL, start block, finality depth)
// are derived from the config rather than hard-coded here.
// ---------------------------------------------------------------------------

const CHAIN_SLUG_INPUT = requireEnv('CHAIN_SLUG')
const chainConfig = chainConfigFor(CHAIN_SLUG_INPUT)
if (!chainConfig) {
  throw new Error(
    `Unsupported CHAIN_SLUG="${CHAIN_SLUG_INPUT}". ` +
      `Supported: ethereum, base, arbitrum, optimism, bsc, polygon`,
  )
}

const { chainId: CHAIN_ID, slug: CHAIN_SLUG, rpcEnvKey, startBlockEnvKey } = chainConfig

const RPC_URL = requireEnv(rpcEnvKey)
const DB_URL = requireEnv('DONATIONS_DB_URL')

// The thatsrekt.eth Safe — canonical donation address on every supported chain.
const DONATION_SAFE = '0x59E4DBc95BD312A882Bb36b7f3E8298682340679'.toLowerCase()

// Start block: override via per-chain env var (used in tests), else pinned default.
const START_BLOCK = parseInt(
  process.env[startBlockEnvKey] ?? String(chainConfig.defaultStartBlock),
  10,
)

// Finality confirmation: allow global override (e.g. FINALITY_CONFIRMATION=0 in tests).
const FINALITY_CONFIRMATION = parseInt(
  process.env.FINALITY_CONFIRMATION ?? String(chainConfig.finalityConfirmation),
  10,
)

// ---------------------------------------------------------------------------
// Postgres pool for donations DB.
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: DB_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err) => {
  console.error('[donations-indexer] idle client error:', err)
})

// ---------------------------------------------------------------------------
// Subsquid processor.
//
// Subscriptions:
//   - addTransaction({to:[Safe]}) — native value transfers to the Safe.
//   - addLog({address:[token], topic0:[Transfer], topic2:[Safe]}) per ERC20
//     — Transfer events directed to the Safe from each allowlisted token.
//     topic2 = recipient (second indexed arg of Transfer(from,to,amount)).
//
// The `topic2` filter is Subsquid's server-side filter: only logs where
// topics[2] matches the Safe address padded to 32 bytes are returned.
// We still verify `to` defensively in the handler.
//
// No gateway for local Anvil forks — falls back to RPC-only.
// ---------------------------------------------------------------------------

// Pad an address to a 32-byte topic (0x + 64 hex chars, address in lower 20 bytes).
const addressToTopic = (addr: string): string =>
  '0x' + addr.replace(/^0x/, '').toLowerCase().padStart(64, '0')

const DONATION_SAFE_TOPIC = addressToTopic(DONATION_SAFE)

// Retrieve all allowlisted ERC20 addresses for this chain.
const ERC20_ADDRESSES = erc20Addresses(CHAIN_ID)

let base = new EvmBatchProcessor()
  .setRpcEndpoint({
    url: RPC_URL,
    rateLimit: 10,
  })
  .setFinalityConfirmation(FINALITY_CONFIRMATION)
  .setFields({
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
  })
  .setBlockRange({ from: START_BLOCK })
  .addTransaction({
    to: [DONATION_SAFE],
  })

// Register one addLog subscription per allowlisted ERC20.
// Filter: Transfer topic0 + Safe as recipient (topic2).
for (const tokenAddr of ERC20_ADDRESSES) {
  base = base.addLog({
    address: [tokenAddr],
    topic0: [TRANSFER_TOPIC0],
    topic2: [DONATION_SAFE_TOPIC],
    transaction: true,
  })
}

// Subsquid Network archive — only for production chains, not local anvil forks.
// Set GATEWAY_URL to the chain-specific Subsquid Network gateway URL to enable.
// Omit it (or leave it empty) for RPC-only mode (used in tests and local setups).
const GATEWAY_URL = process.env.GATEWAY_URL
const processor = GATEWAY_URL ? base.setGateway(GATEWAY_URL) : base

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

const main = async () => {
  console.log(`[donations-indexer] starting for chain=${CHAIN_SLUG} (id=${CHAIN_ID})`)

  // Ensure schema before starting the processor loop.
  await ensureDonationTable(pool)
  console.log('[donations-indexer] donation table ensured')

  processor.run(
    buildHotDatabase(pool, CHAIN_ID),
    async (ctx) => {
      for (const block of ctx.blocks) {
        // Native value transfers.
        for (const tx of block.transactions) {
          if (!tx.to || tx.to.toLowerCase() !== DONATION_SAFE) continue
          if (!tx.value || tx.value === 0n) continue

          const row = mapNativeTransfer({
            chainId: CHAIN_ID,
            chainSlug: CHAIN_SLUG,
            fromAddress: tx.from,
            txHash: tx.hash,
            blockNumber: block.header.height,
            blockTimestampMs: block.header.timestamp,
            value: tx.value,
          })

          if (!row) {
            ctx.log.debug(`[donations-indexer] dropped tx ${tx.hash} (below floor or unknown chain)`)
            continue
          }

          await upsertDonation(pool, row)
          ctx.log.info(`[donations-indexer] indexed donation ${row.id} — ${row.amountNorm} ${row.tokenSymbol}`)
        }

        // ERC20 Transfer logs.
        for (const log of block.logs) {
          const topics = log.topics
          if (topics.length < 3) continue

          if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC0) continue

          const fromAddress = '0x' + (topics[1] ?? '').slice(-40)
          const toAddress = '0x' + (topics[2] ?? '').slice(-40)

          if (toAddress.toLowerCase() !== DONATION_SAFE) continue

          const amount = log.data && log.data !== '0x' ? BigInt(log.data) : 0n
          const txHash = log.transactionHash

          const row = mapErc20Transfer({
            chainId: CHAIN_ID,
            chainSlug: CHAIN_SLUG,
            tokenAddress: log.address,
            fromAddress,
            toAddress,
            amount,
            txHash,
            logIndex: log.logIndex,
            blockNumber: block.header.height,
            blockTimestampMs: block.header.timestamp,
          })

          if (!row) {
            ctx.log.debug(
              `[donations-indexer] dropped ERC20 log ${log.address}:${log.logIndex} (not allowlisted or zero)`,
            )
            continue
          }

          await upsertDonation(pool, row)
          ctx.log.info(
            `[donations-indexer] indexed ERC20 donation ${row.id} — ${row.amountNorm} ${row.tokenSymbol}`,
          )
        }
      }
    },
  )
}

// ---------------------------------------------------------------------------
// HotDatabase<void> implementation — per-chain cursor isolation.
//
// The status table `donations_indexer_status_v2` is keyed by `chain_id` so
// that multiple chain-processor instances writing to the same DB never clobber
// each other's cursor. Each instance only reads/writes its own row.
//
// Schema:
//   donations_indexer_status_v2 (
//     chain_id  INTEGER PRIMARY KEY,
//     height    INTEGER NOT NULL DEFAULT -1,
//     hash      TEXT    NOT NULL DEFAULT ''
//   )
//
// Migration from the original single-row table (donations_indexer_status with
// id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id=1)):
//   1. Create donations_indexer_status_v2 (idempotent).
//   2. Copy the old ETH cursor row (id=1 => chain_id=1) if old table exists.
//   3. Rename old table to donations_indexer_status_legacy (additive — no DROP).
//   4. Seed the row for this chain (idempotent).
// ---------------------------------------------------------------------------

function buildHotDatabase(pgPool: InstanceType<typeof Pool>, chainId: number): HotDatabase<void> {
  const ensureStatus = async (): Promise<void> => {
    // Step 1: create v2 table (idempotent).
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS donations_indexer_status_v2 (
        chain_id  INTEGER PRIMARY KEY,
        height    INTEGER NOT NULL DEFAULT -1,
        hash      TEXT    NOT NULL DEFAULT ''
      );
    `)

    // Step 2: migrate old single-row table if it still exists.
    const { rows: oldTable } = await pgPool.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'donations_indexer_status'
          AND table_schema = current_schema()
      ) AS exists;
    `)
    if (oldTable[0]?.exists) {
      // Copy ETH cursor (id=1 => chain_id=1). ON CONFLICT DO NOTHING is safe
      // if the v2 row already exists (idempotent re-run).
      await pgPool.query(`
        INSERT INTO donations_indexer_status_v2 (chain_id, height, hash)
        SELECT 1, height, hash
          FROM donations_indexer_status
         WHERE id = 1
        ON CONFLICT (chain_id) DO NOTHING;
      `)
      // Rename old table out of the way — additive migration, never DROP.
      await pgPool.query(`
        ALTER TABLE IF EXISTS donations_indexer_status
          RENAME TO donations_indexer_status_legacy;
      `)
    }

    // Step 3: seed this chain's cursor row (idempotent).
    await pgPool.query(
      `INSERT INTO donations_indexer_status_v2 (chain_id, height, hash)
       VALUES ($1, -1, '')
       ON CONFLICT (chain_id) DO NOTHING;`,
      [chainId],
    )
  }

  return {
    supportsHotBlocks: true,

    async connect(): Promise<HotDatabaseState> {
      await ensureStatus()
      const { rows } = await pgPool.query<{ height: number; hash: string }>(
        `SELECT height, hash FROM donations_indexer_status_v2 WHERE chain_id = $1`,
        [chainId],
      )
      const row = rows[0] ?? { height: -1, hash: '' }
      return { ...row, top: [] }
    },

    async transact(info: FinalTxInfo, cb: (store: void) => Promise<void>): Promise<void> {
      await cb(undefined as void)
      await pgPool.query(
        `UPDATE donations_indexer_status_v2 SET height = $1, hash = $2 WHERE chain_id = $3`,
        [info.nextHead.height, info.nextHead.hash, chainId],
      )
    },

    async transactHot(
      _info: HotTxInfo,
      _cb: (store: void, block: HashAndHeight) => Promise<void>,
    ): Promise<void> {
      // Hot blocks are not persisted. Only finalized donations are written.
    },
  }
}

main().catch((err) => {
  console.error('[donations-indexer] fatal:', err)
  process.exit(1)
})
