/**
 * Donations resolver for the mesh gateway.
 *
 * Direct-SQL against thatsrekt_donations (second pg pool).
 * Mirrors the comments.ts + db.ts pattern exactly.
 *
 * Walking skeleton (slice #205): default newest-first only.
 * No orderBy/direction args yet — those land in slice #208.
 * Structure already accommodates them (orderByClause is defined and
 * whitelisted) so #208 is a non-breaking additive change.
 *
 * GraphQL query exposed:
 *   donations(limit: Int, offset: Int): [Donation!]!
 *
 * Returns rows newest first (block_timestamp DESC).
 */

import { donationsPool } from './donationsDb.js'

// ---------------------------------------------------------------------------
// Public GraphQL shape
// ---------------------------------------------------------------------------

export interface DonationRow {
  id: string
  chainId: number
  chainSlug: string
  fromAddress: string
  /** null for native-coin donations. */
  tokenAddress: string | null
  tokenSymbol: string
  tokenDecimals: number
  /** Base-unit amount as decimal string. */
  amountRaw: string
  /** Human-readable decimal amount string. */
  amountNorm: string
  txHash: string
  /** null for native-coin donations. */
  logIndex: number | null
  blockNumber: number
  /** ISO8601 timestamp string. */
  blockTimestamp: string
}

// ---------------------------------------------------------------------------
// DB row shape (pg driver column names)
// ---------------------------------------------------------------------------

interface DbRow {
  id: string
  chain_id: number
  chain_slug: string
  from_address: string
  token_address: string | null
  token_symbol: string
  token_decimals: number
  amount_raw: string
  amount_norm: string
  tx_hash: string
  log_index: number | null
  block_number: number
  block_timestamp: Date
}

const rowToDonation = (row: DbRow): DonationRow => ({
  id: row.id,
  chainId: row.chain_id,
  chainSlug: row.chain_slug,
  fromAddress: row.from_address,
  tokenAddress: row.token_address,
  tokenSymbol: row.token_symbol,
  tokenDecimals: row.token_decimals,
  amountRaw: row.amount_raw,
  amountNorm: row.amount_norm,
  txHash: row.tx_hash,
  logIndex: row.log_index,
  blockNumber: row.block_number,
  blockTimestamp: row.block_timestamp.toISOString(),
})

// ---------------------------------------------------------------------------
// Pure helper: orderByClause
//
// Maps a whitelisted column name + direction to a safe SQL ORDER BY
// fragment. Non-whitelisted inputs are rejected (injection guard).
// Slice #208 will wire orderBy/direction args from the GraphQL layer;
// for now only the default is called.
// ---------------------------------------------------------------------------

const ALLOWED_ORDER_COLUMNS = Object.freeze({
  date: 'block_timestamp',
  amount: 'amount_norm',
  chain: 'chain_slug',
  token: 'token_symbol',
  donor: 'from_address',
} as const)

type OrderColumn = keyof typeof ALLOWED_ORDER_COLUMNS
type Direction = 'ASC' | 'DESC'

/**
 * Build a safe ORDER BY fragment from whitelisted column + direction.
 * Throws on unknown column (injection guard) — callers must pass validated input.
 */
export const orderByClause = (column: string, direction: string): string => {
  const col = (ALLOWED_ORDER_COLUMNS as Record<string, string>)[column]
  if (!col) throw new Error(`Unknown orderBy column: ${column}`)
  const dir: Direction = direction.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  return `${col} ${dir}`
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * List donations, newest first (block_timestamp DESC).
 * Slice #208 will add orderBy/direction params.
 */
export const listDonations = async (opts: {
  limit: number
  offset: number
}): Promise<DonationRow[]> => {
  const safeLimit = Math.max(1, Math.min(200, opts.limit))
  const safeOffset = Math.max(0, opts.offset)
  const order = orderByClause('date', 'DESC')
  try {
    const { rows } = await donationsPool.query<DbRow>(
      `SELECT id, chain_id, chain_slug, from_address,
              token_address, token_symbol, token_decimals,
              amount_raw::text AS amount_raw,
              amount_norm::text AS amount_norm,
              tx_hash, log_index, block_number, block_timestamp
         FROM donation
         ORDER BY ${order}
         LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset],
    )
    return rows.map(rowToDonation)
  } catch (err: unknown) {
    // The `donation` table is created by the processor on first start.
    // If mesh boots before the processor has ever run, degrade gracefully
    // to an empty list rather than crashing the whole gateway.
    const pgErr = err as { code?: string }
    if (pgErr.code === '42P01') {
      // 42P01 = undefined_table — processor hasn't run yet.
      return []
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// GraphQL bindings
// ---------------------------------------------------------------------------

export const donationsTypeDefs = /* GraphQL */ `
  type Donation {
    id: ID!
    chainId: Int!
    chainSlug: String!
    fromAddress: String!
    """null for native-coin donations."""
    tokenAddress: String
    tokenSymbol: String!
    tokenDecimals: Int!
    """Base-unit amount as decimal string."""
    amountRaw: String!
    """Human-readable nominal amount (e.g. '0.5' for 0.5 ETH)."""
    amountNorm: String!
    txHash: String!
    """null for native-coin donations."""
    logIndex: Int
    blockNumber: Int!
    """ISO8601 UTC timestamp of the donation block."""
    blockTimestamp: String!
  }

  extend type Query {
    """
    List donations to thatsrekt.eth, newest first.
    limit/offset for pagination. Default limit 50.
    """
    donations(limit: Int = 50, offset: Int = 0): [Donation!]!
  }
`

export const buildDonationsResolvers = () => ({
  Query: {
    donations: (
      _root: unknown,
      args: { limit?: number; offset?: number },
    ) => listDonations({ limit: args.limit ?? 50, offset: args.offset ?? 0 }),
  },
})
