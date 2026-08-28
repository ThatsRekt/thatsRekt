import type { DataSource } from 'typeorm'

export interface RegistryPortalCursor {
  readonly height: number
  readonly hash: string
}

const assertCursor = ({ height, hash }: RegistryPortalCursor): void => {
  if (!Number.isSafeInteger(height) || height < -1) {
    throw new Error('Registry durable cursor height must be a safe integer at or above -1')
  }
  if (hash === '') throw new Error('Registry durable cursor hash must not be blank')
}

const parseDurableProgressAtMs = (value: unknown): number => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Registry durable progress time is invalid')
  }
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Registry durable progress time must be a non-negative safe integer')
  }
  return timestamp
}

export const readRegistryPortalDurableProgressAtMs = async ({
  dataSource,
  cursor,
}: {
  readonly dataSource: DataSource
  readonly cursor: RegistryPortalCursor
}): Promise<number | undefined> => {
  assertCursor(cursor)
  const rows: unknown = await dataSource.query(
    `SELECT durable_progress_at_ms::text AS durable_progress_at_ms
       FROM squid_processor.portal_ingestion_progress
      WHERE id = 0
        AND cursor_height = $1
        AND cursor_hash = $2`,
    [cursor.height, cursor.hash],
  )
  if (!Array.isArray(rows)) {
    throw new Error('Registry durable progress query returned an invalid result')
  }
  const row = rows[0]
  if (row === undefined) return undefined
  if (
    typeof row !== 'object' ||
    row === null ||
    Array.isArray(row) ||
    !('durable_progress_at_ms' in row)
  ) {
    throw new Error('Registry durable progress row is invalid')
  }
  const value = row.durable_progress_at_ms
  return value === null ? undefined : parseDurableProgressAtMs(value)
}
