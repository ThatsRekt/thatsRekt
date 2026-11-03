/**
 * Donation store — idempotent upsert of DonationRow into the
 * `donation` table in the `thatsrekt_donations` database.
 *
 * Schema bootstrap:
 *   `ensureDonationTable()` runs idempotent CREATE TABLE / CREATE INDEX
 *   statements on every processor start. Safe to re-run on redeploy.
 *
 * Upsert key: `id` (deterministic `${chainId}-${txHash}-native`).
 * ON CONFLICT never duplicates a row; it only backfills a missing tx_from_address.
 * This is the processor's primary idempotency guarantee.
 */

import type { ClientBase, Pool as PoolType } from 'pg'
import type { DonationRow } from './donationMapper.js'
type DonationQueryExecutor = Pick<ClientBase, 'query'>

/**
 * Idempotent schema bootstrap.
 *
 * donation table columns:
 *   id              — deterministic PK: "${chainId}-${txHash}-${logIndex|'native'}"
 *   chain_id        — EIP-155 chain id
 *   chain_slug      — human-readable slug (e.g. 'ethereum')
 *   from_address    — donor address (lowercased)
 *   tx_from_address — transaction signer (lowercased); null for rows indexed
 *                     before it was recorded
 *   token_address   — null for native coin, ERC20 address otherwise
 *   token_symbol    — 'ETH', 'USDC', etc.
 *   token_decimals  — 18 for ETH
 *   amount_raw      — base-unit amount as text (NUMERIC for safety)
 *   amount_norm     — human-readable decimal string (e.g. '0.05')
 *   tx_hash         — transaction hash
 *   log_index       — null for native, integer for ERC20 Transfer log
 *   block_number    — block height
 *   block_timestamp — UTC timestamp of the block
 *
 * Indexes:
 *   - block_timestamp DESC (default sort for the donations query)
 *   - amount_norm DESC (future sort-by-amount)
 *   - chain_id (future chain filter)
 *   - token_symbol (future token filter)
 *   - from_address (future donor filter)
 */
export async function ensureDonationTable(pool: PoolType): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS donation (
      id              VARCHAR(128) PRIMARY KEY,
      chain_id        INTEGER      NOT NULL,
      chain_slug      VARCHAR(32)  NOT NULL,
      from_address    VARCHAR(42)  NOT NULL,
      tx_from_address VARCHAR(42),
      token_address   VARCHAR(42),
      token_symbol    VARCHAR(32)  NOT NULL,
      token_decimals  INTEGER      NOT NULL,
      amount_raw      NUMERIC      NOT NULL,
      amount_norm     NUMERIC      NOT NULL,
      tx_hash         VARCHAR(66)  NOT NULL,
      log_index       INTEGER,
      block_number    INTEGER      NOT NULL,
      block_timestamp TIMESTAMPTZ  NOT NULL
    );
  `)
  // Tables created before the signer column existed.
  await pool.query(
    `ALTER TABLE donation ADD COLUMN IF NOT EXISTS tx_from_address VARCHAR(42);`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS donation_timestamp_idx
       ON donation(block_timestamp DESC);`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS donation_amount_idx
       ON donation(amount_norm DESC);`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS donation_chain_idx
       ON donation(chain_id);`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS donation_token_idx
       ON donation(token_symbol);`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS donation_donor_idx
       ON donation(from_address);`,
  )
}

/**
 * Idempotent upsert of a DonationRow.
 * Re-runs never duplicate or alter a stored donation; they only fill a
 * missing tx_from_address so a rewound backfill attributes older rows.
 */
export async function upsertDonation(
  executor: DonationQueryExecutor,
  row: DonationRow,
): Promise<void> {
  await executor.query(
    `INSERT INTO donation (
       id, chain_id, chain_slug, from_address, tx_from_address,
       token_address, token_symbol, token_decimals,
       amount_raw, amount_norm, tx_hash, log_index,
       block_number, block_timestamp
     ) VALUES (
       $1, $2, $3, $4, $14,
       $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13
     )
     ON CONFLICT (id) DO UPDATE
       SET tx_from_address = COALESCE(donation.tx_from_address, EXCLUDED.tx_from_address)`,
    [
      row.id,
      row.chainId,
      row.chainSlug,
      row.fromAddress,
      row.tokenAddress,
      row.tokenSymbol,
      row.tokenDecimals,
      row.amountRaw,
      row.amountNorm,
      row.txHash,
      row.logIndex,
      row.blockNumber,
      row.blockTimestamp.toISOString(),
      row.txFromAddress,
    ],
  )
}
