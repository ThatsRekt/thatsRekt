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
}

export interface DonationDatabase extends FinalDatabase<PoolClient> {
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

export const ensureDonationCursorTable = async (
  pool: Pool,
  chainId: number,
): Promise<void> => {
  assertChainId(chainId)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations_indexer_status_v2 (
      chain_id INTEGER PRIMARY KEY,
      height INTEGER NOT NULL DEFAULT -1,
      hash TEXT NOT NULL DEFAULT ''
    );
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

const readCursor = async (
  client: Pool | PoolClient,
  chainId: number,
): Promise<DonationCursor | undefined> => {
  const { rows } = await client.query<DonationCursor>(
    `SELECT height, hash FROM donations_indexer_status_v2 WHERE chain_id = $1`,
    [chainId],
  )
  return rows[0]
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
UPDATE donations_indexer_status_v2 SET height=$1, hash=$2
WHERE chain_id=$3
  AND (height < $1 OR (height = $1 AND hash = $2))
`

const commitCursor = async ({
  client,
  chainId,
  next,
}: {
  readonly client: PoolClient
  readonly chainId: number
  readonly next: DonationCursor
}): Promise<DonationCursorCommit> => {
  const before = await readCursor(client, chainId)
  const update = await client.query(CONDITIONAL_CURSOR_UPDATE_SQL, [
    next.height,
    next.hash,
    chainId,
  ])
  if (update.rowCount === 1) {
    return Object.freeze({
      cursor: Object.freeze({ ...next }),
      classification:
        before?.height === next.height && before.hash === next.hash
          ? 'idempotent'
          : 'advanced',
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
    cursor: Object.freeze({ ...stored }),
    classification,
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
}: {
  readonly pool: Pool
  readonly chainId: number
}): DonationDatabase => {
  let lastCommittedCursor: DonationCursorCommit | undefined

  return {
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
      return cursor
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
        })
        await client.query('COMMIT')
      } catch (error) {
        await rollbackAndRethrow({ client, error })
      } finally {
        client.release()
      }
      lastCommittedCursor = committedCursor
    },
  }
}
