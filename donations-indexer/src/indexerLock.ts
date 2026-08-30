import type { Pool, PoolClient } from 'pg'

const INDEXER_LOCK_NAMESPACE = 'thatsrekt-donations-indexer'

type LockLossHandler = (error: Error) => void

export interface IndexerLock {
  /** Invoked when PostgreSQL disconnects the session that owns this lock. */
  onLost(handler: LockLossHandler): void
  release(): Promise<void>
}

export const acquireIndexerLock = async (
  pool: Pool,
  chainId: number,
): Promise<IndexerLock | null> => {
  const client = await pool.connect()

  try {
    const acquisition = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1), $2) AS acquired',
      [INDEXER_LOCK_NAMESPACE, chainId],
    )
    if (acquisition.rows[0]?.acquired !== true) {
      client.release()
      return null
    }
  } catch (error) {
    client.release()
    throw error
  }

  return createIndexerLock(client, chainId)
}

const createIndexerLock = (client: PoolClient, chainId: number): IndexerLock => {
  let releasePromise: Promise<void> | undefined
  let lostError: Error | undefined
  let lostHandler: LockLossHandler | undefined
  let released = false

  const handleClientError = (error: Error): void => {
    lostError = error
    if (!released) lostHandler?.(error)
  }
  client.once('error', handleClientError)

  return {
    onLost(handler: LockLossHandler): void {
      lostHandler = handler
      if (!released && lostError !== undefined) handler(lostError)
    },
    release(): Promise<void> {
      releasePromise ??= (async (): Promise<void> => {
        released = true
        client.removeListener('error', handleClientError)
        try {
          const unlock = await client.query<{ released: boolean }>(
            'SELECT pg_advisory_unlock(hashtext($1), $2) AS released',
            [INDEXER_LOCK_NAMESPACE, chainId],
          )
          if (unlock.rows[0]?.released !== true) {
            throw new Error(`Indexer advisory lock was not held for chain ${chainId}`)
          }
        } finally {
          client.release()
        }
      })()
      return releasePromise
    },
  }
}
