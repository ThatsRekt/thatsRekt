import type {
  FinalDatabase,
  FinalDatabaseState,
  FinalTxInfo,
} from '@subsquid/batch-processor'
import type { Pool, PoolClient } from 'pg'

export interface DonationCursor {
  readonly height: number
  readonly hash: string
}

export type CursorCommitOutcome = 'advanced' | 'idempotent' | 'stale'

export interface DonationCursorCommit {
  readonly cursor: DonationCursor
  readonly classification: CursorCommitOutcome
  readonly durableProgressAtMs: number | undefined
}

export interface DonationDatabase extends FinalDatabase<PoolClient> {
  readonly durableProgressAtMs: number | undefined
  readonly lastCommittedCursor: DonationCursorCommit | undefined
}

export class CursorConsistencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CursorConsistencyError'
  }
}

const assertChainId = (chainId: number): void => {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new CursorConsistencyError('Donation cursor chain id must be a positive integer')
  }
}

const assertDurableProgressAtMs = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CursorConsistencyError(
      'Donation durable progress time must be a non-negative safe integer',
    )
  }
}

export const ensureDonationCursorTable = async (
  pool: Pool,
  chainId: number,
): Promise<void> => {
  assertChainId(chainId)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations_indexer_status_v2 (
      chain_id INTEGER PRIMARY KEY,
      height INTEGER NOT NULL DEFAULT -1,
      hash TEXT NOT NULL DEFAULT '',
      durable_progress_at_ms BIGINT
    );
    ALTER TABLE donations_indexer_status_v2
      ADD COLUMN IF NOT EXISTS durable_progress_at_ms BIGINT;
  `)

  const { rows: legacyTable } = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'donations_indexer_status'
        AND table_schema = current_schema()
    ) AS exists;
  `)
  if (legacyTable[0]?.exists) {
    await pool.query(`
      INSERT INTO donations_indexer_status_v2 (chain_id, height, hash)
      SELECT 1, height, hash
        FROM donations_indexer_status
       WHERE id = 1
      ON CONFLICT (chain_id) DO NOTHING;
    `)
    await pool.query(`
      ALTER TABLE IF EXISTS donations_indexer_status
        RENAME TO donations_indexer_status_legacy;
    `)
  }

  await pool.query(
    `INSERT INTO donations_indexer_status_v2 (chain_id, height, hash)
     VALUES ($1, -1, '')
     ON CONFLICT (chain_id) DO NOTHING;`,
    [chainId],
  )
}

interface StoredDonationCursor extends DonationCursor {
  readonly durableProgressAtMs: number | undefined
}

interface StoredDonationCursorRow {
  readonly height: number
  readonly hash: string
  readonly durable_progress_at_ms: string | null
}

const parseDurableProgressAtMs = (value: string | null): number | undefined => {
  if (value === null) return undefined
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CursorConsistencyError('Donation durable progress time is invalid')
  }
  const timestamp = Number(value)
  assertDurableProgressAtMs(timestamp)
  return timestamp
}

const readCursor = async (
  client: Pool | PoolClient,
  chainId: number,
): Promise<StoredDonationCursor | undefined> => {
  const { rows } = await client.query<StoredDonationCursorRow>(
    `SELECT height, hash, durable_progress_at_ms::text
       FROM donations_indexer_status_v2
      WHERE chain_id = $1`,
    [chainId],
  )
  const row = rows[0]
  return row === undefined
    ? undefined
    : Object.freeze({
      height: row.height,
      hash: row.hash,
      durableProgressAtMs: parseDurableProgressAtMs(row.durable_progress_at_ms),
    })
}

export const classifyZeroRowCursorUpdate = ({
  stored,
  next,
}: {
  readonly stored: DonationCursor | undefined
  readonly next: DonationCursor
}): Exclude<CursorCommitOutcome, 'advanced'> => {
  if (stored === undefined) {
    throw new CursorConsistencyError('Donation cursor row is missing')
  }
  if (stored.height > next.height) return 'stale'
  if (stored.height === next.height && stored.hash === next.hash) {
    return 'idempotent'
  }
  if (stored.height === next.height) {
    throw new CursorConsistencyError('Donation cursor hash conflicts at the same height')
  }
  throw new CursorConsistencyError('Donation cursor regressed after a conditional update')
}

const CONDITIONAL_CURSOR_UPDATE_SQL = `
UPDATE donations_indexer_status_v2
   SET height = $1,
       hash = $2,
       durable_progress_at_ms = CASE
         WHEN height < $1 THEN $4::bigint
         ELSE durable_progress_at_ms
       END
 WHERE chain_id = $3
   AND (height < $1 OR (height = $1 AND hash = $2))
RETURNING height, hash, durable_progress_at_ms::text
`

const toStoredDonationCursor = (row: StoredDonationCursorRow): StoredDonationCursor =>
  Object.freeze({
    height: row.height,
    hash: row.hash,
    durableProgressAtMs: parseDurableProgressAtMs(row.durable_progress_at_ms),
  })

const toDonationCursor = (cursor: DonationCursor): DonationCursor =>
  Object.freeze({ height: cursor.height, hash: cursor.hash })

const commitCursor = async ({
  client,
  chainId,
  next,
  now,
}: {
  readonly client: PoolClient
  readonly chainId: number
  readonly next: DonationCursor
  readonly now: () => number
}): Promise<DonationCursorCommit> => {
  const before = await readCursor(client, chainId)
  const nextProgressAtMs =
    before !== undefined && before.height < next.height
      ? now()
      : undefined
  if (nextProgressAtMs !== undefined) assertDurableProgressAtMs(nextProgressAtMs)
  const update = await client.query<StoredDonationCursorRow>(CONDITIONAL_CURSOR_UPDATE_SQL, [
    next.height,
    next.hash,
    chainId,
    nextProgressAtMs ?? null,
  ])
  const updated = update.rows[0]
  if (updated !== undefined) {
    const stored = toStoredDonationCursor(updated)
    return Object.freeze({
      cursor: toDonationCursor(stored),
      classification:
        before?.height === next.height && before.hash === next.hash
          ? 'idempotent'
          : 'advanced',
      durableProgressAtMs: stored.durableProgressAtMs,
    })
  }

  const stored = await readCursor(client, chainId)
  const classification = classifyZeroRowCursorUpdate({
    stored,
    next,
  })
  if (stored === undefined) {
    throw new CursorConsistencyError('Donation cursor row is missing')
  }
  return Object.freeze({
    cursor: toDonationCursor(stored),
    classification,
    durableProgressAtMs: stored.durableProgressAtMs,
  })
}

const rollbackAndRethrow = async ({
  client,
  error,
}: {
  readonly client: PoolClient
  readonly error: unknown
}): Promise<never> => {
  try {
    await client.query('ROLLBACK')
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      'Donation transaction and rollback both failed',
    )
  }
  throw error
}

export const createDonationDatabase = ({
  pool,
  chainId,
  now = Date.now,
}: {
  readonly pool: Pool
  readonly chainId: number
  readonly now?: () => number
}): DonationDatabase => {
  let durableProgressAtMs: number | undefined
  let lastCommittedCursor: DonationCursorCommit | undefined

  return {
    get durableProgressAtMs(): number | undefined {
      return durableProgressAtMs
    },
    get lastCommittedCursor(): DonationCursorCommit | undefined {
      return lastCommittedCursor
    },
    supportsHotBlocks: false,

    async connect(): Promise<FinalDatabaseState> {
      await ensureDonationCursorTable(pool, chainId)
      const cursor = await readCursor(pool, chainId)
      if (cursor === undefined) {
        throw new CursorConsistencyError('Donation cursor seed was not persisted')
      }
      durableProgressAtMs = cursor.durableProgressAtMs
      return toDonationCursor(cursor)
    },

    async transact(
      info: FinalTxInfo,
      callback: (store: PoolClient) => Promise<void>,
    ): Promise<void> {
      let committedCursor: DonationCursorCommit | undefined
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await callback(client)
        committedCursor = await commitCursor({
          client,
          chainId,
          next: info.nextHead,
          now,
        })
        await client.query('COMMIT')
      } catch (error) {
        await rollbackAndRethrow({ client, error })
      } finally {
        client.release()
      }
      if (committedCursor === undefined) {
        throw new CursorConsistencyError('Donation cursor commit completed without a cursor')
      }
      durableProgressAtMs = committedCursor.durableProgressAtMs
      lastCommittedCursor = committedCursor
    },
  }
}
